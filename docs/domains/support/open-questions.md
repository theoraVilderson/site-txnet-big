---
id: support
layer: domain
status: draft
updated: 2026-09-04
---

# Open questions — support

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | Live chat needs a realtime transport (WebSocket / SSE). None exists in code. Which? | no | ASSUMED(2026-09-04): a future gateway service; REST polling until then | -> ADR / interfaces |
| 2026-09-04 | Attachment upload path + object-storage (ArvanCloud) credentials/contract? | no | ASSUMED(2026-09-04): presigned upload via a support service | -> interfaces / operations |
