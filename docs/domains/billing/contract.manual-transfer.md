---
id: billing
layer: domain
status: active
version: 1
updated: 2026-10-15
---

# Contract — billing / manual transfer: card-to-card, a wallet, and the next method (F-803…F-807)

A top-up the user pays by moving money themselves: to a bank card, to a
crypto wallet, or to any method added later. Decided by the user on
2026-10-06 (D-60); written before any of it is built, so an implementing
session has nothing left to decide. Each rule names the backlog row that
builds it; **Storage** (F-803-a), **Method kinds** (F-803-b), **Gateway admin** (F-803-c), **Starting one** (F-803-d) and **Proof and the queue** (F-805-a) exist, the rest is to be built. The pages are
[panel-web/contract.manual-transfer.md](../../interfaces/panel-web/contract.manual-transfer.md).
A fact that turns out wrong is said in one line and the rule corrected.

## Principles (every row)

1. **A manual method is a gateway, not a second system** (D-60 part 1). Its
   gateway row carries category `manual` and provider `manual_transfer`, so
   min/max, fee, tax, presets, coupons, the expiry sweep (F-092-k) and the
   manual-payments queue (F-092-z/af/ak) apply unchanged. No route, table or
   job duplicates one of them for manual transfers.
2. **A method kind is one descriptor.** `card_to_card` and `crypto_wallet` are
   the first two. A third kind (an IBAN/sheba transfer, a manual PayPal) is one
   file under `payment/manual/kinds/`, its i18n keys and its panel renderer — no
   schema change, no switch on the kind outside the registry.
3. **The seller sets every destination** (D-60 part 3). Cards, wallets,
   assets and networks are the tenant's own data, entered by the platform owner
   for platform gateways and by a reseller for its own. Nothing is preset.
4. **Two confirmation modes per gateway, automatic preferred** (D-60 part 2).
   `manual`: a person confirms from the queue. `automatic`: a watcher credits
   what the matching rule accepts and sends the rest to the queue. The deposit
   list answers automatic gateways first and marks the first one picked; a
   manual one is picked by default only when no automatic one is offered.
   "Automatic" here is any gateway that settles itself (Zarinpal, Stripe…);
   a manual gateway in `automatic` mode joins that group once F-803-f exists.
7. **Automatic confirmation of a transfer is deferred** (user, 2026-10-06).
   The first slice is confirmed by a person only. What it keeps so the later
   part needs no rebuild: the `confirmationMode` column (only `manual_admin_required` is
   accepted — no kind has a watcher yet), the descriptor's `uniqueStep` and
   `watcherFor` (none), `transfer_tx_ref`, and the `transfer_seen` slot on the
   pay page. Sections marked **later** below are its spec, not today's work.
5. **The proof a user sends is the seller's choice per gateway** (D-60 part 4),
   from the fields the kind declares.
6. **Money of record is unchanged.** The wallet is credited in base currency
   through the ledger (F-092-b); what the user sent is a receipt
   (`amountReceivedMinor` + `receivedCurrency`, F-104-a), never money of record.

## Storage (F-803-a)

Built 2026-10-15: `20261015000200_a_manual_gateway_is_a_provider` (the enum
values, alone because Postgres refuses a value in the transaction that added
it) and `20261015000300_a_manual_transfer_is_stored`. `PaymentProviderName`
gains `manual_transfer`; `GatewayCategory` gains `manual`. **Later:**
`ConfirmationSource` gains `chain_watch` (F-803-f) and `sms_match` (F-806),
each with its row.

- **A tenant may run several manual gateways** (user, 2026-10-15): a card and
  two wallets are three gateways with their own limits, fee and proof. The
  one-per-provider index on `tenant_gateway_config` (D-20) is partial —
  `WHERE "providerName" <> 'manual_transfer'` — and gateway admin reads the
  same rule from `PROVIDER_FIELDS[…].onePerTenant`.
- **A gateway is named as everywhere else** — exactly one of `gatewayId` /
  `tenantGatewayConfigId` (CHECK, as `gateway_audience`), the latter by
  `(id, tenantId)`; `tenantId` is the owner, the platform owner for a platform
  gateway (trigger, which also refuses a setting on any other provider).
- **`confirmationMode` is the gateway enum** (`manual_admin_required` /
  `automatic`), not a second one; the default is `manual_admin_required`.
- A detail's and a reference's `tenantId` is its payment's, by trigger — not a
  composite key, whose index on `payment_transaction` would lock it to build.
- `GRANTABLE.manual_transfer` is `false`: lending a manual gateway is not
  decided (its queue is the lender's staff's, its payer the borrower's).

| table | holds | rule |
|---|---|---|
| `manual_gateway_setting` | per gateway row: `kind`, `confirmationMode` (`manual_admin_required`/`automatic`), `requiredProof` (string[] of the kind's proof field ids), `windowMinutes` (default 30, 10..1440), `instructions` (optional override text by language) | one per gateway (above); RLS by tenant |
| `manual_destination` | `settingId`, `label`, `fields` (JSON, validated by the kind), `isActive`, `sortOrder`, `weight` (1..100), `dailyCapMinor` (optional) | RLS by tenant; a destination referenced by any payment is deactivated, never deleted (Restrict) |
| `payment_transfer_detail` | `paymentId` (PK), `destinationId`, `destinationSnapshot` (the fields shown to the user), `expectedAmountMinor`, `chargeCurrency`, `chargeDecimals`, `network` (crypto), `windowEndsAt`, `proof` (JSON), `proofSubmittedAt`, `proofReturnedAt` (F-805-a), `reviewReason` (enum below, nullable), `seenTxRef` | written by `start`; the snapshot is what the user saw, so editing a destination never changes an open payment |
| `transfer_tx_ref` | `(tenantId, network, txRef)` unique — a tx hash, a bank tracking number or an SMS reference | one external reference credits at most once per tenant, whichever path saw it first |

`reviewReason`: `underpaid`, `overpaid`, `late`, `wrong_destination`,
`duplicate_ref`, `amount_collision`, `no_match`, `proof_only`.

## Method kinds (F-803-b)

Built 2026-10-15 in `billing-service/src/app/payment/manual/`:
`manual-method.ts` (the descriptor), `manual-methods.ts` (the registry — the
only file that lists the kinds), `kinds/<kind>.ts`, one spec per kind.

`ManualMethod` descriptor: `kind`; `destinationFields` (id, type, check,
`optional`, `public` — shown to the payer or not, `fallback` — derived when
blank); `proofFields` (id, type, check); `refProofField` (the proof field kept
in `transfer_tx_ref`) and `refNetwork(fields)` (its `network` there);
`chargeCurrency(fields)` and `chargeDecimals(fields)`; `uniqueStep(fields)`
(the smallest offset, minor units, F-804); `watcherFor(fields)` → a watcher id
or null (none yet).

Every read goes through the registry: `parseDestination` and
`parseProof(method, input, requiredProof)` answer `{ok, fields}` or every
refused field with its reason — `missing`, `invalid`, `checksum` (a Luhn or
sheba typo), `unknown_field`; `publicDestination` is the payment's snapshot.
Digits are folded from any script, spaces and dashes dropped (`foldDigits`).

| kind | destination fields | proof fields | charges |
|---|---|---|---|
| `card_to_card` | `cardNumber` (16 digits, Luhn), `holderName`, `bankId` (derived from the 6-digit BIN, overridable), `sheba` (optional, `IR` + 24 digits, checksum) | `receiptImage`, `trackingCode`, `sourceCardLast4`, `paidAt` | `IRR`, 0 decimals; priced through the FX rate as a rial gateway (F-092-c) |
| `crypto_wallet` | `asset` (`^[A-Z0-9]{2,10}$`), `network` (free text, shown verbatim), `address`, `memo` (optional), `decimals` (0..18) | `txHash`, `receiptImage`, `paidAt` | the asset, its `decimals`; priced by the gateway's rate (F-0609: static or live) |

The BIN → bank table is data in `payment/manual/kinds/iran-banks.ts`, held to
`contracts/billing/iran-banks.json` (the panel's copy, F-803-g); an unknown
BIN shows `bankId = other` and is still accepted. `bankId` may be overridden
only with an id of the table or `other`.

The unique step (F-804, unread until then): a card's is a toman (10 rials) —
some banking apps take the amount in toman; a wallet's is 10^(decimals − 4)
minor units (0.0001 USDT), at least 1. A card's `refNetwork` is `card` (a
tracking code is unique across Shetab); a wallet's is its network upper-cased.

## Gateway admin (F-803-c)

Built 2026-10-15: `payment/manual/manual-setting.ts` (the rules),
`gateway-admin/manual-destination.{service,controller}.ts`. The gateway routes
of contract.gateways.md take provider `manual_transfer` with category `manual`
and a `manual` body (`kind`, `confirmationMode`, `requiredProof`,
`windowMinutes`) — the three together or `manual_setting_mismatch`; the body is
required on create, partial on update, saved in the gateway's own transaction
and audit row (`newValue.manual`), and every view carries `manual` (with
`destinations` / `activeDestinations` counts) or `null`.

- An unknown kind, a proof id the kind does not declare, or a window outside
  10..1440 is `invalid_manual_setting`. A gateway never changes to or from
  `manual_transfer`; its kind is fixed once it has a destination (`kind_in_use`).
- `confirmationMode = automatic` is `automatic_unavailable` unless every active
  destination has a watcher (and one exists) — today always. So is
  `feeCalculationMode = automatic`: there is no provider to quote a fee.
- Destinations are addressed like their gateway (corrected: `:source/:id`, as
  every gateway route — the two tables can share an id):
  `GET|POST /api/billing/gateways/:source/:id/destinations`,
  `PATCH|DELETE …/destinations/:destinationId`, and the same under
  `/api/billing/tenants/:tenantId/gateways/` for a named reseller. Same door,
  scope and budgets as the gateway; at most 50 per gateway. `fields` is checked
  by the kind: `invalid_destination` with each refused field in `error.facts`
  (`{cardNumber: "checksum"}`). Audited `gateway_manual_destination_create` /
  `_update` / `_delete`. Delete is `deactivated` once a payment showed it.
- A manual gateway needs no vault secret, so F-092-u's merchant check passes it;
  it is **offered only with an active destination** (`HAS_DESTINATION_IF_MANUAL`
  in every selectable-gateway read, a manager testing included).

Proof: `manual-setting.spec.ts`; checked on dev 2026-10-15 (both surfaces' rules,
audit rows, and the offer rule under RLS as the app role).

## Starting one (F-803-d; later F-804, F-807)

Built 2026-10-15: `payment/manual/manual-transfer.ts`, `manual-transfer.provider.ts`,
`deposit/deposit-transfer.service.ts`. A manual gateway has a registered driver,
`ManualTransferProvider` (settlement `manual`): it mints, verifies and quotes
nothing and lists no unverified payments, so reconciliation passes an open
transfer by; a browser return on one only shows it. It has **no charge currency**
(reading it throws): `chargeOf` reads the first active destination's kind — a card
`IRR`, a wallet its asset — for the quote, the start and the currencies a tenant
may pin. The list answers `confirmationMode` (`automatic` for every gateway but a
manual one confirmed by a person) and `manualKind`, automatic ones first. A start
writes `payment_transfer_detail` (the public fields, frozen) in the payment's own
transaction; the free path writes none. `GET …/transfer` answers 404
`transferNotFound` for anyone else's payment or one that is not a transfer.

`POST /api/billing/deposit/start` on a manual gateway answers the usual body
with `redirectUrl: null` and `transfer: {kind, destination (public fields only),
amountMinor, currencyCode, decimals, windowEndsAt, requiredProof,
confirmationMode}`. The payment is `pending`, `expiresAt = windowEndsAt` + 24 h
grace for a late proof; F-092-k expires it after that.

- **Destination, today:** the first active destination by its sort order.
- **Later — destination** (F-807): weighted random among active destinations whose
  `dailyCapMinor` is not reached today (tenant time zone); none left →
  `no_destination`, and the gateway is not offered until one frees.
- **Amount, today:** exactly the quoted charge; `expectedAmountMinor` stores it.
- **Later — unique amount** (F-804): `expected = charge + k × uniqueStep`, `k` drawn in
  1..999, reserved by `SET NX PX` on
  `billing:transfer:amt:{tenant}:{destinationId}:{expected}` for the window
  (a `RedisKeys.*` builder, C-03). Ten collisions → the next destination; none →
  `amount_unavailable`. The reservation is released on settle and on expiry.
  The offset is the user's cost and is shown as part of the amount; it never
  reaches the wallet as a credit beyond the quoted amount.
- `GET /api/billing/deposit/:paymentId/transfer` re-reads the same body for the
  owner of the payment, plus `status` and `reviewReason`.

## Proof and the queue (F-805-a)

Built 2026-10-15: `payment/manual/transfer-proof.ts` (the rules), `transfer-rows.ts`
(the one lookup), `transfer-return.ts`, `deposit/deposit-proof.{service,controller,module}.ts`.
Both routes are the payment's owner's, on `DEPOSIT_PROOF_RATE_LIMIT` (20 / 15 min).

- `POST /api/billing/deposit/:paymentId/proof/upload`, multipart `file`: JPEG,
  PNG or WebP, ≤ 5 MB (multer cuts it off while it streams), scanned, private,
  at `transfers/<paymentId>/receipt` under the **gateway owner's** prefix
  (corrected: `private-files` serves a Host's own keys only, so the receipt
  lives where its reviewers' panel is). A second upload replaces the first.
  Answers `{key}`.
- `POST /api/billing/deposit/:paymentId/proof`: the gateway's `requiredProof`,
  each checked by its kind (`parseProof`); `receiptImage` must be exactly this
  payment's key and stored. Refusals, as `reason` (+ `error.facts`
  `{field: reason}`): `transfer_not_found` 404 (anyone else's too),
  `transfer_closed`, `proof_already_sent`, `duplicate_ref` (the kind's
  reference already in `transfer_tx_ref`) 409; `invalid_proof`,
  `receipt_missing`, `receipt_rejected` 400. Accepted → `proof`,
  `proofSubmittedAt`, `reviewReason = proof_only`; the row stays `pending`,
  not verifying, and writes `billing.payment.open_changed` (RT-1-j).
- **A proof waits on a person however late** (`WITH_PROOF`): the expiry sweep
  never scans or closes it, and the queue lists it past its lookback.
- **The queue** (F-092-af) gains `transfer` per row: `kind`, destination label,
  expected amount in the charge currency, `network`, proof, `receiptUrl` signed
  for 5 min, `reviewReason`, `canReturn`. Confirm and reject are the existing
  routes (a transfer is `unaskable`). Confirm writes `transfer_tx_ref` in the
  credit's transaction (`recordTransferRef`); a reference credited meanwhile
  rolls it back as `duplicate_ref`. `reject` with `resubmit: true` sends the
  proof back **once** (`proofReturnedAt`): proof cleared, window reopened from
  now with its grace, still `pending`, audited `payment_manual_return`,
  outcome `returned_for_proof`; a second is `cannot_return`.

## Later — matching (F-803-e): the one rule every automatic path calls

`matchTransfer(open payments, observed {destination, amountMinor, at, txRef})`
is a pure function. It credits **only** when the amount equals
`expectedAmountMinor` exactly, the destination is the one assigned, and `at`
falls inside the window; any other observation goes to the queue with its
`reviewReason`. Two open payments on one destination and amount →
`amount_collision`, neither credited. The watcher and the SMS reader (F-806)
call it; no path credits a transfer without it.

## Later — watchers (F-803-f, F-806)

A `TransferWatcher` port: `id`, `networks`, `scan(destination, since)` →
observations. A worker job per gateway in `automatic` mode, every 60 s while
it has open payments (server-side; the page still hears it, never polls —
C-14). First watcher: `tron-usdt` (TRC20 USDT through TronGrid's public
transfer listing, 19 confirmations). Progress writes
`billing.payment.transfer_seen` `{paymentId, confirmations, required}` on
`user:`; a credit writes the existing `billing.payment.confirmed`. A watcher
that cannot reach its source for 15 min flips its gateways' offer to the
manual path (the queue) and writes a staff notice; it never fails a payment.
F-806's SMS reader is the second `TransferWatcher` (card-to-card, tenant-side).
