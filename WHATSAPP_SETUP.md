# WhatsApp Setup Runbook

Operational guide for provisioning, configuring, and maintaining the
CookOnCall WhatsApp Business integration. Use this when you need to:

- Bring WhatsApp online for the first time on a new environment
- Rotate the access token, app secret, or verify token
- Register a new template
- Diagnose a delivery failure
- Swap providers (Meta Cloud → Twilio / MSG91 / Gupshup)

The integration code lives at `src/modules/whatsapp/`. Provider-agnostic
abstraction; current implementation is Meta WhatsApp Cloud API.

---

## Table of contents

1. [One-time provisioning](#1-one-time-provisioning)
2. [Webhook configuration](#2-webhook-configuration)
3. [Template registration](#3-template-registration)
4. [Going live](#4-going-live-railway)
5. [Verifying it works](#5-verifying-it-works)
6. [Troubleshooting](#6-troubleshooting)
7. [Rotation procedures](#7-rotation-procedures)
8. [Adding a new template](#8-adding-a-new-template)
9. [Swapping providers](#9-swapping-providers)
10. [Reference](#10-reference)

---

## 1. One-time provisioning

You'll need a Meta Business Manager account, a verified phone number,
and a permanent access token. ~1–3 days end-to-end including Meta's
business-verification queue.

### Step 1 — Meta Business Manager

If you don't already have one, create at https://business.facebook.com.
The CookOnCall account is owned by the founders.

### Step 2 — WhatsApp Business Account (WABA)

1. Meta Business → **WhatsApp Manager** → **Get Started** (if first time)
2. Add a phone number that will be the business "from" number.
   - **Critical:** the number cannot already be active on personal
     WhatsApp. If the founders' personal number is on WhatsApp, get a
     new DID (e.g. via a Twilio number or a fresh SIM).
   - Verify via OTP (SMS or voice).
3. Set the display name (recommended: `CookOnCall`).
4. Wait for Meta business verification (1–3 days). Until verified you
   can send to a small allowlist of test recipients only — fine for
   QA but not for production.

### Step 3 — Meta Developer App

1. https://developers.facebook.com/apps/ → **Create App** → **Business**
2. Add the **WhatsApp** product.
3. Link the WABA from Step 2.

### Step 4 — Collect the four credentials

| Env var | Where to find it |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | App → WhatsApp → API Setup → "Phone Number ID" (NOT the phone number itself, NOT the WABA ID) |
| `WHATSAPP_ACCESS_TOKEN` | App → WhatsApp → Configuration → Generate **permanent system-user access token** (NOT the 24-hour temporary one — that breaks in dev tomorrow) |
| `WHATSAPP_VERIFY_TOKEN` | A random string you choose. Generate with: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` |
| `WHATSAPP_APP_SECRET` | App → Settings → Basic → "App Secret" → click **Show** |

**Treat all four as top-priority secrets.** The Access Token alone
gives full send permissions on the WABA; the App Secret signs every
inbound webhook (a leak lets an attacker forge state-mutating button
taps).

---

## 2. Webhook configuration

This wires Meta to deliver inbound messages (chef button taps, status
receipts) to our backend.

### Step 1 — Set the callback URL

App → WhatsApp → Configuration → Webhook → **Edit**

| Field | Value |
|---|---|
| Callback URL | `https://api.thecookoncall.com/api/v1/webhooks/whatsapp` |
| Verify Token | The same string you put in `WHATSAPP_VERIFY_TOKEN` |

Click **Verify and Save**. Meta sends a `GET /webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=<x>&hub.challenge=<y>`
to our endpoint. The backend echoes `<y>` back as `text/plain` 200 IFF
the verify token matches. On success Meta reports "Verified".

If verification fails:
- 403 → token mismatch. Check `WHATSAPP_VERIFY_TOKEN` is set in Railway
  AND matches what you typed in Meta's form.
- timeout / 5xx → check the API is reachable at the callback URL. The
  endpoint must be HTTPS with a valid certificate.
- 200 with the wrong body → the global `TransformInterceptor` is
  wrapping the response. Confirm the controller uses `@Res()` to write
  the raw challenge string (it should — see `whatsapp-webhook.controller.ts`).

### Step 2 — Subscribe to the `messages` field

Same Configuration page → **Webhook fields** → click **Manage**.

Subscribe ONLY to **`messages`**. This delivers:
- Inbound text from users
- Quick-reply button taps (the chef's Approve/Decline)
- Delivery + read receipts (`statuses` field — surfaced as `type='status'`
  in our parser)

Other fields (account_review_update, message_template_status_update,
phone_number_quality_update) are admin-side concerns; subscribe later
if you want template-approval notifications in code.

---

## 3. Template registration

Every business-initiated message must use a Meta-approved template.
Approval is typically 1–24 hours but can take up to 7 days.

WhatsApp Manager → **Message Templates** → **Create Template**.

For each template:
- **Category** = **Utility** (transactional). NOT marketing — Meta has
  stricter quality scoring for marketing.
- **Language** = **English (en)**.
- Variables use `{{N}}` syntax. The N must be sequential starting from 1.

### 3.1 — `chef_booking_request`

Goes to the chef when a customer creates a booking. **Has 2 quick-reply
buttons** that route into our webhook.

**Header** (optional): None
**Body**:

```
Hi {{1}}, you have a new booking request from {{2}}.

Booking ID: #{{3}}
Date: {{4}}
Time: {{5}}
Address: {{6}}
Estimated total: ₹{{7}}

Please respond within 3 hours — after that the request expires automatically.
```

**Footer** (optional): `CookOnCall — Home cooking, on call.`

**Buttons** — exactly two quick-reply buttons in this order:

| Order | Button text | Notes |
|---|---|---|
| 1 | `Approve` | Maps to `APPROVE_<bookingId>` payload at send time |
| 2 | `Decline` | Maps to `REJECT_<bookingId>` payload at send time |

The button **text** is what the chef sees and taps. The button
**payload** is what gets delivered to our webhook. Our code generates
the payload at send time (`templates.ts` `CHEF_BOOKING_REQUEST.buttons
= ['APPROVE_', 'REJECT_']` is a prefix; we append the bookingId before
calling Meta).

**Variables to provide in Meta's template editor preview:**
| Var | Sample |
|---|---|
| `{{1}}` chef_name | `Chef Anjali` |
| `{{2}}` customer_name | `Riya` |
| `{{3}}` booking_id_short | `ABC12345` |
| `{{4}}` date_str | `Saturday, June 15, 2026` |
| `{{5}}` time_str | `07:30 PM` |
| `{{6}}` address_short | `Flat 4B, Sky Heights, Ahmedabad` |
| `{{7}}` total_str | `1,234` |

### 3.2 — `customer_booking_confirmed`

Goes to the customer when the chef accepts.

**Body**:

```
Hi {{1}}, {{2}} accepted your booking — you're all set!

Date: {{3}}
Time: {{4}}
Booking ID: #{{5}}

Payment is optional and due any time before your session ends. You can pay any time from the CookOnCall app under Orders → Pay.

If you already paid, please ignore this message.
```

**Footer** (optional): `CookOnCall — Home cooking, on call.`

**Variables:**
| Var | Sample |
|---|---|
| `{{1}}` customer_name | `Riya` |
| `{{2}}` chef_name | `Chef Anjali` |
| `{{3}}` date_str | `Saturday, June 15, 2026` |
| `{{4}}` time_str | `07:30 PM` |
| `{{5}}` booking_id_short | `ABC12345` |

### 3.3 — `chef_booking_confirmed`

Goes to the chef AFTER they accept (regardless of channel — web, mobile,
or WhatsApp button tap). Without this template the chef sees their
own button tap in WhatsApp and then silence; this is the visible "we
got your accept" receipt.

**Body**:

```
Hi {{1}}, your booking with {{2}} is confirmed.

Date: {{3}}
Time: {{4}}
Booking ID: #{{5}}

See you at the session! Open the CookOnCall app for any updates or to message the customer.
```

**Footer** (optional): `CookOnCall — Home cooking, on call.`

**Variables:**
| Var | Sample |
|---|---|
| `{{1}}` chef_name | `Chef Anjali` |
| `{{2}}` customer_name | `Riya` |
| `{{3}}` date_str | `Saturday, June 15, 2026` |
| `{{4}}` time_str | `07:30 PM` |
| `{{5}}` booking_id_short | `ABC12345` |

### 3.4 — `customer_booking_rejected`

Goes to the customer when the chef declines.
**No reason exposed** — matches the email contract; reason stays in
the admin-only `bookings.rejection_reason` column.

**Body**:

```
Hi {{1}}, unfortunately {{2}} could not accept your booking this time. No payment has been taken.

Open the CookOnCall app to book another chef at no extra charge.
```

**Footer** (optional): `CookOnCall — Home cooking, on call.`

**Variables:**
| Var | Sample |
|---|---|
| `{{1}}` customer_name | `Riya` |
| `{{2}}` chef_name | `Chef Anjali` |

### Template approval timing

- Submit all 4 at once.
- Most approve in 1–24 hours.
- If a template is **rejected**, the rejection reason shows in the
  template list (hover the status). Common reasons:
  - "Promotional language in Utility category" — soften the copy.
  - "Variables at start/end of body" — must have static text bracketing.
  - "Special characters in variable position" — don't put `{{1}}` as
    the very first or last token of the body.

If a template is approved with a different name than what we registered
(unlikely but possible), update `src/modules/whatsapp/templates.ts` to
match. Meta does not allow template renames.

---

## 4. Going live (Railway)

Once all 4 templates are **Approved** (not Pending, not Rejected),
paste the four credentials into Railway:

```
WHATSAPP_PHONE_NUMBER_ID=<from step 4>
WHATSAPP_ACCESS_TOKEN=<from step 4>
WHATSAPP_VERIFY_TOKEN=<from step 4>
WHATSAPP_APP_SECRET=<from step 4>
```

Optional:
```
WHATSAPP_API_VERSION=v20.0          # bump when Meta deprecates
WHATSAPP_DEFAULT_COUNTRY_CODE=91    # default for stripping/prepending
```

Railway auto-redeploys on env var change. The backend now:
- `MetaCloudWhatsAppProvider.isConfigured()` returns `true`
- Outbound chef request, customer/chef confirmations, customer
  rejections all start sending on the next booking lifecycle event
- Inbound webhook now passes signature verification on real Meta
  deliveries

**No code change is needed to switch over.** The integration is
designed to no-op when env is unset and go live on the next deploy
when env appears.

---

## 5. Verifying it works

After Railway redeploys with the new env, run this end-to-end check:

### 5.1 — Webhook reachability

In Meta App → WhatsApp → Configuration, click **Verify and Save**
again on the callback URL. Should immediately confirm. If 403 here,
check `WHATSAPP_VERIFY_TOKEN` matches the value in Meta's form.

### 5.2 — Outbound chef request

1. Place a test booking from a customer account on a chef whose phone
   is registered on WhatsApp.
2. Chef should receive a WhatsApp message within seconds.
3. The message should have the **Approve** + **Decline** buttons.

If the chef doesn't receive:
- Check Railway logs for `WhatsApp not configured — skipping template`
  → env vars missing or didn't take effect (re-check Railway env, then
  redeploy).
- Check Railway logs for `WhatsApp chef-request failed` → look at the
  underlying error (usually a Meta API error code).
- Check the chef's User row has a phone number stored: `SELECT id,
  email, phone, whatsapp_enabled FROM users WHERE role = 'cook' AND
  email = '<chef_email>';`. `phone` must be present and `whatsapp_enabled`
  must be `true`.

### 5.3 — Inbound button tap

1. Chef taps **Approve** in WhatsApp.
2. Within ~1 second the booking should flip to CONFIRMED in the admin
   dashboard.
3. The customer should receive a WhatsApp confirmation + email.
4. The chef should also receive a follow-up confirmation template.

If the booking doesn't flip:
- Check Railway logs for `Refusing inbound WhatsApp webhook — bad
  signature` → `WHATSAPP_APP_SECRET` is wrong or doesn't match the
  Meta App's secret.
- Check Railway logs for `No chef found for inbound phone <number>`
  → the chef's User.phone in our DB doesn't match the from number's
  last 10 digits. Update the User row's `phone` column.
- Check Railway logs for `Phone <number> matched <N> chefs — refusing`
  → two User rows share the same phone last-10-digits. Investigate the
  duplicate and clean up.

### 5.4 — Decline path

1. Place another test booking.
2. Chef taps **Decline** in WhatsApp.
3. Booking should flip to CANCELLED_BY_COOK with `rejection_reason
   = 'Declined via WhatsApp'`.
4. Customer should receive a WhatsApp rejection (no reason exposed)
   + email.

---

## 6. Troubleshooting

### Outbound

| Symptom | Likely cause | Fix |
|---|---|---|
| `WhatsApp not configured — skipping template` in logs | One of the 4 env vars is missing | Re-check Railway env. All four must be set for `isConfigured()` to return true. |
| `Invalid phone for WhatsApp template` | Chef's User.phone is empty or unparseable | Update the User row. The normaliser accepts `9876543210`, `+919876543210`, `09876543210`, etc. |
| `Template "X" expects N vars, got M` | We're calling with wrong arity | Mismatch between code and Meta-registered template. Check `templates.ts` vs Meta dashboard. |
| Chef gets the message but it shows `<unsupported message type>` | Template was rejected by Meta but our code doesn't know | Check WhatsApp Manager → Message Templates → status. If rejected, fix and resubmit (or rename + register a new version). |
| Meta returns `131026 — Recipient is not a valid WhatsApp user` | Chef's phone isn't on WhatsApp | Skip; fall back to email. Logged at `error` level. |
| Meta returns `131047 — Re-engagement message` | Customer hasn't messaged us in 24h and we tried to send free text | Use a template, not `sendText`. (Outbound flow already does; this only affects Phase 3 webhook reply path.) |

### Inbound

| Symptom | Likely cause | Fix |
|---|---|---|
| `Refusing inbound WhatsApp webhook — bad signature` | `WHATSAPP_APP_SECRET` is wrong | Re-copy from Meta App → Settings → Basic → App Secret. |
| `No chef found for inbound phone X` | Chef's User.phone in DB doesn't match | Update User.phone. Last-10-digit match is what we use; format doesn't matter. |
| `Phone X matched N chefs — refusing` | Duplicate phone numbers in our DB | Identify the duplicates: `SELECT id, email, phone FROM users WHERE replace(replace(replace(replace(phone, ' ', ''), '-', ''), '+', ''), '(', '') LIKE '%<last10>';` and fix the data. |
| `Skipping duplicate inbound <wamid>` | Meta retried delivery; we deduped correctly | No action needed. |
| Booking doesn't flip after chef tap, no log entry | Webhook URL not reachable from Meta, OR `messages` field not subscribed | Re-verify in Meta Configuration page; subscribe to `messages` field. |

### Templates

| Symptom | Likely cause | Fix |
|---|---|---|
| Template stuck in PENDING > 24h | Normal during heavy queue | Wait. If > 7 days, contact Meta support via the App dashboard. |
| Template REJECTED with "Promotional content" | Copy too marketing-y for Utility category | Soften — drop emojis, exclamation marks, "amazing", "now". |
| Template REJECTED with "Format error" | Variable at start/end of body | Add static text bracketing every `{{N}}`. |
| Sending fails with "Template not approved in language `en_US`" | We registered for `en` but Meta says `en_US` | Edit `templates.ts` for that template's `language` field to match what Meta accepted. |

---

## 7. Rotation procedures

### Access token rotation

Required when:
- A team member with token access leaves
- The token leaks (any pastebin / git commit / chat log)
- Annually as a hygiene measure

**Procedure:**
1. App → WhatsApp → Configuration → "System users" → existing token →
   **Revoke**.
2. Generate a new permanent system-user access token.
3. Paste new value into Railway → `WHATSAPP_ACCESS_TOKEN`.
4. Wait for redeploy (~30s).
5. Verify with a test send.

No downtime IF you do it in this order. The old token works until
revoked; the new one starts working when Railway redeploys with it.

### App secret rotation

Required when:
- The App Secret leaks
- Annually as a hygiene measure

**Procedure:**
1. App → Settings → Basic → App Secret → **Reset**.
2. Paste new value into Railway → `WHATSAPP_APP_SECRET`.
3. **Important:** there's a small window during which inbound webhooks
   fail signature verification (Meta will retry up to ~5 minutes; not
   long enough to drop a real chef tap, but long enough to get
   alerting noise).
4. Verify with a test inbound (chef taps Approve in WhatsApp, booking
   flips).

### Verify token rotation

Low-stakes — verify token only matters during the GET handshake.

1. Choose a new random string.
2. Update Railway → `WHATSAPP_VERIFY_TOKEN`.
3. After redeploy, go to Meta App → WhatsApp → Configuration → Webhook
   → Edit → paste new value into "Verify Token" → **Verify and Save**.

Until step 3 the webhook still receives messages (verify token is
checked only on the GET handshake, not POST).

---

## 8. Adding a new template

Use this for the next round of WhatsApp surfaces (booking-completed,
review-prompt, payment-received, etc.).

1. **Pick a name.** Snake_case, descriptive, never reused. Meta does
   not allow renames; if you mess up the schema you create
   `<name>_v2`.
2. **Draft body + variables.** Document each `{{N}}` placeholder with
   its purpose. Match Meta's restrictions:
   - 1024 char body limit (variables count toward total)
   - No `{{N}}` at start or end of body
   - No special chars at variable position (no `*{{1}}*`)
   - Utility category for transactional, Marketing for promotional
3. **Add to `src/modules/whatsapp/templates.ts`.**
   ```typescript
   export const NEW_TEMPLATE_NAME: WhatsAppTemplateSpec = {
     name: 'new_template_name',
     language: 'en',
     vars: ['var1_purpose', 'var2_purpose', ...],
     buttons: ['BTN1_', 'BTN2_'], // omit if no buttons
   } as const;
   ```
4. **Register in Meta** (WhatsApp Manager → Message Templates →
   Create). Wait for approval.
5. **Wire into the platform** — call `WhatsAppService.sendTemplate({ template: NEW_TEMPLATE_NAME, vars: [...], ... })` from the right
   place in `NotificationsService` (or wherever — usually a notify*
   helper).
6. **Test end-to-end** before merging.

---

## 9. Swapping providers

The WhatsApp module is provider-agnostic. To replace Meta Cloud API
with Twilio / MSG91 / Gupshup / etc.:

1. Implement `WhatsAppProvider` interface
   (`src/modules/whatsapp/providers/whatsapp.provider.interface.ts`):
   - `isConfigured()`, `send()`, `verifySignature()`, `verifyChallenge()`,
     `parseInbound()`.
2. Add a new file e.g. `twilio.provider.ts` next to `meta-cloud.provider.ts`.
3. Edit `whatsapp.module.ts` to bind your new class to the
   `WHATSAPP_PROVIDER` token instead of `MetaCloudWhatsAppProvider`.
4. Update `.env.example` with the new env block.
5. Templates may or may not transfer — most providers require their
   own template registration. Plan for re-registration + 24h approval.

The provider abstraction is exactly the entire blast radius — every
other layer (NotificationsService, WhatsAppWebhookService, the Bull
queue) sees the same interface.

---

## 10. Reference

### Code locations

| What | Where |
|---|---|
| Provider interface | `src/modules/whatsapp/providers/whatsapp.provider.interface.ts` |
| Meta Cloud impl | `src/modules/whatsapp/providers/meta-cloud.provider.ts` |
| Public API service | `src/modules/whatsapp/whatsapp.service.ts` |
| Bull worker | `src/modules/whatsapp/whatsapp.processor.ts` |
| Webhook controller | `src/modules/whatsapp/whatsapp-webhook.controller.ts` |
| Webhook routing | `src/modules/whatsapp/whatsapp-webhook.service.ts` |
| Template registry | `src/modules/whatsapp/templates.ts` |
| Outbound from booking | `src/modules/notifications/notifications.service.ts` (`notifyBookingCreated`, `notifyChefAccepted`, `notifyChefRejected`) |
| User opt-out flag | `src/modules/users/user.entity.ts` (`whatsapp_enabled`) |

### Endpoint reference

| Method | URL | Auth | Purpose |
|---|---|---|---|
| GET | `/api/v1/webhooks/whatsapp` | None (public) | Meta verify-token handshake |
| POST | `/api/v1/webhooks/whatsapp` | HMAC signature | Inbound message delivery |

### Env vars

| Var | Required | Default | Purpose |
|---|---|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | yes | — | Meta Phone Number ID (NOT the phone number) |
| `WHATSAPP_ACCESS_TOKEN` | yes | — | Permanent system-user token |
| `WHATSAPP_VERIFY_TOKEN` | yes | — | Random string for handshake |
| `WHATSAPP_APP_SECRET` | yes | — | HMAC key for inbound signature |
| `WHATSAPP_API_VERSION` | no | `v20.0` | Graph API version; bump when Meta deprecates |
| `WHATSAPP_DEFAULT_COUNTRY_CODE` | no | `91` | Country code prepended to local-format phones |

### Log lines worth grep-ing in production

| Pattern | Meaning |
|---|---|
| `WhatsApp template sent to <to> — providerMessageId=<id>` | Successful outbound |
| `WhatsApp <kind> to <to> failed (attempt N/3)` | Bull retry — usually Meta API error |
| `WhatsApp not configured — dropping <kind> message` | Env not set; dev/preview state |
| `Refusing inbound WhatsApp webhook — bad signature` | Bad `X-Hub-Signature-256` — investigate |
| `No chef found for inbound phone <X>` | Chef's User.phone doesn't match — data fix |
| `Phone <X> matched N chefs — refusing for safety` | Duplicate phone — data fix |
| `Skipping duplicate inbound <wamid>` | Idempotency working; Meta retried |
| `Chef <id> accepted booking <id> via WhatsApp` | Successful inbound approve |
| `Chef <id> rejected booking <id> via WhatsApp` | Successful inbound decline |

### Meta API error codes worth knowing

| Code | Meaning | Action |
|---|---|---|
| `131026` | Recipient is not a valid WhatsApp user | Fall back to email |
| `131047` | 24h customer-care window expired | Use template, not free text |
| `131051` | Unsupported message type | Probably a malformed payload — check our code |
| `132000` | Template not approved in this language | Update `templates.ts` `language` field |
| `132001` | Template does not exist | Re-register in Meta or fix the name in `templates.ts` |
| `132012` | Template parameter format mismatch | Check vars order/count vs registered template |

Full list: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes

### Useful read-only SQL

```sql
-- Find a chef by their WhatsApp number (last 10 digits)
SELECT id, email, name, phone, whatsapp_enabled
FROM users
WHERE role = 'cook'
  AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE '%9876543210';

-- Bookings the chef accepted via WhatsApp (after Phase 3 went live)
SELECT id, status, chef_responded_at, rejection_reason
FROM bookings
WHERE rejection_reason = 'Declined via WhatsApp'
ORDER BY chef_responded_at DESC
LIMIT 50;

-- Users who muted WhatsApp
SELECT id, role, name, email
FROM users
WHERE whatsapp_enabled = false;
```
