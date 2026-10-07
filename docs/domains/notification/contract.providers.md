---
id: notification
layer: domain
status: active
version: 13
updated: 2026-10-07
---

# Contract — notification / SMS and email providers (MSG-1)

Decided by the user on 2026-10-07 (D-68, ADR-0131); written before any of it
is built. **Nothing here exists yet.** Today's single line is described in
[contract.md](contract.md) "Delivering by SMS" / "by email" and stays true
until MSG-1-c and MSG-1-d switch the readers.

## Storage (P1-P4)

- **P1 `notification.message_provider`.** `id`, `tenantId`, `channel`
  (`sms` | `email`), `providerName` (`MessageProviderName`: `legacy_http`,
  `kavenegar`, `sms_ir`, `melipayamak`, `ippanel`, `twilio`, `infobip`,
  `smtp`, `ses`, `brevo`), `displayName`, `sender` (a line number, an
  alphanumeric id or a `Name <address>`), `settings` jsonb (non-secret, per
  driver, below), `countries` text[] (ISO 3166 alpha-2; empty = every
  country; ignored for email), `purposes` `MessagePurpose[]` (`otp`,
  `notice`, `campaign`; at least one), `priority` int (lower first, unique per
  tenant + channel), `isActive`, health (`lastSuccessAt`, `lastFailureAt`,
  `lastFailureClass`, `lastFailureText` ≤ 200), timestamps. RLS on `tenantId`.
  A driver's channel is fixed: `sms` drivers on `sms` rows only.
- **P2 Secrets in the vault** (ADR-0026), kinds `messaging_api_key` and
  `messaging_api_secret`, label = the row's id. Which a driver needs is
  `MESSAGING_PROVIDER_FIELDS` (exhaustive over the enum, as
  `provider-fields.ts` is for gateways). An answer shows only
  `{configured, fingerprint}` per secret.
- **P3 `notification.email_suppression`.** `tenantId`, `address` (lower-cased),
  `reason` (`hard_bounce` | `complaint`), `providerId`, `createdAt`; unique on
  tenant + address. RLS.
- **P4 Feature keys.** A reseller may hold SMS rows only with `own_sms` (exists)
  and email rows only with `own_mail` (new, C-09). The platform owner needs
  neither. Losing the key deactivates the rows, never deletes them.

## The router (R1-R9) — `shared-core/src/lib/messaging/message-router.ts`

- **R1 Input.** `{ tenantId, channel, purpose, to, text, subject?, otpCode? }`.
  `to` is normalised to E.164 with `libphonenumber-js` (a bare `09…` is Iran);
  an unparseable number is `recipient` at once, no row tried.
- **R2 Candidates.** The tenant's rows: active, this channel, allowing the
  purpose, covering the number's country, credentials configured; by
  `priority`. Whose tenant is asked is the caller's rule (R9), never the
  router's.
- **R3 Circuit.** Three `unreachable` or `account` failures of one row within
  five minutes open its circuit for five minutes (Redis, a `redis-keyspace`
  catalog key); an open row is skipped unless it is the last candidate.
- **R4 Failure classes**, each driver mapping its vendor's answers:
  `recipient` (bad or blocked number/address, the operator's blacklist) →
  stop, the message failed; `account` (credentials, credit, sender not
  allowed, template not approved) and `unreachable` (DNS, connect, TLS, 5xx,
  a 429) → the next row; `ambiguous` (timeout after the request left) → the
  next row for `otp` and `notice`, stop and defer for `campaign`; `content`
  (a blocked word, ours or the vendor's) → stop (contract.templates.md W3, W5).
- **R5 Answer.** `{ sent: true, providerId }` or `{ sent: false, class, tried:
  providerId[] }`; never a throw for a vendor's refusal.
- **R6 Health.** Every attempt updates its row's health columns, at most once
  per row per ten seconds; a change of `lastFailureClass` or a success after a
  failure writes outbox `notification.provider.health` (C-14, RT-1).
- **R7 Patterns and text** (ADR-0132, replacing "only the OTP is a
  template"): R1 also takes `kind` and `vars`; each row sends the kind's
  pattern, or the rendered text when `settings.freeText`, or is skipped —
  [contract.templates.md](contract.templates.md) N1-N4, after W3's check.
- **R8 Timeouts.** 5s connect, 10s whole for `otp`; 20s for the rest. An OTP's
  whole attempt, every row included, stops at 25s.
- **R9 Whose rows** (D-38, D-41, identity invariant 16, notification invariant
  10 — unchanged): the platform owner's rows for the owner's OTP, the owner's
  own campaign to its own users and platform notices to them; a reseller's
  rows for its staff and its users. `GET /auth/otp/channels` offers `sms`
  when the resolved tenant has an active SMS row allowing `otp`.

## The drivers (D1-D10)

Each row's endpoints below are a starting point. **The row that builds a
driver reads its vendor's current docs first and corrects this table in the
same change** (as CB-1-l). Fixtures come from those docs; no live account is
needed for `done`.

| id | driver | secrets | settings | text send | pattern send |
|---|---|---|---|---|---|
| D1 | `legacy_http` | key (`user@pass`) | `baseUrl` (today's `SMS_API_URL`) | `GET /SendSms`, `SendWasSuccessful` | — |
| D2 | `kavenegar` | key | `patterns` | `/v1/{key}/sms/send.json` | `/v1/{key}/verify/lookup.json` (`token`, `template`) |
| D3 | `sms_ir` | key (`x-api-key`) | `patterns` | `/v1/send/bulk` | `/v1/send/verify` (`templateId`, parameters) |
| D4 | `melipayamak` | key (user), secret (pass or console token) | `patterns` (bodyId) | REST `SendSMS` | `BaseServiceNumber` (shared line) |
| D5 | `ippanel` | key (`apikey`) | `patterns` | `/api/v1/sms/send/webservice/single` | `/api/v1/sms/pattern/normal/send` |
| D6 | `twilio` | key (Account SID), secret (auth token) | `messagingServiceSid?` | `POST /2010-04-01/Accounts/{sid}/Messages.json` | — |
| D7 | `infobip` | key (`App` key) | `baseUrl` (per account) | `POST /sms/2/text/advanced` (or v3) | — |
| D8 | `smtp` | key (user), secret (pass) | `host`, `port`, `secure` | today's `MailProviderService` | — |
| D9 | `ses` | key (access key id), secret (secret key) | `region`, `configurationSet` | SES v2 `SendEmail` | — |
| D10 | `brevo` | key (`api-key`) | — | `POST /v3/smtp/email` | — |

- Iranian numbers: D2-D5 take `09…` or `98…` as their docs say; the driver
  formats, the router never does.
- D1 and D8 keep their present answers and failure mapping exactly; MSG-1-b
  wraps them and their existing specs pass unchanged.

## Bounces and complaints (B1-B4) — email only

- **B1 Door.** `POST /api/notifications/providers/webhook/:providerId`, public.
  The row's driver verifies: `ses` the SNS signature (certificate host pinned
  to `sns.<region>.amazonaws.com`, cached to expiry) and confirms a
  `SubscriptionConfirmation` once; `brevo` a per-row token generated on
  create, shown once, sent in the URL's query. A bad signature is 401 and
  writes nothing.
- **B2 Events.** A permanent bounce or a complaint inserts the address into
  `email_suppression` for the row's tenant (idempotent). Transient bounces,
  deliveries and opens are acknowledged and dropped.
- **B3 Who obeys.** `notice` and `campaign` email to a suppressed address is
  `failed` with reason `suppressed`, no row tried. `otp` email (the user asked
  for it) is still sent.
- **B4 Lifting.** A staff member removes an address (`DELETE …/suppressions/
  :address`, audited); a user who verifies the same address again (F-035-g)
  lifts a `hard_bounce`, never a `complaint`.

## Admin routes (A1-A7) — `notification-service`, permission `messaging.manage`

| id | route | in | out / refusals |
|---|---|---|---|
| A1 | `GET notifications/providers?channel=` | — | the caller tenant's rows by priority, secrets as `{configured, fingerprint}`, `webhookUrl` for D9/D10, health, `circuitOpen` |
| A2 | `POST notifications/providers` | P1's editable fields | the row, inactive; 400 per-driver settings; 403 `feature_not_entitled` (P4) |
| A3 | `PATCH notifications/providers/:id` | any editable field | the row; 409 `last_otp_line` when it would leave a tenant whose users sign in by SMS with none (deactivating, or dropping `otp`) |
| A4 | `PUT notifications/providers/:id/secrets` | `{ key?, secret? }` | `{configured, fingerprint}` per secret; vault `put`, audited |
| A5 | `PUT notifications/providers/order` | `{ channel, ids[] }`, every row of it | the rows; 400 when the set differs |
| A6 | `POST notifications/providers/:id/test` | `{ purpose: otp \| notice }` | `{ sent, class?, text? }` — sent through **this row only** to the caller's own verified phone or email; rate-limited 5 / 10 min per caller |
| A7 | `DELETE notifications/providers/:id` | — | 204, its vault values revoked; 409 `last_otp_line` as A3 |

Plus `GET`/`DELETE notifications/providers/suppressions` (B4). Every write is
in the audit log; a tenant sees only its own rows, another's id is 404.
`notification-service` gains a vault **writer** row in
`tenant/contract.vault.md` for the two kinds, labels it owns only.

## Moving today's setup (M1-M3)

- **M1 Script** `migrate-message-providers` (idempotent, run once per
  environment): for the platform owner's `sms_api_key` and each
  `tenant_sms_config` `own_credentials` row, a `legacy_http` row (priority 10,
  every country, every purpose, `baseUrl` = `SMS_API_URL`, `sender` = the
  vault's `sms_sender_line`) with the key copied into P2; for a set
  `SMTP_HOST`, an owner `smtp` row from `SMTP_*` / `MAIL_FROM`. Dev: Mailpit
  becomes that row.
- **M2 Switch.** The OTP senders (`auth-service`), `SmsLineSource`,
  `MailLineSource` and the notice SMS go through the router; `lineFor`'s
  whose-line rule moves into R9 unchanged, and its specs move with it.
- **M3 Retire** (one release later, MSG-1-r): drop `tenant_sms_config`, stop
  reading `sms_api_key` / `sms_sender_line`, remove `SMS_API_URL` and `SMTP_*`.
  The migration deletes data and is asked for at that time.

## What the panel asks (U1-U5) — `/messaging`, panel-web

- **U1** Two tabs, SMS and Email; rows in priority order, dragged to reorder
  (A5); each with its driver's logo name, sender, countries, purposes, an
  active switch and a health badge (ok / failing / paused = circuit open).
- **U2** Add: pick a driver, then only the fields
  `MESSAGING_PROVIDER_FIELDS` names for it; a hint per field in en/fa; the
  Iranian drivers say why patterns matter; patterns per kind are U6
  (contract.templates.md).
- **U3** Countries: "all" or a chip list; a shortcut "Iran only" / "everything
  but Iran".
- **U4** "Send me a test" per row (A6); the answer's class shown in words.
- **U5** Email rows of D9/D10 show the webhook URL with a copy button; a
  Suppressions list under the Email tab. Health re-reads on
  `notification.provider.health` with `useLiveReread`.

## What does not change

Campaign texts and languages, the claim and lease of campaign rows, the
outcomes `sent` / `failed` / `deferred` / `stalled` (a campaign row is
`stalled` when every candidate failed `account` or none exists), quiet hours
and notice classes (F-601-s) — only which line carries a send.
