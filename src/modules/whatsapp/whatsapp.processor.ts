import { Process, Processor } from '@nestjs/bull';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bull';
import {
  OutboundMessage,
  WHATSAPP_PROVIDER,
  WhatsAppProvider,
} from './providers/whatsapp.provider.interface';
import { WhatsAppJobData } from './whatsapp.service';

/**
 * Bull worker for the 'whatsapp' queue.
 *
 * Mirrors EmailProcessor exactly: read job → call provider → throw on
 * failure so Bull retries with the configured backoff.
 *
 * Behaviour matrix:
 *
 *   provider not configured (no creds)  → log + return (job marked
 *                                          completed, NOT retried; the
 *                                          message is intentionally
 *                                          dropped because there's
 *                                          nothing to retry against)
 *   provider returns ok=true            → log + return
 *   provider returns ok=false NOT_CONFIGURED
 *                                       → log + return (same reason)
 *   provider returns ok=false ANY OTHER → throw → Bull retries up to 3
 *                                          times with exponential backoff
 *   transport exception in provider     → already returned as ok=false
 *                                          TRANSPORT_ERROR, see above
 */
@Processor('whatsapp')
export class WhatsAppProcessor {
  private readonly logger = new Logger(WhatsAppProcessor.name);

  constructor(
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
  ) {}

  @Process('send-message')
  async handleSend(job: Job<WhatsAppJobData>) {
    const { kind, to, template, body, correlationId } = job.data;
    const tag = correlationId ? ` [${correlationId}]` : '';

    if (!this.provider.isConfigured()) {
      this.logger.warn(
        `WhatsApp provider not configured — dropping ${kind} message to ${to}${tag}`,
      );
      return; // mark completed; no retry possible
    }

    let outbound: OutboundMessage;
    if (kind === 'template') {
      if (!template) {
        this.logger.error(
          `WhatsApp template job missing template payload${tag}`,
        );
        return;
      }
      outbound = {
        kind: 'template',
        to,
        templateName: template.name,
        language: template.language,
        vars: template.vars,
        buttons: template.buttons,
      };
    } else {
      if (!body) {
        this.logger.error(`WhatsApp text job missing body${tag}`);
        return;
      }
      outbound = { kind: 'text', to, body };
    }

    const result = await this.provider.send(outbound);

    if (result.ok) {
      this.logger.log(
        `WhatsApp ${kind} sent to ${to} — providerMessageId=${result.providerMessageId}${tag}`,
      );
      return;
    }

    // NOT_CONFIGURED is the only ok=false path that should NOT retry.
    // The credentials aren't going to materialise on the next attempt
    // and we don't want job-failure noise drowning the queue.
    if (result.error?.code === 'NOT_CONFIGURED') {
      this.logger.warn(
        `WhatsApp provider not configured — dropped ${kind} to ${to}${tag}`,
      );
      return;
    }

    // Anything else — Bull retries.
    const errMsg = `${result.error?.code ?? 'UNKNOWN'}: ${
      result.error?.message ?? 'send failed'
    }`;
    this.logger.error(
      `WhatsApp ${kind} to ${to} failed (attempt ${
        job.attemptsMade + 1
      }/${job.opts.attempts ?? 1})${tag}: ${errMsg}`,
    );
    throw new Error(errMsg);
  }
}
