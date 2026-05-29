import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole } from '../users/user.entity';
import { BookingsService } from '../bookings/bookings.service';
import { RedisCacheService } from '../../common/services/redis-cache.service';
import { WhatsAppService } from './whatsapp.service';
import { InboundEvent } from './providers/whatsapp.provider.interface';

/**
 * WhatsAppWebhookService — routes inbound WhatsApp events into the
 * existing booking state machine.
 *
 * Threat model
 * ────────────
 * The HMAC verification (delegated to MetaCloudWhatsAppProvider in
 * Phase 1) IS the auth boundary. There is no JWT — the chef does not
 * log in to tap a button — so a missed signature check would let
 * anyone on the internet flip any chef's bookings to CONFIRMED.
 * Hence:
 *   - The controller refuses with 401 BEFORE this service ever sees
 *     the body if signature verification fails.
 *   - This service additionally identifies the chef by their WhatsApp
 *     number (`from`) and refuses if it doesn't match exactly one
 *     verified User row with role=cook. A chef using two phone numbers
 *     to tap Approve on someone else's booking will be rejected here
 *     because the inbound `from` won't match the booking's cook.
 *   - Booking-state guards (already-confirmed, already-cancelled,
 *     expired, wrong-cook-for-booking) live in BookingsService.
 *     This service translates exceptions into friendly text replies.
 *
 * Idempotency
 * ───────────
 * Meta retries inbound deliveries on any non-2xx response — and even
 * on a slow 2xx if our turnaround exceeds their internal timeout. We
 * dedupe on `wamid` (the provider message ID, globally unique per
 * inbound message) using Redis SET-NX with a 5-minute TTL. Outside
 * that window the underlying state machines (acceptBooking /
 * rejectBooking) are themselves idempotent — running them twice on
 * a CONFIRMED booking surfaces a clear "Cannot accept a booking in
 * status confirmed" error which we silently swallow.
 *
 * Race-safe
 * ─────────
 * If a chef accepts via the web app at 12:00:00 and via WhatsApp at
 * 12:00:01, the second call sees status=CONFIRMED and throws
 * BadRequestException. We catch, log, and (inside the 24h CS window)
 * reply with a friendly text. The booking state never wobbles.
 */
@Injectable()
export class WhatsAppWebhookService {
  private readonly logger = new Logger(WhatsAppWebhookService.name);
  private static readonly INBOUND_DEDUP_TTL_SEC = 5 * 60;

  constructor(
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    @Inject(forwardRef(() => BookingsService))
    private readonly bookingsService: BookingsService,
    private readonly cache: RedisCacheService,
    private readonly whatsapp: WhatsAppService,
  ) {}

  /**
   * Process a parsed-and-verified inbound payload.
   *
   * Always resolves — Meta retries on 5xx, and we never want to retry
   * a booking accept/reject just because something downstream errored.
   * Per-event errors are caught and logged; the iteration continues
   * so a single malformed entry doesn't drop the rest of the batch.
   */
  async handle(body: unknown): Promise<void> {
    const events = this.whatsapp.parseInbound(body);
    for (const ev of events) {
      try {
        await this.handleEvent(ev);
      } catch (err: any) {
        // Defensive — handleEvent's own catch block should never let
        // anything escape, but if it does the controller still returns
        // 200 to Meta (no retry storm) and we get a structured log.
        this.logger.warn(
          `Unhandled error for inbound ${ev.providerMessageId}: ${err?.message || err}`,
        );
      }
    }
  }

  private async handleEvent(ev: InboundEvent): Promise<void> {
    // Status / delivery / read receipts are surfaced for Phase 5
    // observability but ignored today.
    if (ev.type === 'status') return;

    // Idempotency. WhatsApp re-deliveries for the same wamid land
    // here within seconds. The TTL only needs to be longer than
    // Meta's max retry window (~30s in our experience).
    const dedupeKey = `whatsapp:inbound:${ev.providerMessageId}`;
    const claimed = await this.cache.setIfNotExists(
      dedupeKey,
      { from: ev.from, type: ev.type, ts: ev.timestamp },
      WhatsAppWebhookService.INBOUND_DEDUP_TTL_SEC,
    );
    if (!claimed) {
      this.logger.log(
        `Skipping duplicate inbound ${ev.providerMessageId} from ${ev.from}`,
      );
      return;
    }

    if (ev.type === 'unknown') {
      this.logger.log(
        `Inbound 'unknown' from ${ev.from} (id=${ev.providerMessageId}) — ignoring`,
      );
      return;
    }

    if (ev.type === 'text') {
      // Phase 3 doesn't handle free-text — just log so ops can spot
      // chefs trying to converse with the platform. Phase 6+ may add
      // simple natural-language commands here.
      this.logger.log(
        `Inbound text from ${ev.from}: "${(ev.text ?? '').slice(0, 80)}"`,
      );
      return;
    }

    // type === 'button'
    const action = WhatsAppWebhookService.parseButtonPayload(ev.buttonPayload);
    if (!action) {
      this.logger.warn(
        `Unrecognised button payload from ${ev.from}: "${ev.buttonPayload}"`,
      );
      return;
    }

    const chef = await this.findChefByPhone(ev.from);
    if (!chef) {
      this.logger.warn(
        `No chef found for inbound phone ${ev.from} — payload "${ev.buttonPayload}" ignored`,
      );
      return;
    }

    if (action.kind === 'approve') {
      await this.handleApprove(chef.id, action.bookingId, ev.from);
    } else {
      await this.handleReject(chef.id, action.bookingId, ev.from);
    }
  }

  // ─── Button payload parsing ────────────────────────────

  /**
   * Pull (action, bookingId) out of an `APPROVE_<id>` / `REJECT_<id>`
   * quick-reply payload. Static so unit tests can poke it directly.
   *
   * Tolerates surrounding whitespace and unrecognised prefixes; never
   * throws. Returns null on anything that isn't one of the two
   * registered prefixes.
   */
  static parseButtonPayload(
    payload: string | undefined,
  ): { kind: 'approve' | 'reject'; bookingId: string } | null {
    if (!payload) return null;
    const trimmed = payload.trim();
    const approve = /^APPROVE_(.+)$/.exec(trimmed);
    if (approve) return { kind: 'approve', bookingId: approve[1] };
    const reject = /^REJECT_(.+)$/.exec(trimmed);
    if (reject) return { kind: 'reject', bookingId: reject[1] };
    return null;
  }

  // ─── Chef-by-phone resolution ──────────────────────────

  /**
   * Look up the chef User row by their inbound WhatsApp number.
   *
   * Phone-format normalisation problem
   * ----------------------------------
   * Meta delivers `from` in E.164 digits-only ("919876543210"). User
   * .phone may be stored in any of:
   *   - Legacy local 10-digit ("9876543210")
   *   - With +91 prefix ("+919876543210")
   *   - With country code, no + ("919876543210")
   *   - With separators (" 91 98765 43210", "+91-98765-43210")
   *
   * We compare on the LAST 10 DIGITS of the digits-only forms so all
   * variants converge to the same identity. Postgres' `regexp_replace`
   * lets us do the strip in SQL — no in-memory scan.
   *
   * Refusal mode: if the last-10 match returns 0 or >1 chefs, we
   * refuse and log. Multiple chefs sharing a phone shouldn't happen
   * but defending against the misconfigured-test-data class of bug
   * is cheap insurance against an attack surface where that ambiguity
   * could be exploited.
   *
   * Performance note: `regexp_replace` is an indexable expression in
   * Postgres but we're not yet creating an expression index — at
   * <1000 chefs this is sub-millisecond. When the chef base crosses
   * 10k consider adding `CREATE INDEX users_phone_digits_idx ON users
   * (regexp_replace(phone, '[^0-9]', '', 'g'))`.
   */
  private async findChefByPhone(fromE164: string): Promise<User | null> {
    const last10 = String(fromE164).replace(/\D/g, '').slice(-10);
    if (last10.length !== 10) return null;

    const matches = await this.usersRepo
      .createQueryBuilder('u')
      .where('u.role = :role', { role: UserRole.COOK })
      .andWhere('u.phone IS NOT NULL')
      .andWhere(
        "regexp_replace(u.phone, '[^0-9]', '', 'g') LIKE :pattern",
        { pattern: `%${last10}` },
      )
      .getMany();

    if (matches.length === 0) return null;
    if (matches.length > 1) {
      this.logger.warn(
        `Phone ${fromE164} matched ${matches.length} chefs — refusing for safety`,
      );
      return null;
    }
    return matches[0];
  }

  // ─── Action handlers ───────────────────────────────────

  private async handleApprove(
    chefUserId: string,
    bookingId: string,
    fromE164: string,
  ): Promise<void> {
    try {
      await this.bookingsService.acceptBooking(bookingId, chefUserId);
      this.logger.log(
        `Chef ${chefUserId} accepted booking ${bookingId} via WhatsApp`,
      );
      // Phase 4 will emit the chef-confirmation template here. Phase 3
      // intentionally stops at the state transition — keeps the diff
      // focused.
    } catch (err: any) {
      await this.replyOnTransitionFailure(
        fromE164,
        bookingId,
        err,
        'accept',
      );
    }
  }

  private async handleReject(
    chefUserId: string,
    bookingId: string,
    fromE164: string,
  ): Promise<void> {
    try {
      await this.bookingsService.rejectBooking(bookingId, chefUserId, {
        // Default reason for WhatsApp-driven rejections. The chef is
        // tapping a quick-reply button; we have no opportunity to ask
        // them to type a reason. The admin-only `rejection_reason`
        // column gets this string so it's clear in dashboards which
        // rejections came via WhatsApp.
        reason: 'Declined via WhatsApp',
      });
      this.logger.log(
        `Chef ${chefUserId} rejected booking ${bookingId} via WhatsApp`,
      );
    } catch (err: any) {
      await this.replyOnTransitionFailure(
        fromE164,
        bookingId,
        err,
        'reject',
      );
    }
  }

  /**
   * Friendly text reply when a chef's button tap can't be applied.
   *
   * Free-text WhatsApp messages are ONLY allowed inside a 24-hour
   * customer-care window — i.e. when the user has messaged us in the
   * last 24h. The chef tapping a button counts as a message, so we
   * are inside the window by definition at this call site. Outside
   * of that 24h boundary Meta would reject the send; in that case
   * the WhatsApp service silently no-ops (sendText returns false)
   * and the chef just doesn't see a reply — they can refresh the
   * dashboard and figure it out from there.
   *
   * We deliberately use generic copy + don't surface the booking ID
   * or the underlying error message — keeps the chef's WhatsApp
   * thread clean and avoids leaking internal state.
   */
  private async replyOnTransitionFailure(
    fromE164: string,
    bookingId: string,
    err: unknown,
    intent: 'accept' | 'reject',
  ): Promise<void> {
    const msg = (err as Error)?.message || '';
    this.logger.warn(
      `Chef ${intent} via WhatsApp failed for booking ${bookingId}: ${msg}`,
    );

    if (!this.whatsapp.isConfigured()) return;

    const reply =
      intent === 'accept'
        ? "We couldn't apply your acceptance — that booking may have already been actioned, expired, or cancelled. Please open the CookOnCall app to check."
        : "We couldn't apply your decline — that booking may have already been actioned, expired, or cancelled. Please open the CookOnCall app to check.";

    await this.whatsapp.sendText(fromE164, reply, bookingId).catch(() => undefined);
  }
}
