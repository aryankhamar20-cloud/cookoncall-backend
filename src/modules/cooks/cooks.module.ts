import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CooksService } from './cooks.service';
import { CooksController } from './cooks.controller';
import { Cook } from './cook.entity';
import { MenuItem } from './menu-item.entity';
import { User } from '../users/user.entity';
import { Booking } from '../bookings/booking.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Cook, MenuItem, User, Booking])],
  controllers: [CooksController],
  providers: [CooksService],
  exports: [CooksService],
})
export class CooksModule {}
