import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Product } from './product.entity';
import { Category } from './category.entity';
import { CreateProductDto, CreateCategoryDto } from './dto/create-product.dto';

// Search results are cached per query, so there is no single key to delete when a
// product changes. Keyv exposes no wildcard delete, so eviction goes through a
// generation token embedded in every search key: replacing it orphans the whole
// generation at once, and the orphans age out on their own TTL.
const SEARCH_TTL_MS = 60000;
const SEARCH_VERSION_KEY = 'product-search:version';
// The token is random and never reused, which is the invariant the whole scheme
// rests on: no sequence of writes, races or expiries can re-enter a generation
// that still holds live entries. A counter cannot promise that — it can be rolled
// back by a stalled writer, or restart low and climb back onto live keys.
// The TTL only bounds how long an idle key lingers; losing it early is safe,
// because the replacement token is new and orphans the old generation for good.
const SEARCH_VERSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface CategoryRow {
  id: number;
  name: string;
  parent_id: number | null;
}

export interface CategoryTreeNode {
  id: number;
  name: string;
  children: CategoryTreeNode[];
}

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private productsRepository: Repository<Product>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
  ) {}

  async findAll(): Promise<Product[]> {
    return this.productsRepository.find({ relations: ['category'] });
  }

  async findOne(id: number): Promise<Product> {
    const product = await this.productsRepository.findOne({ 
      where: { id },
      relations: ['category'],
    });
    if (!product) {
      throw new NotFoundException(`Product #${id} not found`);
    }
    return product;
  }

  async create(createProductDto: CreateProductDto): Promise<Product> {
    const product = this.productsRepository.create(createProductDto);
    const saved = await this.productsRepository.save(product);
    await this.invalidateSearchCache();
    return saved;
  }

  /**
   * Applies a *relative* change to stock in a single conditional UPDATE.
   *
   * Returns false when the change would take stock negative, because the WHERE
   * clause then matches no row. Callers get insufficient stock as a return
   * value rather than as a race: there is no window between reading the level
   * and writing it, so two concurrent orders cannot both see the same stock.
   *
   * Runs on the supplied EntityManager so it can join a caller's transaction.
   * Does not touch the search cache — callers evict once their unit of work has
   * committed, so a concurrent search cannot re-cache the pre-commit level.
   */
  async adjustStock(
    productId: number,
    delta: number,
    manager: EntityManager = this.productsRepository.manager,
  ): Promise<boolean> {
    const result = await manager
      .createQueryBuilder()
      .update(Product)
      .set({ stock: () => 'stock + :delta' })
      .where('id = :id AND stock + :delta >= 0', { id: productId })
      .setParameter('delta', delta)
      .execute();

    return result.affected === 1;
  }

  async remove(id: number): Promise<void> {
    const product = await this.findOne(id);
    await this.productsRepository.remove(product);
    await this.invalidateSearchCache();
  }

  private async getSearchVersion(): Promise<string> {
    const version = await this.cacheManager.get<string>(SEARCH_VERSION_KEY);
    if (typeof version === 'string') {
      return version;
    }
    const fresh = randomUUID();
    await this.cacheManager.set(SEARCH_VERSION_KEY, fresh, SEARCH_VERSION_TTL_MS);
    return fresh;
  }

  // Unconditional write: no read half, so there is nothing to race and no way to
  // put back a token that was already in use.
  // Public because OrdersService evicts after its transaction commits, so a
  // concurrent search cannot re-cache the pre-commit stock level.
  async invalidateSearchCache(): Promise<void> {
    await this.cacheManager.set(
      SEARCH_VERSION_KEY,
      randomUUID(),
      SEARCH_VERSION_TTL_MS,
    );
  }

  async searchProducts(query: string): Promise<Product[]> {
    // Matching is case-insensitive, so the key is normalised the same way —
    // 'Laptop' and 'laptop' are one entry, not two.
    const normalized = query.trim().toLowerCase();
    const version = await this.getSearchVersion();
    const cacheKey = `product-search:v${version}:${normalized}`;

    const cached = await this.cacheManager.get<Product[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const products = await this.productsRepository.find();
    const results = products.filter(p =>
      p.name.toLowerCase().includes(normalized) ||
      (p.description || '').toLowerCase().includes(normalized)
    );

    await this.cacheManager.set(cacheKey, results, SEARCH_TTL_MS);
    return results;
  }

  async findAllCategories(): Promise<Category[]> {
    return this.categoriesRepository.find({ relations: ['parent', 'children'] });
  }

  async findCategory(id: number): Promise<Category> {
    const category = await this.categoriesRepository.findOne({
      where: { id },
      relations: ['parent', 'children', 'products'],
    });
    if (!category) {
      throw new NotFoundException(`Category #${id} not found`);
    }
    return category;
  }

  async createCategory(dto: CreateCategoryDto): Promise<Category> {
    const category = this.categoriesRepository.create(dto);
    return this.categoriesRepository.save(category);
  }

  async getCategoryTree(categoryId: number): Promise<CategoryTreeNode> {
    const root = await this.categoriesRepository.findOne({
      where: { id: categoryId },
    });
    if (!root) {
      throw new NotFoundException(`Category #${categoryId} not found`);
    }

    // The whole subtree in one query. findCategory loads relations exactly one
    // level deep, so walking `children` recursively silently stopped at
    // grandchildren — the crash was hiding an incompleteness bug, and a guard
    // on the null parent would have fixed the 500 while leaving the tree wrong.
    // The recursion carries the path it has walked and refuses to re-enter a
    // node already on it. Without that, a cycle in parent_id makes UNION ALL
    // loop forever: the request never returns and a Postgres backend spins
    // until it is cancelled. A cycle IS reachable here — `createCategory` does
    // not validate parentId, so one POST naming the id its own row is about to
    // receive creates a self-loop, and Postgres accepts it because the foreign
    // key is checked at statement end. This is a guard against a real input,
    // not an arbitrary depth bound.
    const rows: CategoryRow[] = await this.categoriesRepository.query(
      `WITH RECURSIVE subtree AS (
         SELECT id, name, parent_id, ARRAY[id] AS path
         FROM categories
         WHERE id = $1
         UNION ALL
         SELECT c.id, c.name, c.parent_id, s.path || c.id
         FROM categories c
         JOIN subtree s ON c.parent_id = s.id
         WHERE NOT c.id = ANY(s.path)
       )
       SELECT id, name, parent_id FROM subtree`,
      [categoryId],
    );

    return this.buildCategoryTree(categoryId, rows);
  }

  private buildCategoryTree(
    rootId: number,
    rows: CategoryRow[],
  ): CategoryTreeNode {
    // Visit each id once, and link each node to a parent only once, so a row
    // the CTE emits more than once cannot appear twice in the response.
    const nodes = new Map<number, CategoryTreeNode>();
    for (const row of rows) {
      if (!nodes.has(row.id)) {
        nodes.set(row.id, { id: row.id, name: row.name, children: [] });
      }
    }

    const linked = new Set<number>([rootId]);
    for (const row of rows) {
      if (linked.has(row.id)) {
        continue;
      }
      const parent =
        row.parent_id === null ? undefined : nodes.get(row.parent_id);
      const node = nodes.get(row.id);
      if (parent && node) {
        parent.children.push(node);
        linked.add(row.id);
      }
    }

    // `parent` is deliberately absent. buildCategoryTree used to recurse
    // upwards as well as down, which cannot terminate once relations are loaded
    // deeply enough for the tree to be complete: a parent's `children` contains
    // the node you started from. A category tree is its descendants.
    return nodes.get(rootId)!;
  }

  async processProductBatch(productIds: number[]): Promise<{ success: boolean; processed: number }> {
    let processed = 0;
    
    try {
      for (const id of productIds) {
        try {
          const product = await this.findOne(id);
          product.updatedAt = new Date();
          await this.productsRepository.save(product);
          await this.invalidateSearchCache();
          processed++;
        } catch (error) {
          console.log('Error processing product');
        }
      }
    } catch (error) {
      throw new BadRequestException('Batch processing failed');
    }

    return { success: true, processed };
  }
}
