---
id: notification
layer: domain
status: active
version: 13
updated: 2026-10-07
---

# Contract — notification / SMS texts, patterns and blocked words (MSG-1-s..v)

Decided by the user on 2026-10-07 (D-69, ADR-0132), amending ADR-0131's "only
the OTP is a pattern". **Nothing here exists yet.** It sits on the router of
[contract.providers.md](contract.providers.md) and replaces its R7.

## Kinds (K1-K3)

- **K1 Keys.** A message kind is `otp` or a notice key that `NOTICE_CLASS_OF`
  routes to `sms`. shared-core `SMS_KIND_VARS` (`messaging/kinds.ts`) maps
  each kind to its variable names; a spec fails when a notice key routed to
  SMS has no row, so a new SMS notice cannot ship without its variables.
- **K2 Variables.** `{name}` written in braces, ASCII, from the kind's list
  only. `otp` has `{code}`; every kind may use `{brand}` (the tenant's
  display name).
- **K3 Campaigns** are not kinds: their text is the campaign's own (contract.md
  "Languages"), checked by W2 and W3, and never sent as a pattern.

## Texts (T1-T4)

- **T1 Storage.** `notification.message_template`: `tenantId`, `kind`,
  `language` (`Language`), `body` (≤ 480 chars), `updatedBy`, timestamps;
  unique on tenant + kind + language. RLS on `tenantId`.
- **T2 Resolving.** The tenant's body in the recipient's
  `languagePreference`, else the tenant's body in `DEFAULT_LANGUAGE`, else the
  platform default: locale-service namespace `sms`, key = the kind.
- **T3 Saving refuses** 400 `unknown_variable` (a name outside K1's list,
  named in the answer), 400 `blocked_word` (W2, the word and its position),
  400 `too_long`. A missing variable is allowed: a tenant may leave one out.
- **T4 Rendering** replaces each `{var}` with its value; the answer carries the
  segment count (GSM-7 160/153, UCS-2 70/67) for the panel's preview.

## Patterns on a provider row (N1-N4)

- **N1 Settings.** A row's `settings.patterns`:
  `{ [kind]: { id, params: { [vendorParam]: variable } } }`, replacing
  `otpTemplate` / `otpParam`. `settings.freeText` boolean; default true for
  `legacy_http`, `twilio`, `infobip` and every email driver, false for
  `kavenegar`, `sms_ir`, `melipayamak`, `ippanel`.
- **N2 Validation** on A2/A3: a kind outside K1, or a variable outside that
  kind's list, is 400 `bad_pattern`. Vendor parameter names are free text.
- **N3 Choosing the form**, per candidate row in the router's order (R2): a
  pattern for the kind → send it with the mapped values; none and
  `freeText` → send T2's rendered text; none and not `freeText` → skip the
  row (not an attempt, no health change). Every row skipped → the message
  fails with class `account`, reason `no_pattern`.
- **N4 Coverage.** A1 answers, per row, `missingKinds`: the kinds the row's
  purposes allow that it can send neither way. The panel shows them (U6).

## Blocked words (W1-W5)

- **W1 Storage.** `notification.blocked_word`: `tenantId` (null = the
  platform's base list), `word` (stored normalised, W4), `createdBy`,
  timestamps; unique on tenant + word. A tenant reads the base list and its
  own; writes only its own. Base-list writes: the platform owner's staff with
  `messaging.manage`.
- **W2 On save.** A template (T3), a campaign body or subject, and a campaign
  translation are refused 400 `blocked_word` when the normalised text holds a
  word of the base list or the tenant's.
- **W3 On send.** The router checks the rendered message — free text, or a
  pattern's values joined — before the first row. A hit is class `content`:
  the message fails, no row is tried. A campaign row is `failed` with reason
  `blocked_word`.
- **W4 Normalising** (one function, used for storing and matching): NFKC,
  lower case, Arabic ي/ك → ی/ک, Persian and Arabic digits → ASCII, ZWNJ and
  tatweel removed, and every run of non-letters between letters removed, so
  `V.P.N`, `V P N` and `وی‌پی‌ان` are each one token. A word matches as a
  substring of the normalised text.
- **W5 Vendor refusals.** A driver maps its vendor's "content filtered" answer
  to `content`, not `account`; the router then stops as in W3.

## Telling the tenant (C1)

- **C1** A `content` failure, or `no_pattern`, writes outbox
  `notification.messaging.content` `{ kind, providerId?, word? }` at most once
  per tenant, kind and reason per hour (C-14); the panel's `/messaging` page
  re-reads on it, and the tenant's staff get an in-app notice.

## Admin routes (A8-A12) — `notification-service`, `messaging.manage`

| id | route | in | out / refusals |
|---|---|---|---|
| A8 | `GET notifications/templates` | — | every kind of K1 with its variables, the tenant's bodies per language and the platform default |
| A9 | `PUT notifications/templates/:kind/:lang` | `{ body }` | the rendered sample and segments (T4); T3's refusals |
| A10 | `DELETE notifications/templates/:kind/:lang` | — | 204; the default applies again |
| A11 | `GET` / `POST` / `DELETE notifications/blocked-words` | `{ word }` | `{ base[], own[] }`; 409 `already_in_base` |
| A12 | `GET` / `POST` / `DELETE notifications/blocked-words/base` | `{ word }` | platform owner only, else 403 |

Every write is audited.

## What the panel asks (U6-U8) — `/messaging`

- **U6** Each SMS row: a Patterns section, one line per kind its purposes
  allow — pattern id and a vendor parameter beside each variable — and a
  warning for each of N4's `missingKinds`.
- **U7** A Texts tab: per kind and language an editor with clickable
  variables, live preview with sample values and the segment count; blocked
  words underlined before saving.
- **U8** A Blocked words tab: the base list read-only, the tenant's own
  editable; the platform owner also edits the base list.
