/**
 * WhatsApp template registry — single source of truth for every
 * template name + variable schema we send through Meta Cloud API.
 *
 * Why a registry instead of inline strings at every call site:
 *
 *   1. Meta requires every business-initiated WhatsApp message to use
 *      a pre-approved template. Templates are registered ONCE in the
 *      WABA dashboard; the runtime contract is { name, language, vars[] }.
 *      Putting that contract in code (next to the call sites that build
 *      the var array) is the only way reviewers can spot
 *      "you passed 5 vars but the template expects 6" before it ships.
 *
 *   2. Every template is a constant — never built dynamically. If the
 *      copy needs to change we update it in Meta + bump the template
 *      name (e.g. chef_booking_request_v2). The runtime never tries
 *      to construct WhatsApp message text from user input — that's a
 *      compliance hard-line: free-form text outside the 24-hour
 *      customer-care window is rejected by Meta and risks WABA
 *      suspension.
 *
 *   3. Phase 1 ships the *names* + *schemas* but the actual approval
 *      happens in the WABA dashboard separately. This file is the
 *      runbook for what to register — see WHATSAPP_SETUP.md (Phase 5).
 *
 * Adding a new template
 * ---------------------
 *   1. Pick a stable snake_case name (Meta does not allow renames).
 *   2. Document each {{N}} placeholder under `vars` with its purpose.
 *   3. If the template has interactive buttons, list their payload
 *      prefixes under `buttons`. Payloads are bound in the WABA UI
 *      to the template at registration time; we send them via the
 *      `button` component when calling /messages.
 *   4. Register the template in Meta (Business Manager → WhatsApp
 *      Manager → Message Templates → Create Template).
 *   5. Wait for approval (1–24 hours typical, 7 days worst case).
 *   6. Wire the template into NotificationsService (Phase 2/4).
 */

export interface WhatsAppTemplateSpec {
  /** Snake-case template name as registered with Meta. Stable forever. */
  readonly name: string;
  /** ISO language code that matches the registered template. */
  readonly language: string;
  /** Ordered names for each {{1}}, {{2}}, ... body placeholder. Documentation only. */
  readonly vars: readonly string[];
  /** Quick-reply button payload prefixes, in the order they appear in the template. */
  readonly buttons?: readonly string[];
}

/**
 * CHEF_BOOKING_REQUEST — sent to the chef when a customer creates a
 * booking. Includes Approve/Decline quick-reply buttons; the chef's
 * tap is delivered to our /webhooks/whatsapp endpoint as a button
 * payload of the form `APPROVE_<bookingId>` / `REJECT_<bookingId>`.
 *
 * Wire-up: NotificationsService.notifyBookingCreated (Phase 2).
 */
export const CHEF_BOOKING_REQUEST: WhatsAppTemplateSpec = {
  name: 'chef_booking_request',
  language: 'en',
  vars: [
    'chef_name',
    'customer_name',
    'booking_id_short', // first 8 chars of UUID, uppercased
    'date_str', // e.g. "Saturday, June 15, 2026"
    'time_str', // e.g. "07:30 PM"
    'address_short', // truncated to ~80 chars
    'total_str', // e.g. "1,234"
  ],
  buttons: ['APPROVE_', 'REJECT_'], // suffixed with bookingId at send time
} as const;

/**
 * CUSTOMER_BOOKING_CONFIRMED — sent to the customer when the chef
 * accepts. Confirms the session details + reminds about session-end
 * payment (matches the May 29, 2026 booking flow where payment is
 * optional until end-OTP).
 *
 * Wire-up: NotificationsService.notifyChefAccepted (Phase 4).
 */
export const CUSTOMER_BOOKING_CONFIRMED: WhatsAppTemplateSpec = {
  name: 'customer_booking_confirmed',
  language: 'en',
  vars: [
    'customer_name',
    'chef_name',
    'date_str',
    'time_str',
    'booking_id_short',
  ],
} as const;

/**
 * CHEF_BOOKING_CONFIRMED — confirmation back to the chef after their
 * Approve tap (or web-app accept) so they have the booking details
 * in their WhatsApp thread for reference. WhatsApp button taps don't
 * auto-acknowledge in the chat — without this template the chef sees
 * their own button tap and then silence.
 *
 * Wire-up: NotificationsService.notifyChefAccepted (Phase 4).
 */
export const CHEF_BOOKING_CONFIRMED: WhatsAppTemplateSpec = {
  name: 'chef_booking_confirmed',
  language: 'en',
  vars: [
    'chef_name',
    'customer_name',
    'date_str',
    'time_str',
    'booking_id_short',
  ],
} as const;

/**
 * CUSTOMER_BOOKING_REJECTED — sent to the customer when the chef
 * declines. NO rejection reason is exposed (matches the existing
 * email behavior — reason stays admin-only in `bookings.rejection_reason`).
 *
 * Wire-up: NotificationsService.notifyChefRejected (Phase 4).
 */
export const CUSTOMER_BOOKING_REJECTED: WhatsAppTemplateSpec = {
  name: 'customer_booking_rejected',
  language: 'en',
  vars: ['customer_name', 'chef_name'],
} as const;

/**
 * Convenience aggregator — useful in tests + future Phase 5
 * "list registered templates" admin tooling.
 */
export const ALL_TEMPLATES = [
  CHEF_BOOKING_REQUEST,
  CUSTOMER_BOOKING_CONFIRMED,
  CHEF_BOOKING_CONFIRMED,
  CUSTOMER_BOOKING_REJECTED,
] as const;
