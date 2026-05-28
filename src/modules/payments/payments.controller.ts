import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { PaymentsService } from './payments.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { User } from '../users/user.entity';
import { CreateOrderDto, VerifyPaymentDto } from './dto/payment.dto';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('create-order')
  async createOrder(
    @CurrentUser() user: User,
    @Body() dto: CreateOrderDto,
  ) {
    const result = await this.paymentsService.createOrder(user.id, dto);
    return { success: true, data: result };
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verifyPayment(
    @CurrentUser() user: User,
    @Body() dto: VerifyPaymentDto,
  ) {
    const result = await this.paymentsService.verifyPayment(user.id, dto);
    return { success: true, data: result };
  }

  @Get('booking/:bookingId')
  async getPaymentByBooking(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
  ) {
    return this.paymentsService.getPaymentByBooking(bookingId);
  }

  // Razorpay webhook — must be public (no JWT).
  // We read the RAW request body here (req.rawBody, enabled via
  // NestFactory rawBody:true) because Razorpay computes the signature
  // over the exact bytes they sent. JSON.stringify(parsedBody) does
  // not reproduce those bytes (key order, whitespace, escaped chars).
  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: any,
    @Headers('x-razorpay-signature') signature: string,
  ) {
    return this.paymentsService.handleWebhook(req.rawBody, body, signature);
  }
}
