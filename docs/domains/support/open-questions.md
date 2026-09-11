---
id: support
layer: domain
status: draft
updated: 2026-09-10
---

# Open questions — support

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | Live chat needs a realtime transport (WebSocket / SSE). None exists in code. Which? | no | **Answered 2026-09-10 (D-9, and its reversal the same day):** our own WebSocket gateway, one socket per user, authenticated by `forward-auth`. Centrifugo was chosen and then reversed. Built by F-067-h / F-067-i | -> ADR when F-067-h is built |
| 2026-09-04 | Attachment upload path + object-storage (ArvanCloud) credentials/contract? | no | ASSUMED(2026-09-04): presigned upload via a support service | -> interfaces / operations |
