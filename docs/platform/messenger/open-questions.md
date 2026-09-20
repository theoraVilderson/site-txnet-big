---
id: messenger
layer: platform
status: active
updated: 2026-09-20
---

# messenger — open questions

Resolved questions are removed, not archived — the decision lives in
`contract.md` or an ADR, and `git log` has the rest.

| Date | Question | Blocking | Exit path |
|---|---|---|---|
| 2026-09-05 | Bale's payments are its own wallet (`sendInvoice`, `answerPreCheckoutQuery`, `inquireTransaction`), Telegram's are provider tokens / Stars. Is in-chat payment (`F-304`) one abstraction over both rails, or does the bot fall back to the existing web invoice flow on one of them? This is the only true presence-difference the docs show. | resolved — **answered 2026-09-09 (user): neither rail is built in chat for now.** Both platforms send the buyer to the existing web checkout, so there is one money path rather than two. Revisit when `F-304` is actually started; nothing here is built, so the reversal is free. Originally **yes** for `F-304` — money, so §9 blocking | → an ADR, with `billing`'s contract naming what a bot-initiated payment is |
| 2026-09-05 | The `F-0203` link token in production is Telegram-shaped (`?start=<token>`). Bale launches a Mini App with `ble.ir/<bot>?startapp` and its bot deep link form needs confirming against `docs.bale.ai` before `F-314`'s payloads (`buy_<sku>`, `ref_<code>`, `trial`) are designed. | **yes** for `F-314`, no for today | → a dated row in `contract.md`'s capability table + a deep-link section. Since 2026-09-06 the shape lives in one file (`deep-link.ts`, `DEEP_LINK_BASE`), so answering it is a one-file change; the live `?start=` form is what both platforms are given today |
| 2026-09-20 | Bale's real send ceiling. `send-rate.ts` gives it 20/s — a guess, taken low on purpose — because `docs.bale.ai` has not been read. Bale also documents a `/business/` path with **higher** limits, so the true ceiling is per path, and `BotSendPacer` models one per platform. | no — the low default only slows a campaign | → a dated row in `send-rate.ts`'s ceiling table, and a per-path key in the bucket's subject if the `/business/` path is used |

## Recently resolved

| Date | Question | Answer |
|---|---|---|
| 2026-09-05 | Does the send queue belong to `messenger` (it knows the limits) or `notification` (it knows the audience)? | **The queue is `notification`'s, the ceiling is `messenger`'s** (user, 2026-09-20, F-313-a). A ban happens to a bot, not to a campaign, so the limit is enforced in the driver for every caller. ADR-0066 + `contract.md` § The outbound ceiling. |
| 2026-09-05 | Two webhook addressing schemes (per-secret route vs `webhookPath`) | **Per bot, one unguessable path each** — user decision. ADR-0009 "Migration path" + `contract.md` § Webhook addressing. |
| 2026-09-05 | Where do capability flags come from — a hand-written table or probed at boot? | **Each platform's official docs, read and dated** (user, 2026-09-05). The table in `contract.md` carries a verification date per row; a flag with no date is not a flag. |
| 2026-09-05 | Does Bale support WebApp, and can a server prove who the viewer is? | **Yes to both.** `window.Bale.WebApp`, and the *same* HMAC-SHA-256 init-data scheme as Telegram (secret = HMAC(bot token, `"WebAppData"`)). `F-310`'s shared session works on both platforms. |
