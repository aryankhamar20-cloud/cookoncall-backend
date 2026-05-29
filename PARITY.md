# CookOnCall Cross-Platform Parity Matrix

Generated 2026-05-29. Updated 2026-05-29 with corrections after closer audit.

- `cookoncall-backend` — NestJS, source of truth for the API contract.
- `cookoncall` — Next.js web app (customer + cook + admin).
- `cookoncall-flutter` — Flutter mobile (customer + cook only; admin is web-only by design).

Method: read every backend controller, every web `api.ts` export const, and every
Flutter file calling `dioProvider` to enumerate actual route consumption. Every
check mark is a real call site.

> **Corrections from the first version of this doc:** Three claimed "Flutter
> parity gaps" (G1 phone OTP, G3 promo-code, G5 referral apply) were wrong —
> those features are missing on **both** web and Flutter, so they're feature
> gaps, not parity gaps. They've been moved to a "neither client uses this"
> table below. The two genuine parity gaps (G2 chef received reviews, G4 chef
> payouts) are still listed and have been shipped — see PRs at the bottom.

Status legend:

- ✅ Fully covered.
- 🟡 Partially covered.
- ❌ Not covered.
- 🔒 Intentionally out of scope (e.g. admin features on Flutter).
- 🚫 Backend exposes it but **no client uses it** (orphaned endpoint).

---

## Summary — verified state

| Category | Backend | Web | Flutter | Notes |
|---|---|---|---|---|
| Authentication (email + Google) | ✅ | ✅ | ✅ | Refresh-token bug fixed in PR #18 (flutter) |
| Authentication (email OTP) | ✅ | ✅ | ✅ | |
| Authentication (phone OTP) | ✅ | 🚫 | 🚫 | **Backend has it; neither client uses it.** Originally listed as a Flutter gap — wrong, web doesn't use it either. |
| Authorization (RBAC) | ✅ | ✅ | ✅ | Backend hardened in PRs #15, #16, #17, #20 |
| OTP — booking start/end | ✅ | ✅ | ✅ | Both clients drive the cooking-session OTP flow |
| Bookings — full lifecycle | ✅ | ✅ | ✅ | Includes accept/reject/rebook/refund-estimate |
| Payments — Razorpay | ✅ | ✅ | ✅ | Webhook is server-only; HMAC verify locked in by tests #18, #22 |
| Reviews — submit | ✅ | ✅ | ✅ | |
| Reviews — chef-side received list | ✅ | ✅ | ✅ | Flutter wired by **PR #20** (was hitting wrong endpoint) |
| Notifications — list + mark | ✅ | ✅ | ✅ | |
| Notifications — settings | ✅ | ✅ | ✅ | Push/email/SMS toggles |
| Notifications — broadcast (admin) | ✅ | ✅ | 🔒 | Admin-only |
| Analytics | ✅ | ✅ | 🔒 | Admin-only |
| Admin features | ✅ | ✅ | 🔒 | `admin_home_screen.dart` is an explicit "use web" stub |
| Chef — profile/menu/availability | ✅ | ✅ | ✅ | |
| Chef — meal packages | ✅ | ✅ | ✅ | |
| Chef — verification (KYC docs) | ✅ | ✅ | ✅ | |
| Chef — service area config | ✅ | ✅ | 🟡 | Flutter has the screen but doesn't call `/areas` or `/cooks/me` for fee config |
| Customer — search/book/profile | ✅ | ✅ | ✅ | |
| Customer — addresses CRUD | ✅ | ✅ | ✅ | |
| Customer — areas list | ✅ | ✅ | ✅ | |
| Customer — promo-code redeem | ✅ | 🚫 | 🚫 | **Backend has it; neither client uses it.** Originally listed as a Flutter gap — wrong. The booking DTO doesn't even accept a promo code yet. This is a feature that needs full-stack work, not a parity fix. |
| Referral system — share my code | ✅ | 🚫 | ✅ | Flutter calls `/referrals/my-code`; web does **not** consume any referral endpoint |
| Referral system — apply someone else's | ✅ | 🚫 | 🚫 | Originally claimed as a "Flutter referral half-implemented" gap; in fact web has nothing referral-related either |
| Earnings — totals | ✅ | ✅ | ✅ | |
| Payouts — chef per-booking history | ✅ | ✅ | ✅ | Flutter wired by **PR #19** (was missing entirely) |
| Page-view tracking (Phase 3) | ✅ | ✅ | ❌ | Optional — only relevant if mobile funnel analytics is wanted |
| Error reporting (Sentry) | ✅ | ✅ | ✅ | |
| Pincode lookup helper | n/a | ✅ | ❌ | Web has a tiny `lookupPincode()` helper; Flutter doesn't (likely fine) |

---

## Real Flutter parity gaps

### G2 — Chef received-reviews screen ✅ SHIPPED

**Status:** Fixed in **[PR #20](https://github.com/aryankhamar20-cloud/cookoncall-flutter/pull/20)**.

The Flutter `cook_reviews_screen.dart` was hitting `GET /reviews/me` (the customer-side "reviews I've written" endpoint, almost always empty for chefs) instead of `GET /reviews/cook/me/received` (the chef-side "reviews customers have left for me" endpoint that web uses). Pure URL fix; the existing parsing already matched the chef-side response shape. `api_constants.dart` even declared `cookReviewsReceived` — it was just never called.

### G4 — Chef payout history ✅ SHIPPED

**Status:** Implemented in **[PR #19](https://github.com/aryankhamar20-cloud/cookoncall-flutter/pull/19)**.

Adds `CookPayout`/`CookPayoutsSummary`/`CookPayoutsPage` models, a paginated `getPayouts(page, limit, statusFilter)` repo method, a new `cook_payouts_screen.dart` showing summary cards + per-booking breakdown + load-more pagination, and a "View detailed payout history" link on the existing Earnings tab.

### G6 — Chef service-area config 🟡 STILL OPEN

The Flutter `cook_service_area_screen.dart` exists (286 lines of UI) but doesn't call `/areas` or the chef-area-fees update endpoint. Chefs on Flutter can't configure where they serve. Effort: ~half day to 1 day. Not yet shipped.

---

## Items I originally listed as Flutter gaps but are actually backend-feature-not-fully-wired-anywhere

| ID | Item | Verified state | What's actually needed |
|---|---|---|---|
| ~~G1~~ | Phone-OTP login | Backend has `POST /auth/send-otp` + `verify-otp` (`@Public`), but **neither web nor Flutter consumes them**. Web only uses email OTP. | Pick a client (or both), wire the SMS-OTP UX. Not a parity-closing PR. |
| ~~G3~~ | Customer promo-code redeem | Backend has `POST /promo-codes/validate` (any auth user), but `CreateBookingDto` has **zero promo fields** and `bookings.service.createBooking` never references promos. **No client uses validate either.** Web's `BookingModal.tsx` has zero promo references. | Full-stack feature: extend `CreateBookingDto`, plumb discount through bookings.service, **then** wire either client. |
| ~~G5~~ | Referral `/apply` | Backend has it. Flutter calls `/referrals/my-code` but not `/apply`. **Web has zero referral consumers** — no my-code, no apply. So Flutter is actually *ahead* of web on referrals. | Decide product intent (web parity, or just Flutter loop completion), then wire. |

These are real feature gaps but they need to be discussed as **product features**, not classified as "Flutter falling behind web."

---

## Web-only by design (no parity gap)

These are intentional and don't need Flutter implementations:

- All `/admin/*` routes — `admin_home_screen.dart` literally says "Admin panel is web-only."
- Analytics CSV / PDF export, audit log, broadcast push composer, promo-code management UI, area approval workflow.

---

## Backend routes with no client consumer (orphaned)

| Route | Notes |
|---|---|
| `POST /payments/webhook` | Razorpay-side; not called by clients (correct) |
| `GET /payments/booking/:bookingId` | Not used by web or Flutter |
| `POST /errors` | Frontend log forward — neither client routes errors here |
| `GET /errors` | Admin-only error log list — no admin panel surface yet |
| `POST /auth/send-otp` / `verify-otp` | Phone-OTP, see ~~G1~~ above |
| `POST /promo-codes/validate` | Customer promo redeem, see ~~G3~~ above |
| `POST /referrals/apply` | Referral redeem, see ~~G5~~ above |

---

## What's left after PRs #19, #20

Real Flutter parity gaps remaining:

| # | Gap | Effort |
|---|---|---|
| G6 | Flutter chef service-area config (UI exists, no API calls) | ~0.5–1 day |
| G7 | Flutter page-view tracking (optional) | ~0.25 day |

Backend-feature-not-fully-wired (not parity gaps):

| Item | Effort | Notes |
|---|---|---|
| Phone-OTP wiring (web + Flutter) | ~1 day each | If India SMS-OTP is desired flow |
| Promo-code customer flow (full-stack) | ~2 days | Backend booking integration + both clients |
| Referral apply flow (web + Flutter) | ~0.5–1 day | Web has nothing today; Flutter has half |

---

## How to keep this matrix honest

1. **CI step that diffs `endpoints.json`** — generate from the backend at build time, fail PR if a new route lands without a comment indicating intended web/Flutter coverage.
2. **Endpoint-coverage report** — extend the Jest suite to print all `controller @Get/@Post` decorators, then cross-reference against a static list of known web/Flutter call sites. Surface drift in the PR check.

---

_Last updated: 2026-05-29 (post-corrections)._
