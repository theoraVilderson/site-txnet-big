---
id: adr-0132
status: active
updated: 2026-10-07
---

# ADR 0132 — every SMS kind has a tenant text and a pattern per provider; blocked words are checked before a send

- **Status:** accepted (nothing built yet — rows MSG-1-s..v)
- **Date:** 2026-10-07
- **Affects units:** notification (templates, word lists, the router's
  content step), panel-web (the editors), identity (OTP through the same step)
- **Decision:** the user's, 2026-10-07 (D-69): "some words in an SMS may be
  illegal, and a tenant wants its own text and layout for each kind of
  message" — every answer as recommended
- **Amends:** ADR-0131 decision 5 ("notices and campaigns are always text")
- **Spec:** [notification/contract.templates.md](../../domains/notification/contract.templates.md)

## Context

ADR-0131 sends only the OTP as a provider *pattern* (a text the operator
approved in advance, with parameters) and every other SMS as free text. In
Iran that fails for this platform in two ways. Operators filter free text on
service lines, and the words this product lives on — VPN, فیلترشکن, v2ray,
proxy — are exactly the filtered ones, so a receipt or an "ends in 3 days"
notice may never arrive while the provider still charges for it. And Kavenegar,
SMS.ir, Melipayamak and IPPanel expect a pattern for every transactional
message, not only the code.

Separately, a reseller wants its own wording and layout for each kind of
message, in each language, not the platform's text.

## Decision

1. **A message kind is a fixed key from code.** `otp` plus every notice key
   `NOTICE_CLASS_OF` routes to SMS; each declares its variables (`{name}`,
   `{days}`, `{link}`, …) in one shared-core table. A tenant cannot invent a
   kind or a variable.
2. **The text of a kind belongs to the tenant.** Per tenant, kind and
   language, an optional body using that kind's variables. None → the
   platform default from locale-service. Campaign texts are unchanged (they
   are already the tenant's).
3. **A provider row maps kinds to its approved patterns.** Its settings hold,
   per kind, the vendor's pattern id and which vendor parameter each variable
   fills. This replaces the single `otpTemplate`. A kind with a pattern on the
   row is sent as that pattern.
4. **Free text only where the row allows it.** A row carries `freeText`
   (default on for Twilio, Infobip, `legacy_http` and email; off for the four
   Iranian drivers). A kind with no pattern on a row that forbids free text
   skips that row for the next one; the panel lists each row's kinds that
   have neither.
5. **Blocked words: the platform's list plus the tenant's.** The platform
   owner keeps a base list for every tenant; a tenant may add words, never
   remove one. Checked on a normalised form (Arabic ی/ك, ZWNJ, spacing,
   digits, separators as in V.P.N) when a template or a campaign is saved
   (refused, the word named) and again at send time on the rendered message
   — variable values included, since a plan named "VPN Gold" reaches a
   pattern too.
6. **A refusal for content is its own class.** `content` — our check, or a
   vendor's answer that the text was filtered — stops the attempt (the next
   row would refuse the same words) and tells the tenant's staff which kind
   and which word, through the existing outbox (C-14).

## Consequences

- A notice reaches an Iranian number through an approved pattern, so
  filtering stops being a silent loss; a missing pattern is visible in the
  panel before it costs a message.
- Setting up an Iranian provider gains a step: register patterns with the
  vendor, then map them per kind. The default texts double as the wording a
  tenant submits for approval.
- The four Iranian drivers (MSG-1-f..i) send a pattern for any kind, not only
  the OTP — which is why this was decided before they were built.
- Campaigns are free text by nature: they pass the word check and go only
  through rows with `freeText` on (in Iran, an advertising line).
- Not decided here: who approves a tenant's text before it is sent (nobody —
  the word check and the vendor's own approval of patterns are the gate).
