import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import {
  InboundEvent,
  OutboundMessage,
  SendResult,
  WhatsAppProvider,
} from './whatsapp.provider.interface';

/**
 * Meta WhatsApp Cloud API provider implementation.
 *
 * Required env (all five must be set for `isConfigured()` to return true):
 *   - WHATSAPP_PHONE_NUMBER_ID       (from Meta Business → WhatsApp → API Setup)
 *   - WHATSAPP_ACCESS_TOKEN          (system-user permanent token, NOT temporary)
 *   - WHATSAPP_VERIFY_TOKEN          (any random string we choose; pasted into
 *                                     Meta's webhook subscription form so they
 *                                     echo it back during the GET handshake)
 *   - WHATSAPP_APP_SECRET            (Meta App → Settings → Basic → App Secret;
 *                                     used to HMAC-verify inbound webhook bodies)
 *
 * Optional env:
 *   - WHATSAPP_API_VERSION           (default 'v20.0' — bump when Meta deprecates)
 *   - WHATSAPP_DEFAULT_COUNTRY_CODE  (default '91' — used by phone-normaliser)
 *
 * No-op behaviour: if any of the four required vars is missing we
 * return ok=false with code='NOT_CONFIGURED' from `send()` and false
 * from `verifySignature()`. This is the *desired* dev/preview behaviour
 * — the platform should not crash because the prod secret isn't in
 * the test environment.
 */
@Injectable()
export class MetaCloudWhatsAppProvider implements WhatsAppProvider {
  private readonly logger = new Logger(MetaCloudWhatsAppProvider.name);

  private readonly phoneNumberId: string | undefined;
  private readonly accessToken: string | undefined;
  private readonly verifyToken: string | undefined;
  private readonly appSecret: string | undefined;
  private readonly apiVersion: string;

  constructor(private readonly config: ConfigService) {
    this.phoneNumberId = this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    this.accessToken = this.config.get<string>('WHATSAPP_ACCESS_TOKEN');
    this.verifyToken = this.config.get<string>('WHATSAPP_VERIFY_TOKEN');
    this.appSecret = this.config.get<string>('WHATSAPP_APP_SECRET');
    this.apiVersion =
      this.config.get<string>('WHATSAPP_API_VERSION') || 'v20.0';
  }

  isConfigured(): boolean {
    return Boolean(
      this.phoneNumberId &&
        this.accessToken &&
        this.verifyToken &&
        this.appSecret,
    );
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        providerMessageId: null,
        error: {
          code: 'NOT_CONFIGURED',
          message: 'WhatsApp provider env not set',
        },
      };
    }

    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
    const payload = this.buildOutboundPayload(msg);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(payload),
      });

      // Meta returns either { messages: [{ id }], ... } on success or
      // { error: { code, message } } on failure. Both come back as
      // valid JSON; we tolerate parse failure as a transport error.
      const data: any = await response.json().catch(() => ({}));

      if (!response.ok) {
        return {
          ok: false,
          providerMessageId: null,
          error: {
            code: String(data?.error?.code ?? response.status),
            message: data?.error?.message ?? `HTTP ${response.status}`,
          },
        };
      }

      const providerMessageId =
        Array.isArray(data?.messages) && data.messages[0]?.id
          ? String(data.messages[0].id)
          : null;
      return { ok: true, providerMessageId };
    } catch (err: any) {
      // Network / DNS / timeout. Caller (Bull processor) will retry.
      return {
        ok: false,
        providerMessageId: null,
        error: {
          code: 'TRANSPORT_ERROR',
          message: err?.message || 'unknown transport error',
        },
      };
    }
  }

  /**
   * Translate our provider-agnostic OutboundMessage into the exact
   * JSON Meta's Graph API expects.
   *
   * Reference shape (template, with body vars + 2 quick-reply buttons):
   *   {
   *     messaging_product: 'whatsapp',
   *     to: '<E.164 digits>',
   *     type: 'template',
   *     template: {
   *       name: '<template_name>',
   *       language: { code: 'en' },
   *       components: [
   *         { type: 'body', parameters: [{ type: 'text', text: '<v1>' }, ...] },
   *         { type: 'button', sub_type: 'quick_reply', index: '0',
   *           parameters: [{ type: 'payload', payload: '<payload1>' }] },
   *         { type: 'button', sub_type: 'quick_reply', index: '1',
   *           parameters: [{ type: 'payload', payload: '<payload2>' }] },
   *       ],
   *     },
   *   }
   *
   * Reference shape (free text, only valid inside 24h CS window):
   *   {
   *     messaging_product: 'whatsapp',
   *     to: '<E.164 digits>',
   *     type: 'text',
   *     text: { body: '<text>' },
   *   }
   *
   * Note: kept as a method (not a free function) so subclasses /
   * future variants can override component layout without forking
   * the entire provider.
   */
  private buildOutboundPayload(msg: OutboundMessage): Record<string, unknown> {
    if (msg.kind === 'text') {
      return {
        messaging_product: 'whatsapp',
        to: msg.to,
        type: 'text',
        text: { body: msg.body },
      };
    }

    // Template message
    const components: Record<string, unknown>[] = [];

    if (msg.vars && msg.vars.length > 0) {
      components.push({
        type: 'body',
        parameters: msg.vars.map((v) => ({ type: 'text', text: v })),
      });
    }

    if (msg.buttons && msg.buttons.length > 0) {
      msg.buttons.forEach((btn, idx) => {
        components.push({
          type: 'button',
          sub_type: 'quick_reply',
          index: String(idx),
          parameters: [{ type: 'payload', payload: btn.payload }],
        });
      });
    }

    return {
      messaging_product: 'whatsapp',
      to: msg.to,
      type: 'template',
      template: {
        name: msg.templateName,
        language: { code: msg.language },
        components,
      },
    };
  }

  // ─── INBOUND VERIFICATION ──────────────────────────────

  /**
   * HMAC-SHA256 verification of inbound webhook bodies.
   *
   * Mirrors PaymentsService's Razorpay handler exactly:
   *   - Refuses if app_secret env is missing (misconfigured prod must
   *     fail loud, not silently accept any signature).
   *   - Refuses if signature header is missing.
   *   - Refuses if raw body is missing or empty.
   *   - Uses crypto.timingSafeEqual to avoid byte-by-byte timing leaks.
   *   - Tolerates length mismatch (timingSafeEqual throws on different
   *     buffer lengths — wrap in try/catch and return false instead).
   *
   * Meta sends the signature as `X-Hub-Signature-256: sha256=<hex>`.
   * The hex part is the HMAC of the raw body keyed with WHATSAPP_APP_SECRET.
   */
  verifySignature(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): boolean {
    if (!this.appSecret) {
      this.logger.error('WHATSAPP_APP_SECRET is not configured');
      return false;
    }
    if (!signature || !rawBody || rawBody.length === 0) {
      return false;
    }

    // Header is "sha256=<hex>". Strip the prefix if present.
    const expectedHex = crypto
      .createHmac('sha256', this.appSecret)
      .update(rawBody)
      .digest('hex');

    const providedHex = signature.startsWith('sha256=')
      ? signature.slice('sha256='.length)
      : signature;

    try {
      const expected = Buffer.from(expectedHex, 'hex');
      const provided = Buffer.from(providedHex, 'hex');
      if (expected.length !== provided.length) {
        return false;
      }
      return crypto.timingSafeEqual(expected, provided);
    } catch {
      return false;
    }
  }

  /**
   * Meta's webhook subscription handshake.
   *
   * When the operator clicks "Verify and Save" in the Meta dashboard,
   * Meta sends a GET to /webhooks/whatsapp with:
   *   ?hub.mode=subscribe
   *   &hub.verify_token=<our chosen string>
   *   &hub.challenge=<random string we must echo back>
   *
   * If hub.verify_token matches WHATSAPP_VERIFY_TOKEN we return the
   * challenge string (controller echoes it raw with HTTP 200). If
   * anything is off we return null (controller responds 403).
   */
  verifyChallenge(query: Record<string, string | undefined>): string | null {
    if (!this.verifyToken) {
      this.logger.error('WHATSAPP_VERIFY_TOKEN is not configured');
      return null;
    }
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (mode === 'subscribe' && token === this.verifyToken && challenge) {
      return String(challenge);
    }
    return null;
  }

  /**
   * Walk Meta's nested webhook payload and extract a flat list of
   * normalised events.
   *
   * Reference shape (button tap):
   *   {
   *     object: 'whatsapp_business_account',
   *     entry: [{
   *       id: '<waba-id>',
   *       changes: [{
   *         field: 'messages',
   *         value: {
   *           messaging_product: 'whatsapp',
   *           metadata: { display_phone_number, phone_number_id },
   *           contacts: [{ wa_id: '<from-e164>', profile: { name } }],
   *           messages: [{
   *             from: '<from-e164>',
   *             id: 'wamid....',
   *             timestamp: '<unix>',
   *             type: 'button',
   *             button: { payload: 'APPROVE_<bookingId>', text: 'Approve' },
   *           }],
   *         },
   *       }],
   *     }],
   *   }
   *
   * Status / delivery receipts use `value.statuses[]` instead of
   * `value.messages[]` and we surface them as type='status' for
   * potential future use (Phase 5 delivery tracking).
   */
  parseInbound(body: unknown): InboundEvent[] {
    const out: InboundEvent[] = [];
    try {
      const root = body as any;
      if (!root || root.object !== 'whatsapp_business_account') return out;
      const entries = Array.isArray(root.entry) ? root.entry : [];
      for (const entry of entries) {
        const changes = Array.isArray(entry?.changes) ? entry.changes : [];
        for (const change of changes) {
          if (change?.field !== 'messages') continue;
          const value = change?.value || {};
          const messages = Array.isArray(value.messages) ? value.messages : [];
          for (const m of messages) {
            const from = String(m?.from ?? '');
            const id = String(m?.id ?? '');
            const ts = m?.timestamp ? String(m.timestamp) : undefined;
            if (!from || !id) continue;
            const t = m?.type;
            if (t === 'button' && m?.button?.payload) {
              out.push({
                providerMessageId: id,
                from,
                type: 'button',
                buttonPayload: String(m.button.payload),
                timestamp: ts,
              });
            } else if (t === 'interactive' && m?.interactive?.button_reply?.id) {
              // Interactive list/button replies expose the payload as
              // `button_reply.id`. We treat them the same as
              // type='button' for downstream routing.
              out.push({
                providerMessageId: id,
                from,
                type: 'button',
                buttonPayload: String(m.interactive.button_reply.id),
                timestamp: ts,
              });
            } else if (t === 'text' && m?.text?.body) {
              out.push({
                providerMessageId: id,
                from,
                type: 'text',
                text: String(m.text.body),
                timestamp: ts,
              });
            } else {
              out.push({
                providerMessageId: id,
                from,
                type: 'unknown',
                timestamp: ts,
              });
            }
          }
          // Status receipts (delivery / read). Surfaced with type='status'.
          const statuses = Array.isArray(value.statuses) ? value.statuses : [];
          for (const s of statuses) {
            const id = String(s?.id ?? '');
            const recipient = String(s?.recipient_id ?? '');
            if (!id || !recipient) continue;
            out.push({
              providerMessageId: id,
              from: recipient,
              type: 'status',
              timestamp: s?.timestamp ? String(s.timestamp) : undefined,
            });
          }
        }
      }
    } catch (err: any) {
      this.logger.warn(
        `Could not parse WhatsApp inbound payload: ${err?.message ?? err}`,
      );
    }
    return out;
  }
}
