import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class CreateOrderDto {
  @IsUUID()
  booking_id: string;
}

export class VerifyPaymentDto {
  @IsUUID()
  booking_id: string;

  @IsString()
  @IsNotEmpty()
  razorpay_order_id: string;

  @IsString()
  @IsNotEmpty()
  razorpay_payment_id: string;

  @IsString()
  @IsNotEmpty()
  razorpay_signature: string;
}
