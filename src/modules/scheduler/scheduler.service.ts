import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BookingsService } from '../bookings/bookings.service';

/**
 * SchedulerService — P1.5d
 *
 * Runs a lightweight cron every 15 minutes to find confirmed package
 * bookings starting in ~2 hours and sends the ingredient reminder email
 * to the customer.
 *
 * INSTALL: npm install @nestjs/schedule
 * REGISTER: add SchedulerModule to app.module.ts imports (see scheduler.module.ts)
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(private readonly bookingsService: BookingsService) {}

  // Runs every 15 minutes. Ingredient window is ±15 min around the 2h mark,
  // so a 15-min cron guarantees exactly one fire per booking.
  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleIngredientReminders() {
    this.logger.debug('Running ingredient reminder sweep…');
    try {
      await this.bookingsService.sendIngredientReminders();
    } catch (err) {
      this.logger.error(`Ingredient reminder cron failed: ${err?.message}`);
    }
  }
}
