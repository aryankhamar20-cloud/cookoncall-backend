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
} from '@nestjs/common';
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
    return this.paymentsService.createOrder(user.id, dto);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verifyPayment(
    @CurrentUser() user: User,
    @Body() dto: VerifyPaymentDto,
  ) {
    return this.paymentsService.verifyPayment(user.id, dto);
  }

  @Get('booking/:bookingId')
  async getPaymentByBooking(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
  ) {
    return this.paymentsService.getPaymentByBooking(bookingId);
  }

  // Razorpay webhook — must be public (no JWT)
  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Body() body: any,
    @Headers('x-razorpay-signature') signature: string,
  ) {
    return this.paymentsService.handleWebhook(body, signature);
  }
}
