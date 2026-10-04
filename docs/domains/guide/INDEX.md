---
id: guide
layer: domain
status: active
version: 3
keywords: [guide, guides, help, help content, help page, install guide, installation guide, how to install the app, guide per os, guide per app, guide per product, panel help, bot help, inherited guide, override a guide, hide a guide, راهنما, راهنماها, راهنمای نصب, آموزش نصب, راهنمای سیستم عامل, راهنمای اپ, راهنمای محصول, راهنمای پنل, راهنمای ربات, راهنمای ارث برده, شخصی سازی راهنما, پنهان کردن راهنما]
source: [txnet-backend/prisma/domains/guide.prisma, txnet-backend/prisma/domains/migrations/20261004000300_guide_storage/**, txnet-backend/tenant-service/src/app/guide/**, txnet-backend/prisma/domains/migrations/20261004000400_guide_blocks/**, txnet-backend/prisma/domains/migrations/20261004000500_guide_slots/**, txnet-backend/prisma/domains/migrations/20261004000600_guide_draft/**, txnet-backend/prisma/domains/migrations/20261004000700_guide_stats/**, txnet-backend/shared-core/src/lib/guide/**]
owns_tables: [guide, guide_translation, guide_draft, guide_placement, guide_hidden]
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
(ADR-0115–0120). Spec: `python3 tools/spec.py F-414`. All built: storage (F-414-a, blocks -g, slots -h), reading by Host and
by tenant (-b, -f), settings (-c, -d), shown in the panel (-e) and the bot (-f), video (-i, ADR-0118), search (-j), offered before support (-k), views and votes (-l, ADR-0119), storage upkeep (-m, ADR-0120).

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
| 2026-10-04 | draft -> **active**, v1 -> v2 (F-414-b): `GET /api/public/tenant/guides`, cached by generation (ADR-0117) |
| 2026-10-04 | v2 -> v3 (F-414-l): views, votes and their numbers; `ResolvedGuide.id` (ADR-0119) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
