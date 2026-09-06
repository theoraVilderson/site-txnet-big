---
id: bot-app
layer: interface
status: active
updated: 2026-09-06
---

# bot-app — open questions

Resolved questions are removed, not archived — the decision lives in
`contract.md` or an ADR, and `git log` has the rest.

| Date | Question | Blocking | Exit path |
|---|---|---|---|
| 2026-09-06 | The chat's language is never chosen: `UpdateNormalizer` reads `from.language_code` off **every** update and resolves it against the languages `locale-service` serves (`fa`, `en`), falling back to `DEFAULT_LANGUAGE`. So it is the messenger's UI language, not the user's; Bale often omits the field entirely, which pins those chats to the default; and because it is recomputed per update and stored in neither `NavState` nor the bot session, nothing can change it and nothing keeps it stable across a flow. The panel has a language switch; the bot has no equivalent and no `bot.action.language` key. | no — every string still resolves, and `fa` is right for most chats | → a user decision: add a language step + persist the choice on the bot session (a backlog row of its own), or state in `contract.md` that the messenger's own language is the answer on purpose |
| 2026-09-06 | `bot-service` and `auth-service` each carry their own thin `RedisService` and `LocaleService` adapter (~40 lines apiece). Deliberate for now — two deployables that share no code stay independently deployable — but a third service makes it a `shared-core` library. | no | → move both into `@txnet-backend/shared-core` when a third consumer appears |
| 2026-09-06 | `F-303` has unit tests over stubbed collaborators but no end-to-end run: nothing drives a real webhook POST against a real Redis and a real `auth-service`. The three-tier convention in `CODE-LAYOUT.md` says that question belongs to a `bot-service-e2e` project. | no — the flows are covered per-class | → a `bot-service-e2e` project, mirroring `auth-service-e2e` |
| 2026-09-05 | `F-311`/`F-312` put reseller and sub-reseller management in the bot. Do those flows live in this unit, or is a reseller-facing bot a separate surface with its own menu tree and permissions? Same `BotView` layer either way; the question is the unit boundary. | no — no reseller flow is being built yet | → a §10 split into sub-units (`bot-app/end-user/`, `bot-app/reseller/`) if their consumers and invariants differ |
| 2026-09-05 | `F-318` needs a channel-membership check, which is a call *to* the platform rather than a rendering. Does that belong in `messenger` (it owns platform calls) or is it a capability the bot asks for directly? | no | → a row in `messenger`'s `contract.md` |
| 2026-09-05 | Chat-first (ADR-0009) means `F-308`'s usage chart must work in chat. Rendered server-side as an image (the catalog's wording) or as text/unicode when the file-size or upload capability degrades? The degradation target has to exist before the feature is built. | no — not until `F-308` is started | → a row in `messenger`'s degradation table |

## Recently resolved

| Date | Question | Answer |
|---|---|---|
| 2026-09-06 | Which service hosts this unit? | **A new Nx app, `bot-service`** (user decision, ADR-0011). It owns the inbound webhook and reaches domains only through `auth-api`, with `X-Service-Token` standing in for the captcha a chat cannot solve. |
| 2026-09-05 | Where does conversation state live — Redis or Postgres? | **Both, split by what the user would notice losing.** See ADR-0010 and `contract.md` § Conversation state. |
