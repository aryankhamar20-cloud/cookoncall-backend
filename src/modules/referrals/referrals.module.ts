import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReferralsService } from './referrals.service';
import { ReferralsController } from './referrals.controller';
import { Referral } from './referral.entity';
import { User } from '../users/user.entity';
import { PromoCode } from '../promo-codes/promo-code.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Referral, User, PromoCode])],
  controllers: [ReferralsController],
  providers: [ReferralsService],
  exports: [ReferralsService],
})
export class ReferralsModule {}
