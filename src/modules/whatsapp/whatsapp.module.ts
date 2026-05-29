import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppProcessor } from './whatsapp.processor';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';
import { WhatsAppWebhookService } from './whatsapp-webhook.service';
import { MetaCloudWhatsAppProvider } from './providers/meta-cloud.provider';
import { WHATSAPP_PROVIDER } from './providers/whatsapp.provider.interface';
import { User } from '../users/user.entity';
import { BookingsModule } from '../bookings/bookings.module';

/**
 * WhatsAppModule
 *
 * Phase 1 (May 29, 2026): provider-agnostic scaffolding. Ships
 * with the Meta Cloud API provider as the default implementation;
 * any other provider (Twilio, MSG91, Gupshup) plugs in by being
 * registered against the `WHATSAPP_PROVIDER` token in the providers
 * array — zero changes elsewhere.
 *
 * Phase 2 (May 29, 2026): outbound chef booking-request via template
 * sends through here. NotificationsService imports WhatsAppModule
 * (one-way) — see notifications.module.ts.
 *
 * Phase 3 (May 29, 2026): inbound webhook controller + service.
 * `webhooks/whatsapp` (GET handshake + POST message delivery) lives
 * in this module. The webhook service routes button payloads back
 * into BookingsService.
 *
 * Cyclic-import resolution
 * ────────────────────────
 * Phase 3 introduces a back-edge: WhatsApp → Bookings (button taps
 * call BookingsService.acceptBooking / rejectBooking). The forward
 * edge already exists transitively: Bookings → Notifications →
 * WhatsApp (Phase 2). The cycle is broken with `forwardRef` on the
 * WhatsApp side because:
 *   1. WhatsApp is the smaller / leaf-ier module of the two —
 *      lighter import surface.
 *   2. Only the webhook service actually needs BookingsService;
 *      every other consumer of WhatsAppModule (NotificationsService)
 *      uses only WhatsAppService which has no Bookings dep.
 *
 * No-op when env is incomplete: the provider's `isConfigured()`
 * returns false, the service short-circuits sends, the processor
 * drops the job, and the inbound webhook still mounts but every
 * signature check returns false (nothing reaches the routing layer).
 *
 * Public surface:
 *   - WhatsAppService — used by NotificationsService for outbound
 *     template sends and by WhatsAppWebhookController for signature
 *     verification + challenge handling.
 *
 * Internal:
 *   - WhatsAppProcessor (Bull worker on the 'whatsapp' queue)
 *   - WhatsAppWebhookController (HTTP routes)
 *   - WhatsAppWebhookService (inbound routing + idempotency)
 *   - MetaCloudWhatsAppProvider (bound to WHATSAPP_PROVIDER)
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: 'whatsapp' }),
    // Phase 3 — webhook service looks up the chef User by their
    // inbound WhatsApp phone. We register User locally rather than
    // importing UsersModule to avoid a deeper import graph for one
    // repository.
    TypeOrmModule.forFeature([User]),
    // Phase 3 cycle resolution — see class doc above.
    forwardRef(() => BookingsModule),
  ],
  controllers: [WhatsAppWebhookController],
  providers: [
    WhatsAppService,
    WhatsAppProcessor,
    WhatsAppWebhookService,
    {
      provide: WHATSAPP_PROVIDER,
      useClass: MetaCloudWhatsAppProvider,
    },
  ],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
