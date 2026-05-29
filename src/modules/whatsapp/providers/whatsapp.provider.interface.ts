/**
 * Provider contract for the WhatsApp integration.
 *
 * Why an interface, when we currently only ship one implementation
 * (Meta Cloud API)? Two reasons:
 *
 *   1. Cost optionality. Meta gives us free 1000 conversations/month
 *      and the cheapest paid pricing. But the day Meta turns into a
 *      blocker (template rejection patterns, regional outages,
 *      pricing changes) we want a 1-day swap to Twilio / MSG91 /
 *      Gupshup, not a refactor. The provider is the entire WhatsApp
 *      blast radius — everything else in this module is provider-agnostic.
 *
 *   2. Tests. The Bull processor + WhatsAppService both depend on
 *      the provider. Tests inject a fake. The interface is the
 *      contract that defines what "fake" means.
 *
 * Outbound and inbound shapes intentionally hide the provider's
 * native payload format. Callers see template names + variables;
 * the provider is the only place that knows how Meta wants those
 * arranged on the wire.
 */

/** Quick-reply button on a template message. The payload comes back to us
 *  as the button payload on the inbound webhook when the user taps. */
export interface OutboundTemplateButton {
  /** Stable string we control — e.g. `APPROVE_<bookingId>`. */
  readonly payload: string;
}

/** A template-based outbound message. The only kind allowed by Meta
 *  outside the 24-hour customer-care window. */
export interface OutboundTemplateMessage {
  readonly kind: 'template';
  /** Recipient in E.164 digits-only (no leading +). e.g. "919876543210". */
  readonly to: string;
  readonly templateName: string;
  readonly language: string;
  /** Body parameters in the order the registered template expects them. */
  readonly vars: readonly string[];
  /** Quick-reply button payloads in template order, if any. */
  readonly buttons?: readonly OutboundTemplateButton[];
}

/** Free-form text — only valid inside a 24-hour customer-care window
 *  (the user must have messaged the business in the last 24h). Used by
 *  the inbound webhook handler in Phase 3 to reply to button taps. */
export interface OutboundTextMessage {
  readonly kind: 'text';
  readonly to: string;
  readonly body: string;
}

export type OutboundMessage = OutboundTemplateMessage | OutboundTextMessage;

export interface SendResult {
  readonly ok: boolean;
  /** Provider-assigned message ID. Used by Phase 2+ to correlate delivery
   *  status webhooks back to the originating booking. */
  readonly providerMessageId: string | null;
  readonly error?: { readonly code: string; readonly message: string };
}

/** Normalised inbound webhook event. */
export interface InboundEvent {
  /** Provider-assigned ID for THIS inbound message. Used for idempotency. */
  readonly providerMessageId: string;
  /** Sender in E.164 digits-only. */
  readonly from: string;
  /** Discriminator: 'button' = quick-reply tap, 'text' = free text,
   *  'status' = delivery/read receipt, 'unknown' = anything else. */
  readonly type: 'button' | 'text' | 'status' | 'unknown';
  /** Set when type === 'button'. The exact payload string we registered
   *  against the template button (e.g. `APPROVE_<bookingId>`). */
  readonly buttonPayload?: string;
  /** Set when type === 'text'. */
  readonly text?: string;
  /** Raw provider event timestamp (ISO 8601). Useful for diagnostics. */
  readonly timestamp?: string;
}

export interface WhatsAppProvider {
  /** True iff every credential needed to actually call the provider's
   *  API is present. When false, callers MUST short-circuit instead of
   *  attempting `send()` — keeps dev / preview environments quiet. */
  isConfigured(): boolean;

  /** Send a message. Never throws on transport errors — failures are
   *  reported via SendResult.ok=false so the queue can decide whether
   *  to retry. */
  send(msg: OutboundMessage): Promise<SendResult>;

  /** Verify the HMAC signature on an inbound webhook body. The signature
   *  header from Meta is `X-Hub-Signature-256: sha256=<hex>`. Returns
   *  true if the body matches the signature under the configured
   *  app secret. False on any failure mode (missing secret, missing
   *  header, length mismatch, byte mismatch) — never throws. */
  verifySignature(rawBody: Buffer | undefined, signature: string | undefined): boolean;

  /** Handle Meta's webhook subscription handshake (GET /webhooks/whatsapp
   *  with hub.mode=subscribe). Returns the challenge string to echo back
   *  on success, or null to refuse. */
  verifyChallenge(query: Record<string, string | undefined>): string | null;

  /** Parse an inbound webhook body into 0..N normalised events. Meta
   *  delivers a nested entry/changes/value/messages array; we flatten
   *  to a list. Status/read receipts are filtered to type='status'.
   *  Never throws on malformed input — returns []. */
  parseInbound(body: unknown): InboundEvent[];
}

/**
 * DI token. We use a string token instead of using the class directly
 * so any future provider (TwilioProvider, GupshupProvider) can be
 * registered against the same token at module wire-up time.
 */
export const WHATSAPP_PROVIDER = 'WHATSAPP_PROVIDER';
