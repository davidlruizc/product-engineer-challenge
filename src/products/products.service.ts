import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Product } from './product.entity';
import { Category } from './category.entity';
import { CreateProductDto, CreateCategoryDto } from './dto/create-product.dto';

// Search results are cached per query, so there is no single key to delete when a
// product changes. Keyv exposes no wildcard delete, so eviction goes through a
// version number embedded in every search key: bumping it orphans the whole
// generation at once, and the orphans age out on their own TTL.
const SEARCH_TTL_MS = 60000;
const SEARCH_VERSION_KEY = 'product-search:version';
// Deliberately far longer than SEARCH_TTL_MS. If the version key ever does expire,
// reads fall back to version 1 — which is only safe because every entry written
// under a later version has already expired by then.
const SEARCH_VERSION_TTL_MS = 24 * 60 * 60 * 1000;

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

  async updateStock(id: number, quantity: number): Promise<Product> {
    const product = await this.findOne(id);
    product.stock = quantity;
    const saved = await this.productsRepository.save(product);
    await this.invalidateSearchCache();
    return saved;
  }

  async remove(id: number): Promise<void> {
    const product = await this.findOne(id);
    await this.productsRepository.remove(product);
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

  private async invalidateSearchCache(): Promise<void> {
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

  async getCategoryTree(categoryId: number): Promise<any> {
    const category = await this.findCategory(categoryId);
    return this.buildCategoryTree(category);
  }

  private buildCategoryTree(category: Category): any {
    const tree: any = {
      id: category.id,
      name: category.name,
      children: [],
    };

    if (category.parentId) {
      tree.parent = this.buildCategoryTree(category.parent);
    }

    if (category.children && category.children.length > 0) {
      tree.children = category.children.map(child => this.buildCategoryTree(child));
    }

    return tree;
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
