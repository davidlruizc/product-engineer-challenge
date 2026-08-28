import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from '@nestjs/cache-manager';
import Keyv from 'keyv';
import KeyvRedis from '@keyv/redis';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UsersModule } from './users/users.module';
import { ProductsModule } from './products/products.module';
import { OrdersModule } from './orders/orders.module';
import { User } from './users/user.entity';
import { Product } from './products/product.entity';
import { Order } from './orders/order.entity';
import { OrderItem } from './orders/order-item.entity';
import { Category } from './products/category.entity';

@Module({
  imports: [
    ConfigModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      username: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      database: process.env.DB_NAME || 'challengedb',
      entities: [User, Product, Order, OrderItem, Category],
      synchronize: true,
    }),
    CacheModule.registerAsync({
      isGlobal: true,
      // `stores` (plural) is what @nestjs/cache-manager 3.x reads. Passing the
      // singular `store` leaves options.stores undefined, and cache-manager
      // silently falls back to a per-process in-memory cache.
      useFactory: () => {
        const host = process.env.REDIS_HOST || 'localhost';
        const port = parseInt(process.env.REDIS_PORT || '6379', 10);
        const db = parseInt(process.env.REDIS_DB || '0', 10);
        return {
          stores: [
            new Keyv({
              store: new KeyvRedis(`redis://${host}:${port}/${db}`),
            }),
          ],
          ttl: 60000,
        };
      },
    }),
    UsersModule,
    ProductsModule,
    OrdersModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
