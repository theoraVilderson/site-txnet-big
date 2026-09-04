---
id: features-manifest
status: generated
---

# Feature catalog manifest — GENERATED, do not hand-edit

Rebuild: `python3 tools/features-scan.py`

- catalog files: 1
- addressable blocks: 11
- features: 26

**Never read the catalog directly.** `python3 tools/spec.py <F-id>` prints exactly the block you need.

## Blocks

| block | lines | features | D/C/INV | entities |
|---|---|---|---|---|
| `App-Features.md:30-39` Status vocabulary | 10 |  |  |  |
| `App-Features.md:40-50` Decisions | 11 |  | D-01 D-02 D-03 |  |
| `App-Features.md:51-60` Constraints | 10 |  | C-01 C-02 |  |
| `App-Features.md:61-75` Invariants | 15 |  | INV-01 INV-02 INV-03 INV-04 |  |
| `App-Features.md:76-79` Identity and Access | 4 |  |  |  |
| `App-Features.md:80-103` · 1.1 Sign-up and sign-in | 24 | F-0101 F-0102 F-0103 F-0104 F-0105 F-0106 | INV-03 | Invitation User |
| `App-Features.md:104-121` · 1.2 Sessions | 18 | F-0107 F-0108 F-0109 F-0110 | C-01 INV-03 | Session |
| `App-Features.md:122-125` Billing | 4 |  | D-01 D-02 INV-01 INV-02 |  |
| `App-Features.md:126-149` · 2.1 Wallet and ledger | 24 | F-0201 F-0202 F-0203 F-0204 F-0205 | D-02 INV-01 INV-02 | LedgerAccount LedgerEntry LedgerTransaction |
| `App-Features.md:150-162` · 2.2 Payments | 13 | F-0206 F-0207 F-0208 F-0209 F-0210 F-0211 | C-02 |  |
| `App-Features.md:163-183` Notifications | 21 | F-0301 F-0302 F-0303 F-0304 F-0305 | INV-03 | DeliveryLog Preference Template |

## Feature index

| id | feature | status | block |
|---|---|---|---|
| F-0101 | Sign up with email + password, account inert until the email is verified | new | 1.1 Sign-up and sign-in |
| F-0102 | Password hashed with argon2id | new | 1.1 Sign-up and sign-in |
| F-0103 | Reject a password found in the breached-password corpus, checked by k-anonymity prefix | new | 1.1 Sign-up and sign-in |
| F-0104 | Invite a person into a workspace by email, with a role, expiring in 7 days | new | 1.1 Sign-up and sign-in |
| F-0105 | Accept an invitation, creating the user if the email is new | new | 1.1 Sign-up and sign-in |
| F-0106 | Sign in with email + password, locked out after 10 failures in 15 minutes | new | 1.1 Sign-up and sign-in |
| F-0107 | Access token valid 15 minutes; refresh token rotated on every use | new | 1.2 Sessions |
| F-0108 | Reuse of an already-rotated refresh token revokes the whole session family | new | 1.2 Sessions |
| F-0109 | Password change revokes every session of that user in the same transaction | new | 1.2 Sessions |
| F-0110 | Sessions expire after 30 days of inactivity | new | 1.2 Sessions |
| F-0201 | Double-entry ledger where every transaction's entries sum to zero | new | 2.1 Wallet and ledger |
| F-0202 | Wallet balance derived by summing entries, never stored | new | 2.1 Wallet and ledger |
| F-0203 | Corrections are a reversal transaction referencing the original | new | 2.1 Wallet and ledger |
| F-0204 | Nightly reconciliation compares every derived balance against the product's view | new | 2.1 Wallet and ledger |
| F-0205 | Manual credit or debit by an admin, requiring a reason and writing an audit row | new | 2.1 Wallet and ledger |
| F-0206 | Card payment via the gateway, confirmed server-side only | new | 2.2 Payments |
| F-0207 | Gateway callbacks idempotent on (gateway, providerTransactionId), unique-constrained in th | new | 2.2 Payments |
| F-0208 | An amount mismatch between quote and callback goes to a human review queue | new | 2.2 Payments |
| F-0209 | Failed payment starts a 7-day grace period; billing keeps accruing | changed | 2.2 Payments |
| F-0210 | Refund to the wallet, never back to the card | new | 2.2 Payments |
| F-0211 | Dunning emails on days 1, 3 and 7 of the grace period | later | 2.2 Payments |
| F-0301 | Notifications published as domain events, never called directly from business logic | new | Notifications |
| F-0302 | Email channel with per-user preferences | new | Notifications |
| F-0303 | Security events ignore mute settings | new | Notifications |
| F-0304 | Every send recorded in a delivery log, including failures | partial | Notifications |
| F-0305 | In-app notification centre | later | Notifications |
