# messenger

The only place a Telegram/Bale difference may appear: one driver per platform, a
dated capability set (`F-301`), the degradation policy (`F-302`), and one
renderer that turns a platform-agnostic `BotView` into that platform's payload.

Docs: `docs/platform/messenger/INDEX.md` + `contract.md`, ADR-0009.

Two consumers, which is why this is a library and not part of `bot-service`:
`auth-service` (OTP delivery to a linked chat) and `bot-service` (every screen).

Run `nx test messenger` for the unit tests.
