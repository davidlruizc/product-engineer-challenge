import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, Query } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  findAll(
    // parseInt('abc') is NaN, which used to reach the WHERE clause and come
    // back as a driver error rendered as a 500. The pipe rejects it up front.
    @Query('userId', new ParseIntPipe({ optional: true })) userId?: number,
  ) {
    if (userId !== undefined) {
      return this.ordersService.findByUser(userId);
    }
    return this.ordersService.findAll();
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
