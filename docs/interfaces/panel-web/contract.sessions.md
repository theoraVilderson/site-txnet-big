---
id: panel-web
layer: interface
status: active
version: 42
updated: 2026-10-05
---

# panel-web — active sessions on `/settings` (SES-1-b)

The "Active sessions" section of the settings page's `profile` tab (UX-1-s):
`settings/_components/SessionsSection.tsx`, over
[auth-api/contract.sessions.md](../auth-api/contract.sessions.md). What ending
a place does is [identity/contract.sessions.md](../../domains/identity/contract.sessions.md).

| # | Rule | Why |
|---|---|---|
| S1 | The list is the server's order: this device first, then newest. A browser is named "Chrome on Windows" by `_lib/sessions.ts` `describeDevice`, else "unknown browser"; a bot chat by its messenger. The IP shows when there is one | a list is read to spot a device that is *not* yours, and a wrong guess at a name hides one |
| S2 | This device has no "End" button | leaving it is the ordinary sign-out, which falls back onto the switcher (ADR-0035) |
| S3 | Every end asks first, inline. On a bot the confirm adds that the bot is disconnected and its notices and codes stop | identity `contract.sessions.md` rule 5 — the one consequence a person would not expect |
| S4 | "End all other sessions" shows only when there are two or more others; after any end, or a refusal, the list is read again | the ids are one refresh from stale (auth-api rule 1) |

Proof: `settings/_lib/sessions.test.ts`; the routes were exercised against the
dev stack on 2026-10-05.
