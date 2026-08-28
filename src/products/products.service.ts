import {
  Injectable,
  NotFoundException,
  ConflictException,
  Inject,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, ILike, Repository } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Product } from './product.entity';
import { Category } from './category.entity';
import { CreateProductDto, CreateCategoryDto } from './dto/create-product.dto';
import {
  sqlState,
  FOREIGN_KEY_VIOLATION,
} from '../common/database-errors';

// Search results are cached per query, so there is no single key to delete when a
// product changes. Keyv exposes no wildcard delete, so eviction goes through a
// version number embedded in every search key: bumping it orphans the whole
// generation at once, and the orphans age out on their own TTL.
const SEARCH_TTL_MS = 60000;
const SEARCH_VERSION_KEY = 'product-search:version';
// A hard internal cap, not a pagination parameter: the route still returns a
// bare JSON array and callers see nothing new. Today's unbounded result set was
// never a promise anyone could rely on.
const SEARCH_RESULT_LIMIT = 100;
// Deliberately far longer than SEARCH_TTL_MS. If the version key ever does expire,
// reads fall back to version 1 — which is only safe because every entry written
// under a later version has already expired by then.
const SEARCH_VERSION_TTL_MS = 24 * 60 * 60 * 1000;

// Bounds the recursive subtree query. categories.parent_id has no cycle
// constraint, so an unbounded CTE is a hang waiting to happen.
const MAX_CATEGORY_TREE_DEPTH = 50;

export interface CategoryRow {
  id: number;
  name: string;
  parent_id: number | null;
}

/**
 * `%` and `_` are wildcards to LIKE but were literal characters to the previous
 * String.includes() filter. Escaping keeps a search for "50%" meaning "50%".
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export interface BatchFailure {
  id: number;
  reason: string;
}

export interface BatchResult {
  success: boolean;
  processed: number;
  failed: BatchFailure[];
}

export interface CategoryTreeNode {
  id: number;
  name: string;
  children: CategoryTreeNode[];
}

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

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

    let saved: Product;
    try {
      saved = await this.productsRepository.save(product);
    } catch (error) {
      // A categoryId that does not exist is the caller naming a missing
      // resource, so it is a 404 about the category rather than a 500 about a
      // constraint the caller has never heard of.
      if (sqlState(error) === FOREIGN_KEY_VIOLATION) {
        throw new NotFoundException(
          `Category #${createProductDto.categoryId} not found`,
        );
      }
      throw error;
    }

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

    try {
      await this.productsRepository.remove(product);
    } catch (error) {
      if (sqlState(error) === FOREIGN_KEY_VIOLATION) {
        throw new ConflictException(
          `Product #${id} cannot be deleted while it is referenced by existing orders`,
        );
      }
      throw error;
    }

    await this.invalidateSearchCache();
  }

  private async getSearchVersion(): Promise<number> {
    const version = await this.cacheManager.get<number>(SEARCH_VERSION_KEY);
    if (typeof version === 'number') {
      return version;
    }
    await this.cacheManager.set(SEARCH_VERSION_KEY, 1, SEARCH_VERSION_TTL_MS);
    return 1;
  }

  async invalidateSearchCache(): Promise<void> {
    const current = await this.getSearchVersion();
    await this.cacheManager.set(
      SEARCH_VERSION_KEY,
      current + 1,
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

    // The predicate runs in Postgres now. It used to SELECT every row and filter
    // in JavaScript, so the cost of a search was the size of the table rather
    // than the size of the answer, and every cache miss paid it in full.
    const pattern = `%${escapeLikePattern(normalized)}%`;
    const results = await this.productsRepository.find({
      where: [{ name: ILike(pattern) }, { description: ILike(pattern) }],
      take: SEARCH_RESULT_LIMIT,
    });

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

    try {
      return await this.categoriesRepository.save(category);
    } catch (error) {
      if (sqlState(error) === FOREIGN_KEY_VIOLATION) {
        throw new NotFoundException(`Category #${dto.parentId} not found`);
      }
      throw error;
    }
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
    //
    // The depth cap is not decoration: parent_id has no cycle constraint, and a
    // cycle would make this CTE recurse until the server gave out.
    const rows: CategoryRow[] = await this.categoriesRepository.query(
      `WITH RECURSIVE subtree AS (
         SELECT id, name, parent_id, 0 AS depth
         FROM categories
         WHERE id = $1
         UNION ALL
         SELECT c.id, c.name, c.parent_id, s.depth + 1
         FROM categories c
         JOIN subtree s ON c.parent_id = s.id
         WHERE s.depth < $2
       )
       SELECT id, name, parent_id FROM subtree`,
      [categoryId, MAX_CATEGORY_TREE_DEPTH],
    );

    return this.buildCategoryTree(categoryId, rows);
  }

  private buildCategoryTree(
    rootId: number,
    rows: CategoryRow[],
  ): CategoryTreeNode {
    // Visit each id once. Under a cycle the CTE can emit the same row at
    // several depths, and linking it more than once would rebuild the cycle in
    // the response.
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

  async processProductBatch(productIds: number[]): Promise<BatchResult> {
    let processed = 0;
    const failed: BatchFailure[] = [];

    // The outer try/catch that used to wrap this loop is gone. Its only real
    // effect was rewriting any cause into 'Batch processing failed', including
    // the TypeError raised when productIds was not an array. Removing it is
    // only safe because ProcessBatchDto now rejects that body at the boundary
    // with a message naming the field.
    for (const id of productIds) {
      try {
        const product = await this.findOne(id);
        product.updatedAt = new Date();
        await this.productsRepository.save(product);
        await this.invalidateSearchCache();
        processed++;
      } catch (error) {
        // Was `console.log('Error processing product')` — no id, no cause, and
        // then reported as success anyway.
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Batch item ${id} failed: ${reason}`);
        failed.push({ id, reason });
      }
    }

    return { success: failed.length === 0, processed, failed };
  }
}
