---
id: billing
layer: domain
status: active
version: 12
updated: 2026-09-12
---

# Contract — billing / the top-up page

A topic file of `contract.md` (§10): the whole of one top-up — the gateway list
and the quote (F-092-o), the payment the quote described (F-092-i), and the
callback that settles it (F-092-j). The first three are the panel's (F-093-e);
the last is a **bank's**, and is the one route here nothing in this platform
calls.

## Routes (built — F-092-o, F-092-i)

`DepositController` + `DepositQuoteService` / `DepositStartService` in
`billing-service/src/app/payment/deposit/`. All three sit behind the gate like
every billing route ("Request edge" in `contract.md`): the user and the tenant
come from its headers, never from the body.

| Route | Body | Answers `data` |
|---|---|---|
| `GET /api/billing/deposit/gateways` | — | `[{id, source, displayName, providerName, category, minAmount, maxAmount, presets}]` — platform gateways first, each table oldest first. `presets` (F-092-v): the gateway's own list, else the caller tenant's default, only amounts inside the range; empty = the panel's ladder |
| `POST /api/billing/deposit/quote` | `{gatewayId, source?, amount, couponCodes?}` — `source` `tenant` (default) or `platform`, as the list answered it; `amount` a decimal string, ≤ 2 places, > 0; ≤ 10 codes of ≤ 64 chars | `{gatewayId, source, amount, coupons[{code, discount}], rejected[{code, reason, message}], discount, gap, fee, payable, credited, free, charge}` |
| `POST /api/billing/deposit/start` (F-092-i) | the quote's body, exactly | `{paymentId, free, redirectUrl, amount, discount, fee, payable, credited, balance}` |

## Rules

| Rule | Why |
|---|---|
| Every number in a quote is `priceAtGateway`'s, and the panel does no arithmetic of its own | F-0612: legacy computed the price in `Deposit.tsx` and on the server, and the two drifted |
| Money is a base-currency decimal string (ADR-0019); `charge` is `{currency, decimals, amountMinor}` as the gateway will be asked, `amountMinor` a string, or `null` on the free path | JSON has no bigint and no exact decimal |
| A `tenant` gateway is the request tenant's own `tenant_gateway_config`, `isActive` **and** `verified`; a `platform` gateway is an active `payment_gateway`, offered **only** when the request tenant is `platform_owner`, which is offered both (D-25). Either needs a driver. Anything else — another tenant's, a reseller asking for a platform one, an id named with the wrong `source` — is **404** `billing.gatewayNotFound` | ADR-0006: no shared gateway for resellers (`deposit-gateways.int.spec.ts`) |
| Rows are read in a `tenantTransaction` with an explicit column list — never `merchantIdEncrypted` / `apiKeyEncrypted` / `payment_gateway.merchantId` | the strict RLS on `tenant_gateway_config` binds only there; `payment_gateway` has no policy, so the tenant type is the whole boundary; invariant 8 |
| Every gateway pays into its own account: its merchant id is the request tenant's vault `gateway_merchant_id` labelled `gateway:<source>:<gatewayId>` ("Payment providers" in `contract.md`) | D-26 |
| A gateway with no usable merchant id is **not listed** (`GatewayMerchant.configuredLabels`, one vault read, nothing decrypted), and a quote that would charge refuses it **503** — the manual-fee path asks `requireConfigured`, since it decrypts nothing of its own | F-092-u: offering it means the user picks it and the payment fails afterwards |
| A fully discounted top-up is quoted whatever the vault holds | nothing reaches the gateway on the free path |
| Coupons are validated in the same transaction as a wallet top-up. A rejected code is not an error: the quote goes on without it and `rejected[].message` is translated, one i18n key per `reason` | codes stack; a typo must not hide the rest of the breakdown |
| An automatic fee: the provider is asked for `feeQuoteAmountMinor`, its answer converted by `quotedFeeFromMinor` (rounded **up** to the cent). The vault and the provider are called after the transaction closes; the free path calls neither | no connection is held across a call to a bank |
| A `useLiveRate` gateway is priced at the rate the FX worker last published (`FxRateReader`, F-092-c); one that does not ask for a live rate is never read for, and prices from its `staticRate` | a quote is not the place to spend a Redis round trip proving a column's value |
| No readable rate is `liveRate: null` — the gateway's `staticRate`, or a refusal — and never an error of its own: Redis down, a value that no longer parses, no `currency` row and no snapshot ever written are all the same answer | a 500 on a quote where the user's move is the same as a 503's: another gateway |
| Out of the gateway's range is **400** `billing.amountOutOfRange`; no usable rate, rate out of range, a provider failure, no merchant id, no driver are all **503** `billing.gatewayUnavailable` — the cause goes to the log only | the user's move is the same: another gateway |
| A quote reserves and writes nothing | `start` reserves, on the request that pays |
| Per user, per 900s: the list `DEPOSIT_GATEWAYS_RATE_LIMIT` (default 120), a quote `DEPOSIT_QUOTE_RATE_LIMIT` (default 60), a start `DEPOSIT_START_RATE_LIMIT` (default 20); **429** past it (F-092-r) | a quote at an automatic-fee gateway is a call to the bank; a start is one plus a hold on somebody's coupon capacity |

## The live rate (built — F-092-c)

`FxRateReader` in `billing-service/src/app/payment/pricing/`. The read side of
`currency`'s FX loop, and the last piece ADR-0019 wants before a rial gateway
can quote: the worker has published since F-0606-a and `priceAtGateway` has
recorded which snapshot priced a payment since F-0606-b, and what sat between
them was nobody reading the key.

| Rule | Why |
|---|---|
| Cache first, table second, and both: `fx:rate:{FX_QUOTE_CURRENCY_CODE}` (`UnscopedRedisKeys.fxRate`, C-03), then the newest `effectiveAt` for that code | the key is a cache of a `currency_exchange_rate` row, so a miss is a question for the table and never an answer (`currency/contract.fx-worker.md`) |
| An unreadable or unparseable cache value is a **miss**, logged, not an answer | otherwise a Redis outage silently drops every live-rate gateway to its `staticRate`, at whatever price that column happens to name |
| A rate with no snapshot id, or one that is not positive, is refused from either store — both halves or neither | ADR-0019's forbidden state, and `priceAtGateway` treats a snapshotless rate as a caller bug (`InvalidPricingInput`), which is a 500 |
| No tenant is bound for the table read, and none is needed | `currency_exchange_rate` has no `tenantId` and so no RLS policy: the rate is the platform's, and every tenant prices from the same one |
| It does not judge the rate's **age** | the staleness ladder is F-0607-a's, and reads the `effectiveAt` this leaves on the snapshot |

**Not covered:** `amount` is base currency; the display-currency step the
F-092-i row names arrives with F-025. The rate's age is unjudged until
F-0607-a, so a rate the ladder would call *degraded* is quoted as a normal one.

## Starting the payment (built — F-092-i)

`DepositStartService` in `billing-service/src/app/payment/deposit/`, over the
same gateway selection and pricing as the quote (`deposit-pricing.ts`, shared so
the two cannot drift — F-0612). The body is the quote's, because the price is
recomputed here from the same inputs: a client never sends back a number it was
shown.

| Rule | Why |
|---|---|
| **The order is: price, hold the coupons, write the payment, *then* mint.** A refusal after the gateway has been called is an authority nobody will pay | `request` is never retried, because every attempt mints one ("Payment providers" in `contract.md`). Legacy called the gateway first and created the row after, which loses a paid authority instead |
| Three transactions, none open across a call to a bank: the reads (gateway, coupons, callback host); the `payment_transaction` + its holds, together or not at all; the authority, once there is one | the same rule the quote follows for the vault and the fee quote |
| The holds name the **payment**: `orderReferenceId` = `paymentTransactionId` = the row's id, minted before the row is written | F-092-j confirms and F-092-k expires by that id |
| A hold that can no longer be taken aborts the whole transaction and is **409**, one i18n key per `reason` — the same keys a rejected code gets on a quote. Nothing was written | `CouponReservationRefused`; the panel re-quotes and shows the breakdown without it |
| The row carries the quote's own numbers — `amountRequested` / `discountApplied` / `feeApplied` / `amountCredited` / `chargedAmountMinor` — and the rate **with** its snapshot id, or neither | invariant 12, ADR-0019 |
| `expiresAt` is `now + PAYMENT_PENDING_TTL_SEC` (default 900) on a pending payment and `null` on one that already landed. The holds have no clock of their own | legacy gave the row and its coupon locks two TTLs, so a lock could outlive its payment |
| `gatewayTrackingCode` is the `authority`, written after the gateway answers. A `request` that succeeded and whose authority was not stored leaves a `pending` row with no code — found late by F-092-l / F-092-k, rather than not at all | ADR-0028 |
| A gateway that will not mint: the row is `failed` with the `GatewayFailure.reason` as `failureCode`, and the holds are **released** `cancelled` — nothing timed out | a live hold behind a payment that never existed is spent capacity |
| **The free path** (`payable` = 0): the wallet is credited, the holds become uses and the row is written `success` with `chargedAmountMinor` 0, all in the write transaction. It asks neither the vault nor the provider, and answers `redirectUrl: null` with the new `balance` | invariants 1-3; nothing reaches a gateway, so nothing will ever call back about it |
| `confirmationSource` stays **null** on the free path: the enum names webhook, reconciliation and admin, and none of them happened | a value invented for it would make the three that mean something ambiguous |
| The callback is `https://<the tenant's own panel domain>/api/billing/deposit/callback` — a proven custom domain first, else the platform subdomain, read from `tenant_domain` and never from a request header. No such domain is a refusal (**503**), not a guess | ADR-0020: the callback route is public and resolved by Host (F-092-j), so a reseller's customer must come back to the brand they paid on. `PAYMENT_CALLBACK_ORIGIN` overrides it with one origin for every tenant — dev and test only |
| `amount` is base currency, as on a quote, and is converted for the gateway exactly once, inside `priceAtGateway` | the legacy `amount * 10` toman→rial step ran in the browser; the display-currency step is F-025's |

**Not covered:** nothing in the panel calls `start` yet (F-093-e). Expiring a
pending payment is below.

## Settling the payment (built — F-092-j)

`DepositCallbackService` + `DepositCallbackController` in
`billing-service/src/app/payment/deposit/`, and
`request/callback-tenant.middleware.ts` in front of them. The other half of
`start`: where the bank sends the payer back.

**It is the one public route on this service**, and that shapes everything
below. A gateway redirects a *browser*, which carries no session, no token and
nothing `my-auth` could check — so Traefik publishes
`/api/billing/deposit/callback` with `strip-fake-headers` and **no gate**, the
tenant comes from the Host, and the answer is a **302** to the panel's result
page rather than the envelope every other route answers.

| Route | Query | Answers |
|---|---|---|
| `GET /api/billing/deposit/callback` | `Authority`, `Status` — read case-insensitively | **302** to `/payment/success?t=` or `/payment/failed?t=` — `t` an HMAC-signed `{outcome, ref, already, code, exp 15 min}` under `PAYMENT_RESULT_SECRET` (`payment-result-token.ts`), nothing readable beside it — on the panel origin `start` captured (`payment_transaction.returnOrigin`: the browser's `Origin`, kept only if in `FRONTEND_ORIGIN` or a proven panel host of the tenant); relative when the row has none |

| Rule | Why |
|---|---|
| **Verify outside every transaction; flip, credit, confirm and announce inside one.** A connection is never held across a call to a bank, and the money never moves without the ledger row, the coupon uses and the outbox event moving with it | invariants 1-3, ADR-0021. The half legacy got right, kept |
| **The flip is the guard:** `updateMany({ where: { id, status: pending } })`, and the credit hangs off its `count`, never off a status read a moment earlier. `count: 0` answers `alreadyPaid` — a success, not a failure | ADR-0028, invariant 7. Two callbacks both see `pending`; Postgres re-checks the `where` after the loser waits on the winner's row lock. A bank retries by design, and a payer reloads |
| A refusal the gateway **stated** closes the payment: `failed` with the `GatewayFailureReason` as `failureCode`, holds **released** `cancelled` — nothing timed out. `Status` not `OK` is such a refusal and costs no vault read | the holds are capacity somebody else can use |
| **Silence is not a refusal.** `unavailable`, `amount_mismatch`, an unreadable merchant id and any unexpected error leave the row exactly `pending` and touch nothing | invariant 9. The money may have moved; closing the row is what makes a payment reconciliation (F-092-l) will never revisit. It is also why a mismatch is not settled here — `flagged_mismatch` is F-092-l's |
| The amount verified is the row's `chargedAmountMinor`, never recomputed | re-pricing at settlement is how a rate that moved becomes a mismatch (ADR-0019, invariant 12) |
| The credit is `amountCredited` (which already carries the adjustment gap), reason `payment_gateway`, `referenceId` the payment's own id; `confirmationSource` is `webhook_auto` and `expiresAt` becomes `null` | `amountRequested` is what the user typed; a landed payment has no clock left (F-092-k) |
| The outbox row is `billing.payment` / `billing.payment.confirmed`, written **in** the crediting transaction, its `payload` carrying its own `tenantId` | ADR-0021. `outbox_event` has no tenant column — the relay reads under no scope. **Nothing consumes it yet**: the relay marks it `unroutable`, which is visible rather than silent |
| The five failure codes are legacy's verbatim — `INVALID_PARAMS`, `TRANSACTION_NOT_FOUND`, `GATEWAY_CONNECTION_ERROR`, `VERIFICATION_FAILED`, `SYSTEM_ERROR` | F-093-f turns exactly these into i18n keys. Nothing here throws to the client: a payer lands on a page whatever happened |
| Per **authority**, per 900s: `DEPOSIT_CALLBACK_RATE_LIMIT` (default 30) | there is no caller to bucket on. One authority is one payment, and `rate-limit-coverage.spec.ts` names this controller as the only route allowed to count anything but a user |

### The tenant of a public route

`CallbackTenantMiddleware`, holding this service's **second** Postgres pool.

| Rule | Why |
|---|---|
| The tenant is `tenant_domain` for the normalized Host: a `panel` row that is a platform subdomain, or a custom domain that is **verified**. The same rows `start` mints a callback URL from | they must agree, or a tenant mints callbacks to a host this refuses (ADR-0020) |
| Anything else — unknown host, unproven domain, no Host at all — is a **neutral 404** | ADR-0025 decision 3. There is no fallback tenant: a callback absorbed into the wrong tenant credits the wrong wallet |
| That read holds `CrossTenantPrismaService` (`DATABASE_CROSS_TENANT_URL`, policy `USING (true)`, no `BYPASSRLS`), and is the only one in this service | the read is what *produces* the scope, so it cannot run inside one; on the app pool RLS shows it no rows and every callback 404s. `grep -rn CrossTenantPrismaService` is the audit |
| A **middleware**, not a guard, and uncached | `RateLimiter.hit` keys on the tenant in context and guards run after middleware. `auth-service` caches the same lookup because it is on every request; this one is on a payment, and the cache's invalidation rules are `tenant`'s to own (F-018) |

**Not covered:** the panel pages the redirect lands on are F-093-f's — this
route only names the paths and the codes. Nothing tells the panel a balance
changed in real time: the outbox event has no consumer, and
`panel-web/contract.shell.md` still says so.

## A gateway somebody else owns (built — F-096-b)

`deposit-pricing.ts`, read by both the list and the quote. ADR-0041 §1, §2, §6.

The default stays ADR-0006's: a tenant is offered the gateways it configured,
and the platform's own only to the platform owner. A **grant** is the one
exception, and it changes which rows are offered — not how they are priced.

| Rule | Why |
|---|---|
| A tenant is offered its own gateways and then the ones granted to it, each group oldest first; a row already offered as its own is not offered twice | its own is what it configured and expects first. The platform owner granting itself a gateway would otherwise see it doubled |
| A grant is read from the **borrower's** own scope (`payment_gateway_grant.tenantId`), and the gateway row it names is read on the **cross-tenant** pool, bounded to those ids | the lender's `tenant_gateway_config` row is invisible to the borrower's connection, so the read cannot be scoped by the borrower — it is scoped by the grant instead. Second reader of that pool in this service; it selects `GATEWAY_COLUMNS`, so no secret column is read (invariant 8) |
| A withdrawn grant, a deactivated gateway and an unverified one each remove the row from the list **and** from the quote, at the same moment | ADR-0041 §6: a grant never keeps a dead gateway alive. `isActive`/`verified` are checked on the row, so a lender switching its gateway off withdraws it from every tenant it was granted to without anyone touching a grant |
| `selectGateway` looks for a grant **after** the tenant's own row misses | owning a row is cheaper to prove and is the ordinary case, so no other payment pays for the grant read |
| The vault filter (F-092-u) asks the **owning** tenant's vault, not the caller's | a granted gateway's merchant id is its owner's (D-26, ADR-0041 §3). Asking the caller would answer "not configured" and drop the row — a granted gateway silently missing rather than offered |
| A payment records the grant it was taken under (`payment_transaction.grantId`), written at `start` | the grant can be withdrawn between starting and settling, and what the platform owes is decided by the grant the payment was *made* under (ADR-0041 §4). F-096-d accrues from this column |

**Charging one** (F-096-c): a ref may name its grant, and naming one is what
opens the **owner's** vault — after the grant has been proved on the
application pool in the borrower's own scope, against that gateway. Every vault
read a gateway needs goes through `GatewayMerchant`, so "along a grant and
nowhere else" is one file's property and not four call sites' discipline; the
rules and the refusals are `domains/tenant/contract.vault.md` "The one
crossing", and the access row lands in the lender's scope tagged with the
grant.

**The debt it leaves** (F-096-d): a payment whose `grantId` is set writes one
`gateway_settlement_entry` — **inside the crediting transaction**, beside the
ledger row and the outbox event, because a wallet that grew without the debt
recorded is a tenant owed money nothing knows about and no sweep can
reconstruct it. The amount is `amountCredited` **net of `feeApplied`** (§4: the
payer covered the gateway's cut and the gateway kept it), floored at zero — a
fee larger than the credit is not a debt in the other direction. It hangs off
the same `count` as the credit, so a retried callback or a reconciliation sweep
accrues nothing, and the unique key on `paymentTransactionId` is the second
line under that.

**Not covered here:** nothing surfaces or creates a grant yet — that is
F-096-e's, and until then a grant row is written by hand.

## Expiring what nobody came back for (built — F-092-k)

`DepositExpiryService` + `DepositInternalController` in
`billing-service/src/app/payment/deposit/`, run by `worker-service`'s
`DepositExpiryJob` (`domains/automation/contract.worker.md`).

`start` writes a `pending` payment holding a slot of every coupon it applied,
and the callback settles the ones a payer came back for. This is the rest: a
tab closed at the bank, an authority nobody used. Without it every abandoned
top-up holds somebody else's coupon capacity for ever.

| Rule | Why |
|---|---|
| `POST /api/internal/billing/deposit/expire-pending`, behind `ServiceOnlyGuard` (`SERVICE_AUTH_TOKEN`) — no gate, no identity, no tenant, and not under Traefik's `/api/billing` router | the caller is a process, not a person. `automation` owns *when*; the rules are billing's, and an Nx app cannot import an Nx app. A refusal is a neutral 404, like every internal seam |
| The **scan** is cross-tenant, every **write** is scoped: one `tenantTransaction` per tenant | which tenants have a due payment is what the sweep is looking for, so the read cannot run inside one — and on the app pool RLS would answer nothing at all. This is the second `CrossTenantPrismaService` reader in this service; `grep -rn CrossTenantPrismaService` is still the audit |
| **The flip is the guard**, exactly as the callback's: `updateMany({ id, status: pending, expiresAt <= now })`, and the release hangs off its `count` | a bank can confirm a payment between the scan and the write. Releasing a confirmed use's hold would give back capacity that is spent. It is also what makes the sweep safe to run twice, which an at-least-once tick (ADR-0027) requires |
| Holds are released **`expired`**, never `cancelled` | nothing failed; the clock ran out. `close()` owns the other word, and `coupon_redemption` stays able to tell an abandoned payment from a refused one |
| The row **stays**, and so does its `expiresAt` | legacy expired a payment by deleting it and its locks on two Mongo TTLs, losing the attempt from the audit trail. F-092-l inquires an expired payment at the gateway, and *when we stopped waiting* is part of what a mismatch is judged on — so this is the one non-`pending` status that keeps a clock |
| One batch per run, `PAYMENT_EXPIRY_BATCH_SIZE` (default 200), oldest first; one `now` for the scan and every guard under it | a backlog drains in bounded transactions and the next tick takes the next batch. A shared `now` stops a row that was due at read time being spared by the clock moving |
| A due row with **no `tenantId`** is counted and logged `error`, not swept | the app pool cannot write it — RLS scopes by that column. `withTenant` makes it impossible on create, so one appearing is a schema fault, and a quiet zero would hide it |

A **verifying** row (`nextVerifyAt` set) is skipped — `contract.verify.md`.

**Not covered:** a payment the gateway may still have taken money for. This job
only reads a clock — it asks no gateway anything, and an `expired` row is not a
statement that nothing was paid. Inquiring one is F-092-l's, and invariant 9
stands: never auto-reverse, and never auto-close on silence.

## Asking the gateway later (built — F-092-l)

`DepositReconciliationService`, behind the same internal controller, run by
`worker-service`'s `DepositReconciliationJob`.

The callback settles a payment whose payer came back; the expiry sweep closes
the clock on the ones who did not. This is the third case, and the one both
leave open on purpose: **a payment the gateway could not be reached about.**
"Silence is not a refusal" above is what creates it, and until this existed
nothing ever came back to resolve one. Legacy's `isVerified` (codes 100/101)
was the same idea with nothing scheduling it.

| Rule | Why |
|---|---|
| `POST /api/internal/billing/deposit/reconcile`, the same seam and guard as the expiry sweep, and a **separate** route and job | one call to a bank per payment against a clock that calls none: merging them ties the cheap frequent sweep to the rate a bank will answer |
| It asks about `expired` rows and `pending` rows past their clock, that **carry an authority**, inside a lookback window, and not if a log row was written inside the recheck window | no authority means the gateway was never asked to mint one. Without the recheck window the oldest unresolvable payment fills every batch for ever; past the lookback, an unclaimed payment is an operator's question, not a job's |
| **It credits and it flags. It never closes and it never reverses** | invariant 9. `ReconciliationAction` has exactly three words, and that is the vocabulary: closing a row is the clock's job (F-092-k), and an auto-reversal is the one write this table can never take back |
| A `verified` or `paid` inquiry is followed by a **`verify`**, and the credit goes through `DepositSettlementService` with `confirmationSource: reconciliation_auto` | `verified` still has to be verified — that call is where the reference number is. The shared path means a payer arriving a second earlier still credits exactly once (ADR-0028, invariant 7); `count: 0` is logged `no_action_needed`, not a failure |
| An **amount mismatch** is `flagged_mismatch` and nothing else happens | crediting either figure would be this job inventing a price, and closing the row would hide a payment somebody's money is behind. It is written down for a person |
| `in_bank`, `failed` and `reversed` are recorded `no_action_needed` | not finished, or finished owing nothing. Neither is a reason for this job to write to a payment |
| An answer the gateway **could not give** — `unavailable`, an unreadable merchant id, anything unexpected — writes **no log row at all** and counts as an error of the run | a row saying "checked, nothing to do" is what retires a payment from every later sweep, and a timeout is not an answer. `authority_invalid` is the exception: that is an answer, and final |
| Every gateway call happens outside every transaction; the scan is cross-tenant and each payment is handled inside its own tenant's scope | the callback's rule, and a sweep holds a connection for a whole batch rather than one request |
| `gatewayReportedStatus` stores the gateway's own word, not our reading of it | a mismatch is investigated by a person who needs what the bank actually said |

**Known asymmetry:** `payment_reconciliation_log` carries no `tenantId`, so it
is not one of the tables `20260909001500_row_level_security_all_tables` gave a
policy shape to — it hangs off a payment that has one. Giving it a column and a
policy is a schema change and a row of its own.

**Not covered:** nothing surfaces a `flagged_mismatch` to an operator yet. It
is a `bot_execution_log` metric and a table, which is where an admin screen
will read it from.
