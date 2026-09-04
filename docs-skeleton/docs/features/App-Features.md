---
id: app-features
status: active
version: 1
updated: 2026-09-04
---

# Acme — Feature Catalog

> Acme is a subscription service sold to small teams. One workspace per customer,
> a shared wallet, and per-seat billing. What makes it different: a team can pause
> a subscription without losing its data.
>
> Assumption of this document: it describes the **target state**. What is actually
> built lives in `docs/BACKLOG.md`, never here.

---

**This file is a worked example.** It is deliberately small — three sections,
sixteen features — and it exercises every construct the format has, so you can
see the shape before you replace it with your own catalog.

Written to `docs/FEATURES-FORMAT.md`. Validate every edit:

```bash
python3 tools/features-scan.py --check     # must exit 0
python3 tools/spec.py F-0104               # what one feature costs to read
```

## Status vocabulary

| status | meaning |
|---|---|
| `core` | specified in an earlier version of this catalog, unchanged |
| `new` | added in this version |
| `changed` | a previous decision was reversed — cites a `C-nn` |
| `partial` | infrastructure exists, no surface for it yet |
| `later` | designed, schema reserved, deliberately not built now |

## Decisions

Top-level rules. Where anything below contradicts one of these, the decision
wins. Keep this list short. If everything is a decision, nothing is.

| id | decision | why |
|---|---|---|
| D-01 | Money is stored as integer minor units in one currency. There is no second currency column, ever. | Floats and per-currency columns are the two ways a ledger silently stops balancing. |
| D-02 | A balance is always derived by summing ledger entries. No column is ever written with a balance. | A stored balance and its entries drift, and the drift is discovered by a customer, not by us. |
| D-03 | Deleting a workspace is reversible for 30 days, then irreversible. | Accidental deletion is common; regulatory deletion must actually delete. |

## Constraints

Conflicts that were found and resolved. Each row records what disagreed and what
was chosen, so nobody re-litigates it in six months.

| id | conflict | resolution |
|---|---|---|
| C-01 | §1.2 expired sessions after 30 days of inactivity, but §2.2 needs a webhook to reach a workspace whose members have not logged in for months. | Sessions still expire at 30 days. Webhooks authenticate with a workspace key, never a user session. The two never share a credential. |
| C-02 | The first draft paused billing on a failed payment, and also kept the subscription active during the grace period. Those cannot both be true. | Billing keeps running through the grace period; the debt accrues. Pausing stays a deliberate customer action, never an automatic consequence of a failed charge. |

## Invariants

Things that must never happen. These migrate verbatim into each unit's
`invariants.md`, where they outrank every contract. Worth more than the feature
rows — extract them explicitly rather than leaving them buried in prose.

| id | invariant | blast radius if broken |
|---|---|---|
| INV-01 | Ledger entries sum to zero per transaction, enforced by a database trigger. | Silent money loss, unrecoverable once it has compounded across months. |
| INV-02 | `ledger_entry` is append-only. No `UPDATE`, no `DELETE`, enforced by a `REVOKE`. | The audit trail becomes fiction; no dispute can be settled. |
| INV-03 | A password reset invalidates every session of that user in the same transaction. | An attacker keeps access after the victim has locked them out. |
| INV-04 | A workspace key never appears in a log line, an error body, or an API response after creation. | Full workspace takeover from a log aggregator. |

---

## Section 01 — Identity and Access

Who a person is, and what they may do. This section owns nothing about money.

### 1.1 Sign-up and sign-in

A person signs up with an email and a password, or is invited into an existing
workspace. Invitation is the common path: most users never see the sign-up form.

Owned state:

```
User(id, email, passwordHash, emailVerifiedAt, createdAt)
    email: unique per workspace, not globally

Invitation(id, workspaceId, email, role, token, expiresAt, acceptedAt)
    expiresAt: 7 days from issue
```

| id | feature | status | depends_on | note |
|---|---|---|---|---|
| F-0101 | Sign up with email + password, account inert until the email is verified | new | — | an unverified account holds no seat and can be reaped after 24h |
| F-0102 | Password hashed with argon2id | new | F-0101 | not bcrypt, not SHA — this is a one-way door once users exist |
| F-0103 | Reject a password found in the breached-password corpus, checked by k-anonymity prefix | new | F-0101 | only the first 5 hash chars leave our network |
| F-0104 | Invite a person into a workspace by email, with a role, expiring in 7 days | new | F-0101 | the common path into the product; treat it as the primary funnel |
| F-0105 | Accept an invitation, creating the user if the email is new | new | F-0104 | INV-03 applies from the moment the account exists |
| F-0106 | Sign in with email + password, locked out after 10 failures in 15 minutes | new | F-0102 | lockout is a Redis TTL key, never a column — a real user must never be locked out permanently |

### 1.2 Sessions

Sessions are server-tracked so that a sign-out is real. A JWT alone cannot be
revoked, so the token is short-lived and the server holds the authority.

```
Session(id, userId, refreshTokenHash, issuedAt, lastSeenAt, revokedAt)
```

| id | feature | status | depends_on | note |
|---|---|---|---|---|
| F-0107 | Access token valid 15 minutes; refresh token rotated on every use | new | F-0106 | rotation is what makes theft detectable |
| F-0108 | Reuse of an already-rotated refresh token revokes the whole session family | new | F-0107 | the only reliable signal that a token was stolen |
| F-0109 | Password change revokes every session of that user in the same transaction | new | F-0107 | INV-03. Same transaction, not a follow-up job |
| F-0110 | Sessions expire after 30 days of inactivity | new | F-0107 | C-01: webhooks use a workspace key instead, never a session |

---

## Section 02 — Billing

Money. Read `D-01`, `D-02`, `INV-01` and `INV-02` before touching anything here.

### 2.1 Wallet and ledger

A workspace has exactly one wallet. Its balance is never stored — it is the sum
of its ledger entries, and a nightly job proves that sum still matches what the
product believes.

```
LedgerAccount(id, workspaceId, kind)
    kind: wallet | revenue | gateway_clearing | promotional_liability

LedgerTransaction(id, kind, reference, description, actorUserId, createdAt)
    kind: topup | charge | refund | adjustment | reversal

LedgerEntry(id, transactionId, accountId, amountMinor)
```

| id | feature | status | depends_on | note |
|---|---|---|---|---|
| F-0201 | Double-entry ledger where every transaction's entries sum to zero | new | — | INV-01, enforced by a trigger — not by application code |
| F-0202 | Wallet balance derived by summing entries, never stored | new | F-0201 | D-02 |
| F-0203 | Corrections are a `reversal` transaction referencing the original | new | F-0201 | INV-02: the original row is never touched |
| F-0204 | Nightly reconciliation compares every derived balance against the product's view | new | F-0202 | any mismatch is Sev-1 and pages a human; it never self-heals |
| F-0205 | Manual credit or debit by an admin, requiring a reason and writing an audit row | new | F-0201 | built before any gateway, so the ledger can be exercised end to end |

### 2.2 Payments

| id | feature | status | depends_on | note |
|---|---|---|---|---|
| F-0206 | Card payment via the gateway, confirmed server-side only | new | F-0201 | a browser redirect carrying a success flag is not confirmation |
| F-0207 | Gateway callbacks idempotent on `(gateway, providerTransactionId)`, unique-constrained in the database | new | F-0206 | the constraint is the mechanism; retries are guaranteed, not hypothetical |
| F-0208 | An amount mismatch between quote and callback goes to a human review queue | new | F-0207 | never auto-credit a figure we did not quote |
| F-0209 | Failed payment starts a 7-day grace period; billing keeps accruing | changed | F-0206 | C-02: the first draft paused billing here, which made the debt vanish |
| F-0210 | Refund to the wallet, never back to the card | new | F-0203 | keeps every refund inside one currency and one ledger |
| F-0211 | Dunning emails on days 1, 3 and 7 of the grace period | later | F-0209 | schema reserved; not built until churn data justifies it |

---

## Section 03 — Notifications

One delivery path, several channels. A notification is a domain event, never a
direct call from business logic — the billing service publishes `payment.failed`
and does not know whether email exists.

```
Template(key, channel, languageCode, subjectKey, bodyKey)
Preference(userId, eventKey, channels, isMuted)
DeliveryLog(id, userId, channel, templateKey, status, providerRef, createdAt)
```

| id | feature | status | depends_on | note |
|---|---|---|---|---|
| F-0301 | Notifications published as domain events, never called directly from business logic | new | — | the seam that lets a channel be added without touching billing |
| F-0302 | Email channel with per-user preferences | new | F-0301 | — |
| F-0303 | Security events ignore mute settings | new | F-0302 | INV-03's sibling: nobody may opt out of being told their password changed |
| F-0304 | Every send recorded in a delivery log, including failures | partial | F-0302 | the table exists; nothing reads it yet |
| F-0305 | In-app notification centre | later | F-0301 | designed, not built |

**Also relevant here, defined elsewhere:** F-0208 §2.2 · F-0211 §2.2.
