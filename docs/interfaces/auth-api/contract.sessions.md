---
id: auth-api
layer: interface
status: active
version: 39
updated: 2026-10-05
---

# Contract — auth-api / the caller's active sessions

A topic file of [contract.md](contract.md) (§10), opened because that file is
at its 250-line cap. The wire shapes of `/api/auth/sessions` (SES-1-a). What a
place is and what ending one does is
[identity/contract.sessions.md](../../domains/identity/contract.sessions.md);
this file is shapes, codes and limits.

Request schema lives in code: `terminateSessionSchema` in
`txnet-backend/auth-service/src/app/auth/auth.schema.ts`.

## Routes

All three are **Bearer required** and share the `ME_SESSIONS` bucket, 30 / 900s
per caller (`ME_SESSIONS_RATE_LIMIT`). A refusal is 200 with `ok: false`, as
everywhere in this service.

| Method + path | Request | Response | Tenant capability |
|---|---|---|---|
| GET `/auth/sessions` | — | `{sessions: [{id: uuid, current: bool, surface: 'web'\|'telegram'\|'bale', ipAddress: string\|null, userAgent: string\|null, lastActiveAt: ISO}]}` (`auth.sessionsListed`) | `read` |
| POST `/auth/sessions/terminate` | `{id: uuid}`, strict | `{terminated: 1}` (`auth.sessionTerminated`); refusals `auth.sessionNotFound`, `auth.sessionIsCurrent`; 403 while impersonating | `signOut` |
| POST `/auth/sessions/terminate-others` | — | `{terminated: n}` (`auth.otherSessionsTerminated`); 403 while impersonating | `signOut` |

## Rules

| # | Rule |
|---|---|
| 1 | `id` is opaque: the newest row of a place, which a refresh replaces. A client re-reads the list after every end rather than editing its copy |
| 2 | `ipAddress`/`userAgent` are null on a bot chat — nothing was observed (F-048). `surface` names it instead |
| 3 | The writes are `signOut`, so no tenant status refuses them: a suspended tenant's user can still end a stolen session |

Consumers: panel-web (SES-1-b, `settings/_components/SessionsSection.tsx`).
