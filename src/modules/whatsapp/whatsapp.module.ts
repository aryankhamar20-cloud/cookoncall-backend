import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppProcessor } from './whatsapp.processor';
import { MetaCloudWhatsAppProvider } from './providers/meta-cloud.provider';
import { WHATSAPP_PROVIDER } from './providers/whatsapp.provider.interface';

/**
 * WhatsAppModule
 *
 * Phase 1 (May 29, 2026): provider-agnostic scaffolding. Ships
 * with the Meta Cloud API provider as the default implementation;
 * any other provider (Twilio, MSG91, Gupshup) plugs in by being
 * registered against the `WHATSAPP_PROVIDER` token in the providers
 * array — zero changes elsewhere.
 *
 * No-op when env is incomplete: the provider's `isConfigured()`
 * returns false, the service short-circuits sends, and the processor
 * drops the job (no retries, no error noise). This is the desired
 * dev / preview behaviour — Phase 1 ships independently of the
 * WABA provisioning that gates Phase 2+.
 *
 * Public surface:
 *   - WhatsAppService — exported for NotificationsService to inject
 *     in Phase 2 / 4 (booking-created, chef-accepted, chef-rejected
 *     hooks).
 *
 * Internal:
 *   - WhatsAppProcessor — Bull worker on the 'whatsapp' queue.
 *   - MetaCloudWhatsAppProvider — bound to WHATSAPP_PROVIDER.
 */
@Module({
  imports: [BullModule.registerQueue({ name: 'whatsapp' })],
  providers: [
    WhatsAppService,
    WhatsAppProcessor,
    {
      provide: WHATSAPP_PROVIDER,
      useClass: MetaCloudWhatsAppProvider,
    },
  ],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
