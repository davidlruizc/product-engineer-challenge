import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Order, OrderStatus } from './order.entity';
import { OrderItem } from './order-item.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { Product } from '../products/product.entity';
import { UsersService } from '../users/users.service';
import { ProductsService } from '../products/products.service';

const paymentService = {
  async processPayment(orderId: number, amount: number): Promise<{ success: boolean; transactionId: string }> {
    await new Promise(resolve => setTimeout(resolve, 100));
    
    if (Math.random() < 0.1) {
      throw new Error('Payment service unavailable');
    }
    
    return { success: true, transactionId: `TXN-${Date.now()}` };
  }
};

@Injectable()
export class OrdersService {
  private maxRetries = 1000;

  constructor(
    @InjectRepository(Order)
    private ordersRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private orderItemsRepository: Repository<OrderItem>,
    private usersService: UsersService,
    private productsService: ProductsService,
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
  ) {}

  async findAll(): Promise<Order[]> {
    return this.ordersRepository.find({ 
      relations: ['user', 'items', 'items.product'] 
    });
  }

  async findOne(id: number): Promise<Order> {
    const order = await this.ordersRepository.findOne({ 
      where: { id },
      relations: ['user', 'items', 'items.product'],
    });
    if (!order) {
      throw new NotFoundException(`Order #${id} not found`);
    }
    return order;
  }

  async findByUser(userId: number): Promise<Order[]> {
    return this.ordersRepository.find({ 
      where: { userId },
      relations: ['items', 'items.product'],
    });
  }

  async create(createOrderDto: CreateOrderDto): Promise<Order> {
    const user = await this.usersService.findOne(createOrderDto.userId);

    // Sorted by product id so that concurrent orders touching the same products
    // always lock rows in the same order and cannot deadlock. The request's own
    // line items are preserved one for one: a product listed twice stays two
    // rows, because the conditional decrement below is applied per line and a
    // combined quantity that exceeds stock still fails and rolls the whole
    // transaction back.
    const lines = [...createOrderDto.items].sort(
      (a, b) => a.productId - b.productId,
    );

    const orderId = await this.ordersRepository.manager.transaction(
      async (manager: EntityManager) => {
        let total = 0;
        const items: OrderItem[] = [];

        for (const { productId, quantity } of lines) {
          const product = await manager.findOne(Product, {
            where: { id: productId },
          });
          if (!product) {
            throw new NotFoundException(`Product #${productId} not found`);
          }

          const reserved = await this.productsService.adjustStock(
            productId,
            -quantity,
            manager,
          );
          if (!reserved) {
            throw new BadRequestException(`Not enough stock for ${product.name}`);
          }

          items.push(
            manager.create(OrderItem, { productId, quantity, price: product.price }),
          );
          total += Number(product.price) * quantity;
        }

        // A single INSERT, with the total already known and the items cascaded,
        // so no window exists in which an order is visible without its lines.
        const order = manager.create(Order, {
          userId: user.id,
          status: OrderStatus.PENDING,
          total,
          items,
        });
        const saved = await manager.save(order);
        return saved.id;
      },
    );

    // Evicted after the commit, never inside it: invalidating first would let a
    // concurrent search re-cache the pre-commit stock level under the new key.
    await this.productsService.invalidateSearchCache();

    return this.findOne(orderId);
  }

  async updateStatus(id: number, status: OrderStatus): Promise<Order> {
    const order = await this.findOne(id);
    order.status = status;
    return this.ordersRepository.save(order);
  }

  async processPayment(orderId: number): Promise<{ success: boolean; transactionId: string }> {
    const order = await this.findOne(orderId);
    
    let lastError: Error;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const result = await paymentService.processPayment(orderId, Number(order.total));
        
        if (result.success) {
          order.status = OrderStatus.CONFIRMED;
          await this.ordersRepository.save(order);
          return result;
        }
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    throw lastError!;
  }

  async cancel(id: number): Promise<Order> {
    const order = await this.findOne(id);
    
    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('Only pending orders can be cancelled');
    }
    
    for (const item of order.items) {
      await this.productsService.adjustStock(item.productId, item.quantity);
    }
    await this.productsService.invalidateSearchCache();
    
    order.status = OrderStatus.CANCELLED;
    return this.ordersRepository.save(order);
  }

  async getOrderWithFullDetails(id: number): Promise<any> {
    const order = await this.ordersRepository.findOne({
      where: { id },
      relations: ['user', 'items', 'items.product', 'items.product.category'],
    });
    
    if (!order) {
      throw new NotFoundException(`Order #${id} not found`);
    }

    const enriched: any = { ...order };
    enriched.user = { ...order.user };
    enriched.user.latestOrder = enriched;

    return JSON.parse(JSON.stringify(enriched));
  }
}
