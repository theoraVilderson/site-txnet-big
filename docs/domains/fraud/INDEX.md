---
id: fraud
layer: domain
status: active
version: 2
keywords: [fraud, device fingerprint, flag]
source: [txnet-backend/billing-service/src/app/fraud/**]
owns_tables: [device_fingerprint, fraud_flag]
depends_on: [identity]
updated: 2026-10-03
---

# Fraud

**Responsibility (one sentence):** central anti-fraud: device fingerprints for multi-account detection, and `fraud_flag` records with a severity and an optional automatic protective action.
**Explicitly NOT responsible for:** permanently banning users (admin decision, `identity`), the periodic scan jobs themselves (`automation`).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing fraud from outside |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-04 | Documented from schema during onboarding — no service yet |
| 2026-10-03 | v2, active: device fingerprint built in `billing-service` (F-036-a, D-11) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
