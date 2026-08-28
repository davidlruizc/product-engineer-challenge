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

  /**
   * Flips an order's status only if it is currently one of `from`, in a single
   * conditional UPDATE. Returns false when no row matched, which is how a
   * caller learns it lost a race rather than discovering it afterwards.
   *
   * Every state change goes through this instead of read-then-save, because the
   * gap between reading a status and writing it is exactly where a second
   * request slips in and repeats work that should happen once.
   */
  private async transitionStatus(
    id: number,
    from: OrderStatus[],
    to: OrderStatus,
    manager: EntityManager = this.ordersRepository.manager,
  ): Promise<boolean> {
    const result = await manager
      .createQueryBuilder()
      .update(Order)
      .set({ status: to })
      .where('id = :id AND status IN (:...from)', { id, from })
      .execute();

    return result.affected === 1;
  }

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

    // Merge duplicate line items before anything checks stock. Three lines of 4
    // units against stock 10 each pass on their own and oversell by 2, so
    // per-line validation is not enough: the check has to see the true total
    // quantity per product. Sorted by id so that concurrent orders touching the
    // same products always lock rows in the same order and cannot deadlock.
    const quantities = new Map<number, number>();
    for (const item of createOrderDto.items) {
      const previous = quantities.get(item.productId) ?? 0;
      quantities.set(item.productId, previous + item.quantity);
    }
    const lines = [...quantities.entries()].sort(([a], [b]) => a - b);

    const orderId = await this.ordersRepository.manager.transaction(
      async (manager: EntityManager) => {
        let total = 0;
        const items: OrderItem[] = [];

        for (const [productId, quantity] of lines) {
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

    // Claim the order BEFORE calling the provider. Confirming afterwards would
    // let two concurrent pays both pass the check and both charge; claiming
    // first means the loser matches no row and is turned away having charged
    // nothing. It is also what stops a cancelled order being resurrected.
    const claimed = await this.transitionStatus(
      orderId,
      [OrderStatus.PENDING],
      OrderStatus.CONFIRMED,
    );
    if (!claimed) {
      throw new BadRequestException(
        `Order #${orderId} cannot be paid while it is ${order.status}`,
      );
    }

    let lastError: Error;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const result = await paymentService.processPayment(orderId, Number(order.total));

        if (result.success) {
          return result;
        }
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    // Every attempt failed, so release the claim: an order left CONFIRMED
    // without a payment behind it is worse than one that stayed PENDING.
    await this.transitionStatus(
      orderId,
      [OrderStatus.CONFIRMED],
      OrderStatus.PENDING,
    );

    throw lastError!;
  }

  async cancel(id: number): Promise<Order> {
    const order = await this.findOne(id);

    await this.ordersRepository.manager.transaction(
      async (manager: EntityManager) => {
        // Flip first, conditionally. Whoever wins the flip owns the restore, so
        // a second cancel of the same order matches no row and puts the stock
        // back zero times instead of twice.
        const cancelled = await this.transitionStatus(
          id,
          [OrderStatus.PENDING],
          OrderStatus.CANCELLED,
          manager,
        );
        if (!cancelled) {
          throw new BadRequestException('Only pending orders can be cancelled');
        }

        for (const item of order.items) {
          await this.productsService.adjustStock(
            item.productId,
            item.quantity,
            manager,
          );
        }
      },
    );
    await this.productsService.invalidateSearchCache();

    return this.findOne(id);
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
