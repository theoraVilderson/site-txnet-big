---
id: adr-0131
status: active
updated: 2026-10-07
---

# ADR 0131 — several SMS and email providers per tenant, routed by country, with fallback

- **Status:** accepted (nothing built yet — rows MSG-1-a..r)
- **Date:** 2026-10-07
- **Affects units:** notification (owns the provider rows, the router, the
  admin routes and the bounce door), identity (the OTP senders read through
  the router), tenant (two vault kinds, one feature key), panel-web (the page)
- **Decision:** the user's, 2026-10-07 (D-68): "several SMS and email
  providers, like payment gateways — two international and Iranian ones", with
  the providers, the email choice and the routing as recommended
- **Spec:** [notification/contract.providers.md](../../domains/notification/contract.providers.md)

## Context

A tenant has exactly one SMS line today: one HTTP driver (`shared-core`
`SmsProviderService`), one `SMS_API_URL` for the whole platform, and the
tenant's `sms_api_key` / `sms_sender_line` in its vault (F-018-a). Email is one
SMTP server from env (`SMTP_*`, `MAIL_FROM`, D-39), the platform's only. There
is no admin surface: a line is written by `seed-sms-line`.

So one provider's outage, a filtered sender number or an empty credit balance
stops every OTP of that tenant until someone edits the vault by hand, and a
number outside Iran is sent through an Iranian line that may not reach it.
Iranian operators also block OTP-looking text on ordinary lines; the providers
answer that with pre-approved *templates* (Kavenegar lookup, SMS.ir verify,
Melipayamak shared service, IPPanel pattern), which the current driver cannot
send.

## Decision

1. **A provider is a row, like a gateway.** `notification.message_provider`:
   tenant, channel (`sms` | `email`), driver name, display name, sender,
   non-secret settings, countries, purposes, priority, active, health. Its
   secrets are vault values under the row's id as label (`messaging_api_key`,
   `messaging_api_secret`) — never a column (ADR-0026). A tenant may hold
   several of each driver.
2. **Ten drivers behind one port** in `shared-core/src/lib/messaging/`. SMS:
   `legacy_http` (today's gateway, unchanged, so the existing lines keep
   working), `kavenegar`, `sms_ir`, `melipayamak`, `ippanel`, `twilio`,
   `infobip`. Email: `smtp` (today's), `ses`, `brevo`. A driver is transport
   and translation only, handed its credentials for one call, as a payment
   driver is (F-092-f).
3. **One router decides who sends.** For a message it takes the tenant's
   active rows of the channel that allow the purpose (`otp`, `notice`,
   `campaign`) and cover the destination's country (empty = every country),
   sorts them by priority, skips one whose circuit is open, and tries them in
   turn. A row that refuses *the recipient* ends the attempt; a row that was
   unreachable or refused *the account* (credentials, credit, sender) hands
   over to the next. A timeout after the request left is *ambiguous*: an OTP
   or a notice moves on (a duplicate code is harmless), a campaign row does
   not (a duplicate advert is not) and is deferred on the same row.
4. **Whose rows serve whom is unchanged** (D-38, D-41, identity invariant 16):
   the platform owner's rows carry only the platform's own sends; a reseller's
   rows carry its staff and its users. "Has an SMS line" becomes "has an
   active SMS row allowing `otp`".
5. **OTP by template where the provider has one.** A row's settings may name
   an OTP template; the router then sends the code as the template's parameter
   instead of as text. Notices and campaigns are always text; a template-only
   account is a row with `purposes: [otp]`.
6. **API email reports back.** `ses` and `brevo` post bounces and complaints
   to a signed door per row; a hard bounce or a complaint puts the address on
   the tenant's `email_suppression`, which notices and campaigns obey. SMTP
   cannot report, and stays as the universal driver for any other provider.
7. **The current setup moves into rows, then leaves.** A one-off, idempotent
   script turns each line and the env SMTP into rows; the readers switch to
   the router; `tenant_sms_config`, the two singular SMS vault kinds,
   `SMS_API_URL` and `SMTP_*` are retired in a last row, after one release.

## Consequences

- An outage, a filtered number or an empty balance costs one row's attempt,
  not the tenant's logins; a number outside Iran reaches Twilio or Infobip.
- A reseller with its own SES or Brevo account sends email as its own domain
  through its own row. That may make F-035-l's dependency on F-112 unneeded —
  a separate decision, raised when MSG-1-k lands, not taken here.
- The international providers do not accept customers based in Iran and may
  close an account; that risk is why each channel holds more than one
  provider, and the reason fallback is automatic.
- Each driver's wire format is checked against its vendor's current docs when
  its row is built, and the facts are written into the contract then; the
  endpoints in the contract are starting points, not verified.
- Not in this series: SMS delivery reports (DLR), per-percentage load sharing,
  metering a reseller's sends (D-41 stands: no SMS price).
