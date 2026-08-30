import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  ParseIntPipe,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { INT4_MAX } from '../common/database-errors';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  findAll(
    // Taken as a string on purpose. Declaring it `number` makes the global
    // ValidationPipe's transform run first and coerce with `+value`, so
    // ParseIntPipe never sees what the client sent: '' and ' ' arrive as 0,
    // and '1e3' and '0x10' arrive as 1000 and 16, all of which then pass a
    // digits-only check that runs too late to matter.
    @Query('userId') rawUserId?: string,
  ) {
    // An absent or blank filter means "no filter", which is what the endpoint
    // did before this commit. Folding it to user 0 returns an empty list for a
    // request that should return everything — a wrong answer with a 200 on it.
    if (rawUserId === undefined || rawUserId.trim() === '') {
      return this.ordersService.findAll();
    }

    // parseInt('abc') is NaN, which used to reach the WHERE clause and come
    // back as a driver error rendered as a 500.
    if (!/^-?\d+$/.test(rawUserId)) {
      throw new BadRequestException(
        'Validation failed (numeric string is expected)',
      );
    }

    // userId is an int4 column. Without this the driver raises SQLSTATE 22003
    // and it escapes as a bare 500 — the same shape as the defect above.
    const userId = Number(rawUserId);
    if (!Number.isSafeInteger(userId) || Math.abs(userId) > INT4_MAX) {
      throw new BadRequestException('userId is out of range');
    }

    return this.ordersService.findByUser(userId);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.ordersService.findOne(id);
  }

  @Get(':id/full')
  getFullDetails(@Param('id', ParseIntPipe) id: number) {
    return this.ordersService.getOrderWithFullDetails(id);
  }

  @Post()
  create(@Body() createOrderDto: CreateOrderDto) {
    return this.ordersService.create(createOrderDto);
  }

  @Post(':id/pay')
  processPayment(@Param('id', ParseIntPipe) id: number) {
    return this.ordersService.processPayment(id);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseIntPipe) id: number,
    // @Body('status') extracts a single property, which no pipe validates, so
    // any value at all — including undefined — was written to the column.
    @Body() body: UpdateOrderStatusDto,
  ) {
    return this.ordersService.updateStatus(id, body.status);
  }

  @Post(':id/cancel')
  cancel(@Param('id', ParseIntPipe) id: number) {
    return this.ordersService.cancel(id);
  }
}
