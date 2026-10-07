---
id: billing
layer: domain
status: active
version: 1
updated: 2026-10-06
---

# Contract — billing / manual transfer: card-to-card, a wallet, and the next method (F-803…F-807)

A top-up the user pays by moving money themselves: to a bank card, to a
crypto wallet, or to any method added later. Decided by the user on
2026-10-06 (D-60); written before any of it is built, so an implementing
session has nothing left to decide. **Nothing below exists yet** — each rule
names the backlog row that builds it. The pages are
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
   part needs no rebuild: the `confirmationMode` column (only `manual` is
   accepted — no kind has a watcher yet), the descriptor's `uniqueStep` and
   `watcherFor` (none), `transfer_tx_ref`, and the `transfer_seen` slot on the
   pay page. Sections marked **later** below are its spec, not today's work.
5. **The proof a user sends is the seller's choice per gateway** (D-60 part 4),
   from the fields the kind declares.
6. **Money of record is unchanged.** The wallet is credited in base currency
   through the ledger (F-092-b); what the user sent is a receipt
   (`amountReceivedMinor` + `receivedCurrency`, F-104-a), never money of record.

## Storage (F-803-a)

Additive migration. `PaymentProviderName` gains `manual_transfer`;
`GatewayCategory` gains `manual`. **Later:** `ConfirmationSource` gains
`chain_watch` (F-803-f) and `sms_match` (F-806), each with its row.

| table | holds | rule |
|---|---|---|
| `manual_gateway_setting` | per gateway row: `kind`, `confirmationMode` (`manual`/`automatic`), `requiredProof` (string[] of the kind's proof field ids), `windowMinutes` (default 30, 10..1440), `instructionsKey` override text (optional, per locale) | one per gateway; `(source, gatewayId)` unique, `source` = `tenant`/`platform` as in the vault label |
| `manual_destination` | `gatewayId`, `label`, `fields` (JSON, validated by the kind), `isActive`, `weight` (1..100), `dailyCapMinor` (optional) | RLS by tenant; a destination referenced by an open payment is deactivated, never deleted |
| `payment_transfer_detail` | `paymentId` (PK), `destinationId`, `destinationSnapshot` (the fields shown to the user), `expectedAmountMinor`, `chargeCurrency`, `chargeDecimals`, `network` (crypto), `windowEndsAt`, `proof` (JSON), `proofSubmittedAt`, `reviewReason` (enum below, nullable), `seenTxRef` | written by `start`; the snapshot is what the user saw, so editing a destination never changes an open payment |
| `transfer_tx_ref` | `(tenantId, network, txRef)` unique — a tx hash, a bank tracking number or an SMS reference | one external reference credits at most once per tenant, whichever path saw it first |

`reviewReason`: `underpaid`, `overpaid`, `late`, `wrong_destination`,
`duplicate_ref`, `amount_collision`, `no_match`, `proof_only`.

## Method kinds (F-803-b)

`ManualMethod` descriptor: `kind`; `destinationFields` (id, type, validator,
`public` — shown to the payer or not); `proofFields` (id, type, validator);
`chargeCurrency(fields)` and `chargeDecimals(fields)`; `uniqueStep` (the
smallest offset unit, F-804); `watcherFor(fields)` → a watcher id or none.

| kind | destination fields | proof fields | charges |
|---|---|---|---|
| `card_to_card` | `cardNumber` (16 digits, Luhn), `holderName`, `bankId` (derived from the 6-digit BIN, overridable), `sheba` (optional, `IR` + 24 digits, checksum) | `receiptImage`, `trackingCode`, `sourceCardLast4`, `paidAt` | `IRR`, 0 decimals; priced through the FX rate as a rial gateway (F-092-c) |
| `crypto_wallet` | `asset` (`^[A-Z0-9]{2,10}$`), `network` (free text, shown verbatim), `address`, `memo` (optional), `decimals` (0..18) | `txHash`, `receiptImage`, `paidAt` | the asset, its `decimals`; priced by the gateway's rate (F-0609: static or live) |

The BIN → bank table is data in `payment/manual/kinds/iran-banks.ts`
(id, BIN prefixes, colour pair, logo id); an unknown BIN shows `bankId = other`
and is still accepted.

## Gateway admin (F-803-c)

The gateway routes of contract.gateways.md take `category: manual` with a
`manual` body (`kind`, `confirmationMode`, `requiredProof`, `windowMinutes`);
destinations are `GET|POST /api/billing/gateways/:id/destinations`,
`PATCH|DELETE …/destinations/:destId`. Same scope as `gateway.manage`; every
write audited (`gateway_manual_*`). A manual gateway needs no vault secret, so
F-092-u's merchant check passes it; it needs **at least one active
destination** to be offered. `confirmationMode = automatic` is refused
(`automatic_unavailable`) unless every active destination has a watcher.

## Starting one (F-803-d; later F-804, F-807)

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

`POST /api/billing/deposit/:paymentId/proof` by the payment's owner: the
gateway's `requiredProof` fields, each validated by its kind; `receiptImage`
is an object-storage key from `POST …/proof/upload` (image/jpeg, png, webp;
≤ 5 MB; stored under the tenant prefix, ADR-0120). A `txHash`/`trackingCode`
already in `transfer_tx_ref` → `duplicate_ref`, refused. Accepted → the row
stays `pending` with `proofSubmittedAt` set and `reviewReason = proof_only`
(manual mode). It is **not** `verifying` (`nextVerifyAt` stays null: there is
no gateway to ask), but the expiry sweep skips it the same way, and it writes
the manual list's one re-read signal, `billing.payment.verifying_changed` on
`tenant:` (RT-1-j). One proof per
payment; a second is refused unless a person sent it back (`reject` with
`resubmit: true`, which reopens the window once).

The manual-payments list (F-092-af) also lists a pending row with a proof, and gains `transfer` (destination label, expected amount,
proof, image URL signed for 5 min, `reviewReason`). Confirm and reject are the
existing routes; confirm writes the `transfer_tx_ref` row in the same
transaction and credits `admin_manual`.

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
