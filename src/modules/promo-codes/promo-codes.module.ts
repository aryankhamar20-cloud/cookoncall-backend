import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PromoCode } from './promo-code.entity';
import { PromoCodeUsage } from './promo-code-usage.entity';
import { PromoCodesService } from './promo-codes.service';
import { PromoCodesController } from './promo-codes.controller';

@Module({
  imports: [TypeOrmModule.forFeature([PromoCode, PromoCodeUsage])],
  controllers: [PromoCodesController],
  providers: [PromoCodesService],
  exports: [PromoCodesService],
})
export class PromoCodesModule {}
