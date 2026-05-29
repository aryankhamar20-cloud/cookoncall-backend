# CookOnCall Cross-Platform Parity Matrix

Generated 2026-05-29 from the merged `main` of all three repos:

- `cookoncall-backend` — NestJS, source of truth for the API contract.
- `cookoncall` — Next.js web app (customer + cook + admin).
- `cookoncall-flutter` — Flutter mobile (customer + cook only; admin is web-only by design).

Method: read every backend controller, every web `api.ts` export const, and every
Flutter file calling `dioProvider` to enumerate actual route consumption. This is
not a feature wish list — every check mark is a real call site.

Status legend:

- ✅ Fully covered — calls the route and exercises the feature.
- 🟡 Partially covered — some sub-features wired, others missing.
- ❌ Not covered — no call site found.
- 🔒 Intentionally out of scope (e.g. admin features on Flutter).

---

## Summary

| Category | Backend | Web | Flutter | Notes |
|---|---|---|---|---|
| Authentication (email + Google) | ✅ | ✅ | ✅ | Refresh token bug fixed in PR #18 |
| Authentication (phone OTP) | ✅ | ✅ | ❌ | **Gap: Flutter doesn't expose phone OTP login** |
| Authorization (RBAC) | ✅ | ✅ | ✅ | Backend hardened in PRs #15, #16, #17, #20 |
| OTP — booking start/end | ✅ | ✅ | ✅ | Both clients drive the cooking-session OTP flow |
| Bookings — full lifecycle | ✅ | ✅ | ✅ | Includes accept/reject/rebook/refund-estimate |
| Payments — Razorpay | ✅ | ✅ | ✅ | Webhook is server-only |
| Reviews | ✅ | ✅ | 🟡 | **Flutter posts reviews but doesn't show chef-side received reviews** |
| Notifications — list + mark | ✅ | ✅ | ✅ | |
| Notifications — settings | ✅ | ✅ | ✅ | Push/email/SMS toggles |
| Notifications — broadcast (admin) | ✅ | ✅ | 🔒 | Admin-only; intentionally web-only |
| Analytics | ✅ | ✅ | 🔒 | Admin-only |
| Admin features | ✅ | ✅ | 🔒 | `admin_home_screen.dart` is an explicit "use web" stub |
| Chef features — profile/menu/availability | ✅ | ✅ | ✅ | |
| Chef features — meal packages | ✅ | ✅ | ✅ | |
| Chef features — verification (KYC docs) | ✅ | ✅ | ✅ | |
| Chef features — service area | ✅ | ✅ | 🟡 | **Flutter has the screen but no API call for areas list** |
| Chef features — broadcast/CTR | ✅ | ✅ | 🔒 | Admin |
| Customer features — search/book/profile | ✅ | ✅ | ✅ | |
| Customer features — addresses CRUD | ✅ | ✅ | ✅ | |
| Customer features — areas list | ✅ | ✅ | ✅ | |
| Customer features — promo code (apply/validate) | ✅ | ✅ | ❌ | **Gap: no Flutter promo-code flow** |
| Referral system | ✅ | ✅ | 🟡 | **Flutter has /my-code but no /apply** |
| Earnings | ✅ | ✅ | ✅ | |
| Payouts (chef) | ✅ | ✅ | ❌ | **Gap: Flutter doesn't show payout history** |
| Page-view tracking (Phase 3) | ✅ | ✅ | ❌ | Optional — only relevant if mobile funnel analytics is wanted |
| Error reporting (Sentry frontend log forwarding) | ✅ | ✅ | ✅ | |
| Pincode lookup (India Post helper) | n/a | ✅ | ❌ | Web has a tiny `lookupPincode()` helper; Flutter doesn't (likely fine for now) |

---

## Detailed gaps (actionable — each is its own follow-up issue)

### G1 — Flutter is missing phone-OTP login

**Backend routes:** `POST /auth/send-otp`, `POST /auth/verify-otp` (both `@Public`).
**Web:** wired (`authApi.sendOtp`, `authApi.verifyOtp`).
**Flutter:** has email-OTP and Google sign-in flows, but no phone-OTP. The `otp_screen.dart` is wired only for email verification, not phone login.

**Why this matters:** SMS-OTP is the dominant Indian login flow. Most CookOnCall customers will land on Flutter. Forcing them through email-OTP / Google adds friction that competitors don't.

**Effort:** ~1 day. Add phone-entry screen, plumb to `auth_repository.sendOtp/verifyOtp`, integrate into existing OTP UI (`otp_screen.dart` is already shaped for this).

### G2 — Flutter doesn't show chef-side received reviews

**Backend:** `GET /reviews/cook/me/received` (paginated, with aggregate stats — rating histogram, avg, total).
**Web:** wired (`cooksApi.getMyReviewsReceived`) — used in cook dashboard "My Reviews" panel.
**Flutter:** the screen `cook_reviews_screen.dart` exists but doesn't call the API.

**Why this matters:** chefs need to see their reviews on the platform they actually use. If they're on mobile-only (likely for many chefs), they're flying blind.

**Effort:** ~half day. The endpoint already returns everything needed; just wire it.

### G3 — Flutter has no promo-code flow

**Backend:** `POST /promo-codes/validate` (any authenticated user) for the customer pre-checkout flow. `referrals/apply` for first-booking referral discount.
**Web:** wired in `BookingModal.tsx` (customer enters a code, validate fires, discount applied).
**Flutter:** no validate call anywhere. Customers on mobile cannot use a promo code.

**Why this matters:** Direct revenue feature. Marketing campaigns that hand out codes only reach web users.

**Effort:** ~half day. Add a "have a promo code?" field in the booking sheet, call validate, surface the discount. Pattern exists on web (`PromoCode` validation block).

### G4 — Flutter doesn't show chef payout history

**Backend:** `GET /cooks/me/payouts` (paginated; per-booking gross/commission/net + lifetime totals).
**Web:** wired (`cooksApi.getMyPayouts`) — used in `EarningsHistoryPanel.tsx`.
**Flutter:** earnings summary is shown (`/cooks/me/earnings`), but the per-booking payout breakdown isn't.

**Why this matters:** chefs question payouts. Without itemized history they have to trust a number. Easy to drive support tickets.

**Effort:** ~half day. Extend the chef earnings screen with a paginated list section.

### G5 — Flutter referral flow is half-implemented

**Backend:** `GET /referrals/my-code` + `POST /referrals/apply`.
**Web:** wired both.
**Flutter:** `referral_screen.dart` calls `/referrals/my-code` (so the user can see their own code) but `/apply` is never called — there's no UI surface for entering someone else's code.

**Why this matters:** Half a referral system. Existing users have a code to share; new users have no way to redeem one. The acquisition loop is broken on mobile.

**Effort:** ~half day. Add a "had a friend invite you?" prompt during onboarding or first booking. Call `/referrals/apply` once.

### G6 — Flutter chef service-area screen is UI-only

**Backend:** `GET /areas` (list active areas) and area-specific fee config on the chef profile.
**Web:** wired.
**Flutter:** `cook_service_area_screen.dart` exists (286 lines of UI) but doesn't call `/areas` or the chef-area-fees update endpoint.

**Why this matters:** Chefs on Flutter cannot configure where they serve. They appear with default settings forever.

**Effort:** ~half day to 1 day depending on whether the screen needs UI changes.

### G7 — Page-view tracking on Flutter

**Backend:** `POST /events` (public, accepts anonymous events).
**Web:** wired (`PageViewTracker.tsx` fires on every route change).
**Flutter:** no event tracking. So all funnel analytics in the admin dashboard are web-only.

**Effort:** ~quarter day. Add a Flutter route observer that fires `eventsApi.track` on screen changes. Optional — only worth it if the team intends to compare web vs mobile funnel.

---

## Web-only by design (no parity gap)

These are intentional and don't need Flutter implementations:

- **All `/admin/*` routes** — Flutter `admin_home_screen.dart` literally says "Admin panel is web-only. This screen is a redirect stub for mobile admins."
- **Analytics CSV / PDF export** — admin-only, web-only.
- **Audit log** — admin-only.
- **Broadcast push composer** — admin-only.
- **Promo-code management UI** — admin-only.
- **Area approval workflow** — admin-only.

---

## Backend routes with no client consumer (orphaned)

Routes the backend exposes that nobody currently calls. These aren't bugs but are worth noting — they're either retired, never-shipped, or only invoked server-side:

| Route | Notes |
|---|---|
| `POST /payments/webhook` | Razorpay-side; not called by clients (correct) |
| `GET /payments/booking/:bookingId` | Not used by web or Flutter; service tooling? |
| `POST /errors` (frontend log forward) | Web has `lib/sentry.ts` but only forwards to Sentry directly, not to this endpoint |
| `GET /errors` (admin-only error log list) | Backend has it; no admin panel surfaces it yet |
| `GET /availability/me` | Cook reads schedule — wired in cook detail screen on Flutter, but the controller path is shared |
| `GET /admin/recent-users` / `recent-bookings` | Web admin dashboard uses these |

---

## Recommended sprint plan

If we want to close the Flutter parity gaps, ordered by ROI:

| # | Gap | Effort | Why first |
|---|---|---|---|
| 1 | G3 — Flutter promo-code validate | 0.5d | Direct revenue, marketing campaigns blocked otherwise |
| 2 | G1 — Flutter phone-OTP login | 1d | Removes friction on the dominant Indian login path |
| 3 | G2 — Flutter chef received reviews | 0.5d | Chef trust / support deflection |
| 4 | G4 — Flutter chef payout history | 0.5d | Chef trust / support deflection |
| 5 | G5 — Flutter referral apply | 0.5d | Closes the acquisition loop |
| 6 | G6 — Flutter chef service-area config | 1d | Enables more chef self-service, less admin work |
| 7 | G7 — Flutter event tracking | 0.25d | Optional — only if mobile funnel analytics is needed |

Total: ~4.25 days of focused work to reach full Flutter feature parity for everything that should be there.

---

## How to keep this matrix honest

Two automated guards I recommend (not in this PR):

1. **CI step that diffs `endpoints.json`** — generate from the backend at build time, fail PR if a new route lands without a comment indicating intended web/Flutter coverage.
2. **Endpoint-coverage report** — extend the Jest suite to print all `controller @Get/@Post` decorators, then cross-reference against a static list of known web/Flutter call sites. Surface drift in the PR check.

---

_Generated by audit; verified manually file-by-file. Last updated: 2026-05-29._
