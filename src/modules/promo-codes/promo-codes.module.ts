import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PromoCode } from './promo-code.entity';
import { PromoCodeUsage } from './promo-code-usage.entity';
import { AdminAuditLog } from '../admin/admin-audit.entity';
import { PromoCodesService } from './promo-codes.service';
import { PromoCodesController } from './promo-codes.controller';
import { AnalyticsModule } from '../analytics/analytics.module';

@Module({
  imports: [
    // We register the AdminAuditLog entity here too so the service can
    // write `promo.*` rows directly without taking a circular dep on
    // AdminModule. The single source of truth for the table schema
    // remains the AdminModule's TypeOrmModule.forFeature() call.
    TypeOrmModule.forFeature([PromoCode, PromoCodeUsage, AdminAuditLog]),
    AnalyticsModule,
  ],
  controllers: [PromoCodesController],
  providers: [PromoCodesService],
  exports: [PromoCodesService],
})
export class PromoCodesModule {}
