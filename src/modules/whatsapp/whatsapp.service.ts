import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import {
  WHATSAPP_PROVIDER,
  WhatsAppProvider,
  OutboundTemplateButton,
} from './providers/whatsapp.provider.interface';
import { WhatsAppTemplateSpec } from './templates';

/**
 * Bull job payload — what gets serialised onto the queue. Keep this
 * shape stable; renames are migration-on-redeploy because in-flight
 * jobs from the old shape may still be in Redis when new code boots.
 */
export interface WhatsAppJobData {
  readonly kind: 'template' | 'text';
  /** E.164 digits-only, normalised before queueing. */
  readonly to: string;
  /** Set when kind === 'template'. */
  readonly template?: {
    readonly name: string;
    readonly language: string;
    readonly vars: readonly string[];
    readonly buttons?: readonly OutboundTemplateButton[];
  };
  /** Set when kind === 'text'. */
  readonly body?: string;
  /** Optional correlation ID — booking ID, broadcast ID, etc. — surfaced
   *  in the processor's log line so ops can grep prod logs by booking. */
  readonly correlationId?: string;
}

/**
 * High-level outbound options for the helper API. The translation to
 * a Bull job + the provider-native payload happens inside the service.
 */
export interface SendTemplateOptions {
  /** Recipient phone in any plausible format ("+919876543210",
   *  "919876543210", "9876543210", "09876543210"). Normalised to
   *  E.164 digits-only before being queued. */
  readonly to: string;
  /** A template spec from `templates.ts`. */
  readonly template: WhatsAppTemplateSpec;
  /** Body parameters in the order the registered template expects. The
   *  length should match `template.vars.length` — we log a warning if
   *  not (Meta will reject the message but we don't want to throw and
   *  break a booking flow over a copy mismatch). */
  readonly vars: readonly string[];
  /** Quick-reply button payload suffixes, mapped 1:1 to
   *  `template.buttons` prefixes. Example: template.buttons = ['APPROVE_'],
   *  buttonSuffixes = ['<bookingId>'] → emitted payload = 'APPROVE_<bookingId>'.
   *  When omitted, no button components are sent — only valid for
   *  templates registered without quick-reply buttons. */
  readonly buttonSuffixes?: readonly string[];
  /** Optional correlation ID — surfaced in worker logs. */
  readonly correlationId?: string;
}

/**
 * WhatsAppService — provider-agnostic outbound API for the rest of
 * the platform.
 *
 * Phase 1 contract:
 *   - `sendTemplate()` queues a Bull job; the WhatsAppProcessor reads
 *     the job and calls the configured provider. Failure / retry is
 *     Bull's job (3 attempts, exponential backoff).
 *   - All sends are short-circuited to a no-op when
 *     `provider.isConfigured()` returns false. This is the desired
 *     dev / preview behaviour — the platform must not crash when the
 *     prod WABA token isn't in the test environment.
 *   - Channel preference (`User.whatsapp_enabled`) is gated UPSTREAM
 *     in NotificationsService._channelAllowed, NOT here. This service
 *     does not know about user prefs — it just executes sends. Same
 *     contract as `sendDirectEmail`.
 *
 * Adding a new outbound surface (Phase 4+):
 *   1. Register the template in Meta + add a spec to `templates.ts`.
 *   2. Call `sendTemplate({ to, template, vars, ... })` from the
 *      orchestrating notification helper.
 *   3. Done — Bull handles retry, processor handles provider call,
 *      provider handles the Meta-specific JSON shape.
 */
@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly defaultCountryCode: string;

  constructor(
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
    @InjectQueue('whatsapp') private readonly queue: Queue<WhatsAppJobData>,
    private readonly config: ConfigService,
  ) {
    this.defaultCountryCode =
      this.config.get<string>('WHATSAPP_DEFAULT_COUNTRY_CODE') || '91';
  }

  /** True iff the underlying provider has full credentials. Callers
   *  may use this to skip building expensive vars when WhatsApp is
   *  off (currently optional — `sendTemplate` short-circuits anyway). */
  isConfigured(): boolean {
    return this.provider.isConfigured();
  }

  /**
   * Queue a template message for delivery.
   *
   * No-ops (returns false) when:
   *   - provider is not configured
   *   - the recipient phone fails normalisation (e.g. empty / non-digit)
   *   - buttonSuffixes length doesn't match template.buttons length
   *
   * On success, returns true after queueing.
   *
   * Never throws — WhatsApp failure is non-fatal; emails + in-app
   * notifications are the canonical channel.
   */
  async sendTemplate(opts: SendTemplateOptions): Promise<boolean> {
    if (!this.provider.isConfigured()) {
      this.logger.debug(
        `WhatsApp not configured — skipping template "${opts.template.name}"`,
      );
      return false;
    }

    const to = WhatsAppService.normalizePhoneE164(
      opts.to,
      this.defaultCountryCode,
    );
    if (!to) {
      this.logger.warn(
        `Invalid phone for WhatsApp template "${opts.template.name}" — skipping`,
      );
      return false;
    }

    if (opts.vars.length !== opts.template.vars.length) {
      this.logger.warn(
        `Template "${opts.template.name}" expects ${opts.template.vars.length} vars, got ${opts.vars.length} — sending anyway, Meta will reject if mismatched`,
      );
    }

    const buttons = this.buildButtons(opts);
    if (buttons === null) {
      this.logger.warn(
        `Template "${opts.template.name}" button mismatch — skipping`,
      );
      return false;
    }

    const job: WhatsAppJobData = {
      kind: 'template',
      to,
      template: {
        name: opts.template.name,
        language: opts.template.language,
        vars: opts.vars,
        buttons,
      },
      correlationId: opts.correlationId,
    };

    await this.queue.add('send-message', job, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false,
    });

    return true;
  }

  /**
   * Queue a free-form text message. Only valid inside the 24-hour
   * customer-care window — Meta will reject if the recipient hasn't
   * messaged us in the last 24h. Phase 3 uses this to acknowledge
   * webhook button taps; not used by the booking-create flow.
   */
  async sendText(
    to: string,
    body: string,
    correlationId?: string,
  ): Promise<boolean> {
    if (!this.provider.isConfigured()) return false;
    const e164 = WhatsAppService.normalizePhoneE164(to, this.defaultCountryCode);
    if (!e164 || !body) return false;
    await this.queue.add(
      'send-message',
      { kind: 'text', to: e164, body, correlationId },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    return true;
  }

  // ─── Webhook helpers (delegate to provider) ────────────

  verifySignature(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): boolean {
    return this.provider.verifySignature(rawBody, signature);
  }

  verifyChallenge(query: Record<string, string | undefined>): string | null {
    return this.provider.verifyChallenge(query);
  }

  parseInbound(body: unknown) {
    return this.provider.parseInbound(body);
  }

  // ─── Internals ─────────────────────────────────────────

  /**
   * Build the OutboundTemplateButton array from a template spec +
   * caller-supplied suffixes.
   *
   * Returns null on shape mismatch (caller logs and skips); returns
   * undefined when the template has no buttons (omit from outbound
   * payload); returns the array when present.
   */
  private buildButtons(
    opts: SendTemplateOptions,
  ): OutboundTemplateButton[] | undefined | null {
    const tplButtons = opts.template.buttons;
    const suffixes = opts.buttonSuffixes;

    // Template has no buttons → suffixes must also be empty.
    if (!tplButtons || tplButtons.length === 0) {
      if (suffixes && suffixes.length > 0) return null;
      return undefined;
    }

    // Template has buttons → caller must supply matching suffixes.
    if (!suffixes || suffixes.length !== tplButtons.length) return null;

    return tplButtons.map((prefix, i) => ({
      payload: `${prefix}${suffixes[i]}`,
    }));
  }

  /**
   * Phone normaliser. WhatsApp Cloud API expects digits-only E.164
   * without the leading '+'. Common Indian inputs we accept:
   *
   *   '+919876543210'  → '919876543210'
   *   '919876543210'   → '919876543210'
   *   ' 91 98765 43210' → '919876543210'
   *   '9876543210'     → '919876543210'   (10 digits → assume default cc)
   *   '09876543210'    → '919876543210'   (leading-0 trunk prefix)
   *   '00919876543210' → '919876543210'   (international prefix '00')
   *
   * Returns null for inputs that can't be made into a 10–15 digit string.
   *
   * Static so unit tests can call it without instantiating the service.
   */
  static normalizePhoneE164(
    raw: string | null | undefined,
    defaultCountryCode = '91',
  ): string | null {
    if (!raw) return null;
    let p = String(raw).replace(/[\s\-()+]/g, '');
    if (p.startsWith('00')) p = p.slice(2);
    if (p.startsWith('0')) p = p.slice(1);
    // E.164 max is 15 digits. If it looks like a local 10-digit Indian
    // number (after stripping prefixes) prepend the default country code.
    if (/^\d{10}$/.test(p)) p = defaultCountryCode + p;
    if (!/^\d{10,15}$/.test(p)) return null;
    return p;
  }
}
