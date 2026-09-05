---
id: bot-app
layer: interface
status: draft
updated: 2026-09-05
---

# bot-app — open questions

Resolved questions are removed, not archived — the decision lives in
`contract.md` or an ADR, and `git log` has the rest.

| Date | Question | Blocking | Exit path |
|---|---|---|---|
| 2026-09-05 | Which service hosts this unit — a new Nx app (`bot-service`) or a module inside an existing one? ADR-0009 rules out `auth-service` as a permanent home but does not name the replacement. | **yes** for any implementation item | → an ADR, with `docs/CODE-LAYOUT.md` roots + `unit_aliases` updated in the same change |
| 2026-09-05 | `F-311`/`F-312` put reseller and sub-reseller management in the bot. Do those flows live in this unit, or is a reseller-facing bot a separate surface with its own menu tree and permissions? Same `BotView` layer either way; the question is the unit boundary. | no — no reseller flow is being built yet | → a §10 split into sub-units (`bot-app/end-user/`, `bot-app/reseller/`) if their consumers and invariants differ |
| 2026-09-05 | `F-318` needs a channel-membership check, which is a call *to* the platform rather than a rendering. Does that belong in `messenger` (it owns platform calls) or is it a capability the bot asks for directly? | no | → a row in `messenger`'s `contract.md` |
| 2026-09-05 | Chat-first (ADR-0009) means `F-308`'s usage chart must work in chat. Rendered server-side as an image (the catalog's wording) or as text/unicode when the file-size or upload capability degrades? The degradation target has to exist before the feature is built. | no — not until `F-308` is started | → a row in `messenger`'s degradation table |

## Recently resolved

| Date | Question | Answer |
|---|---|---|
| 2026-09-05 | Where does conversation state live — Redis or Postgres? | **Both, split by what the user would notice losing.** See ADR-0010 and `contract.md` § Conversation state. |
