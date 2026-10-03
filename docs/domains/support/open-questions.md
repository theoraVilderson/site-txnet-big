---
id: support
layer: domain
status: active
updated: 2026-10-03
---

# Open questions — support

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | Live chat needs a realtime transport (WebSocket / SSE). None exists in code. Which? | no | **Answered 2026-09-10 (D-9, and its reversal the same day):** our own WebSocket gateway, one socket per user, authenticated by `forward-auth`. Centrifugo was chosen and then reversed. Built by F-067-h / F-067-i | -> ADR when F-067-h is built |
| 2026-09-04 | Attachment upload path + object-storage (ArvanCloud) credentials/contract? | no | **Answered (D-8, ADR-0112 point 7):** the shared storage port; a row holds the key, a 5-minute signed URL is minted on read | built by F-033-c |
