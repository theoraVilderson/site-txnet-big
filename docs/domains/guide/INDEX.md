---
id: guide
layer: domain
status: draft
version: 1
keywords: [guide, guides, help, help content, help page, install guide, installation guide, how to install the app, guide per os, guide per app, guide per product, panel help, bot help, inherited guide, override a guide, hide a guide, راهنما, راهنماها, راهنمای نصب, آموزش نصب, راهنمای سیستم عامل, راهنمای اپ, راهنمای محصول, راهنمای پنل, راهنمای ربات, راهنمای ارث برده, شخصی سازی راهنما, پنهان کردن راهنما]
source: [txnet-backend/prisma/domains/guide.prisma, txnet-backend/prisma/domains/migrations/20261004000300_guide_storage/**, txnet-backend/tenant-service/src/app/guide/**]
owns_tables: [guide, guide_translation, guide_placement, guide_hidden]
depends_on: [tenant, i18n]
updated: 2026-10-04
---

# Guide

**Responsibility (one sentence):** help content — one guide per product, OS,
app or panel/bot section, its text per language and where it is placed; the
platform's inherited by every reseller, who may replace or hide one (ADR-0115).
**Explicitly NOT responsible for:** what is for sale (`catalog`), branding
(`tenant`), translating the UI itself (`i18n`), rendering it (`panel-web`,
`bot-app`).

Planned as a module of `tenant-service` with its own `guide` schema
(ADR-0115). Spec: `python3 tools/spec.py F-414`. Storage is built (F-414-a);
no route serves it yet — F-414-b … F-414-f.

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing guides from outside |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-10-04 | Created (draft, F-414 broadened by the user; ADR-0115) — no code yet |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
