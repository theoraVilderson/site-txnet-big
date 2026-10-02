---
id: adr-0109
status: accepted
updated: 2026-10-02
---

# ADR 0109 — the revenue engine is ours; the language model is the tenant's

- **Status:** accepted, not built (series F-038-a … F-038-v and the catalog
  rows of section 24, ingested 2026-10-02)
- **Date:** 2026-10-02. The user approved every point below in conversation:
  the AI works on consumption, purchase, renewal and wallet top-up (spin
  wheel and offers later), exists to raise revenue, must serve products other
  than VPN, reads **only the database and Redis — no network data**, and is
  **on by default for a tenant whose package includes it**.
- **Affects units:** ai, engagement, notification, billing, entitlement,
  tenant, panel-web, bot-app
- **Builds on:** catalog D-03, D-04, §24.1–24.7; D-12 (the model re-ranks
  inside our candidates, cooldown 14 days); ADR-0021 (outbox); ADR-0107
  (packages, feature keys); ADR-0108 (time zones)

## Context

The `ai` unit is a schema from onboarding with no `tenantId` on any table and
VPN-shaped enums (`buy_addon_gb`, `config_expiring_soon`). The catalog fixes
the safety rules (§24.1, §24.5, §24.7) and BYO-AI (§24.6) but not how a
suggestion is produced, where the code runs, or what it reads.

## Decision

1. **Two layers.** The *engine* is ours: features → predictions → next best
   action → timing → template. It is statistics and rules, needs no model and
   no key, and is complete on its own (D-04). The *language layer* is the
   tenant's own model (D-03, F-1534…F-1550): it may rephrase a template and
   re-rank inside the engine's candidates, never invent a product, a number
   or a price (D-12, F-1542).
2. **One service, `ai-service`** (Nest, `txnet-backend/ai-service`). Every
   model call and every proactive AI message decision goes through it, so the
   attention budget, PII scrub, output validation, time budget and token
   accounting have one home. Its container is capped (memory and one CPU):
   the host also serves the live site and bot. Catalog translation
   (F-1533-h) stays where it is — platform tooling, not a tenant AI message.
3. **Product-agnostic.** The engine speaks Account, Product, Variant, Grant,
   Meter and Wallet — never "GB" or "VPN". A new product kind is new meter
   keys and needs no engine change. Action types are generic: `renew`,
   `resize_up`, `resize_down`, `top_up_wallet`, `retain_offer`,
   `trial_convert`, `checkout_help`, `win_back`, `usage_alert`; later
   `cross_sell`, `wheel_invite`, `referral_invite`.
4. **A subject is an account:** `subjectKind: user | tenant`. The reseller is
   a customer of the platform, so the same engine predicts a reseller's
   package-quota exhaustion and churn and suggests its upgrade.
5. **Schema rebuilt.** The empty `ai` tables are dropped; new ones carry
   `tenantId` and RLS from their first migration: `account_profile`,
   `prediction`, `action` (the audit of every suggestion: reasons, template,
   `renderedBy: template | model`, status), `offer`, `guardrail`,
   `holdout`, `opt_out`, `provider`, `task_route`, `usage`, `setting`.
   `engagement.attention_budget` per F-1501 and C-13.
6. **Inputs: the database and Redis only.** Grants, meters, renewals,
   wallet and ledger, payments, coupons, catalog prices, sign-ins, notice
   delivery and reads, the tenant subscription and its limits. Real-time
   triggers arrive as outbox events; profiles are rebuilt hourly by a reader
   with a read-only role (SELECT on named tables, under tenant RLS). It writes
   only `ai.*` and `engagement.attention_budget`. **No network-layer data**
   (ISP, inbound or panel health). The user dropped F-1510…F-1513, F-1517,
   F-1518, F-1520, F-1522, F-1523, F-1530 and F-1538 the same day: no
   support agent, no network intelligence. **No learning across tenants**: a new tenant
   starts on rule defaults, never on another tenant's data.
7. **Predictions v1, each with `reasons[]`:** meter exhaustion date (the
   F-602 rate, weighted by hour of week); renewal probability (weighted rules,
   calibrated per tenant once it has 200 outcomes); right size (used under
   40% of the purchase over two periods → down; ran out early in two of the
   last three → up); wallet need (the next two renewals minus the balance,
   rounded up to a deposit preset); active hours (hour-of-week histogram on
   UTC times, 28-day decay); trial conversion; win-back window
   (14 / 30 / 60 days without an active Grant); for a tenant, quota
   exhaustion per ADR-0107 key and churn risk.
8. **Decision, in this order:** candidates by rules → confidence below the
   tenant threshold (default 0.6) is dropped (F-1503) → opt-out (F-1505) →
   cooldown 14 days per subject × type (F-1504) → quiet-down (F-1506) →
   holdout (F-1508) → attention budget (F-1501) → highest expected **margin**,
   not revenue → offer guardrails → scheduled at the subject's next active
   hour outside quiet hours (ADR-0108), before the action's deadline.
9. **Money rules.** The engine never sets a price or a discount: it picks
   from offers the tenant defined, each with a maximum discount and a daily
   budget. A discount goes only where the predicted renewal without it is
   under 0.5, once per account per offer, never to the holdout. Accepting
   one uses the existing coupon path. §24.5 holds: no ledger write, no meter
   change, no suspension, nothing on the payment path — `checkout_help` only
   points to another gateway after the attempt.
10. **Anti-annoyance defaults.** Three proactive messages per rolling 7 days
    and one per 24 h; an answer to the user costs nothing (F-1502); one CTA;
    holdout 10% per tenant (settable 5–20%, never 0), stable by a hash of the
    subject id. An AI message is never sent within 24 h of a retention notice
    (F-601 series) about the same Grant; the deterministic notice wins.
11. **Delivery.** Through the existing notice path (ADR-0084, F-601-s) as a
    new class `suggestion` — mutable, obeys quiet hours — to the bot and the
    panel inbox, labelled as a suggestion (F-1509), plus one offer card in the
    panel. Text is a locale-service key per action type.
12. **Default (user, 2026-10-02 — how F-1550 reads here).** A tenant whose
    package includes the `ai_recommendation` feature key has the engine and
    every v1 action type on with templates; a tenant without it has no engine
    run at all. The language layer is off until the tenant adds a provider;
    model-written text starts as draft-with-approval per type (F-1543).
13. **Measurement.** An action is accepted when its suggested purchase or
    top-up happens within 7 days; the report is uplift against the holdout
    per type — revenue, margin, renewals.
14. **Retention.** Raw behaviour events 180 days; profiles while the account
    exists; both erased with the account. Nothing leaves for a model
    unscrubbed (F-1547).
15. **Later, already bounded.** Spin wheel: the engine picks who is invited
    and when, and the day's prize pool from the tenant's list; the odds are
    the same for everyone, never per user. Seasons come from F-505-a, not a
    second calendar.

## Consequences

- The first value ships without any model: renewal timing, right-sizing and
  top-up suggestions on templates, proven against the holdout.
- A second product kind costs the engine nothing (point 3).
- `docs/domains/ai/*` describes the old schema until F-038-a rewrites it.
- Rejected: an LLM producing predictions (unexplainable, needs a key);
  per-service model calls (the guardrails would be copied, then diverge);
  network signals now (user, 2026-10-02); pooled learning across tenants;
  per-user spin-wheel odds.
