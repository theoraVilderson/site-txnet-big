---
id: panel-web
layer: interface
status: active
version: 23
updated: 2026-09-20
---

# Contract — panel-web: a reseller's bot (F-066-w6)

A topic file of [contract.md](contract.md) (§10), and the fourth screen of the
reseller workspace described in [contract.resellers.md](contract.resellers.md)
"A reseller's workspace" (ADR-0064 (4)) — its rules 18 and 25 hold here too.

| page | route | files |
|---|---|---|
| its bot | `/my-resellers/[id]/bot` (`myResellerBotPath`) | `my-resellers/[id]/bot/_components/ResellerBotView.tsx`, rules `my-resellers/_lib/bots.ts` |

Its calls are `resellerBotsApi` (`lib/auth-api.ts`) over
`/api/auth/tenants/:tenantId/bots` — list, connect, retire. Every rule behind
them is [automation/contract.bots.md](../../domains/automation/contract.bots.md);
the wire shapes are
[auth-api/contract.reseller-bots.md](../auth-api/contract.reseller-bots.md).
The console's bot step links here (`stepHref`), which is the whole reason the
screen exists.

## Rules

1. **The reseller is the path's, never the session's.** A reseller's owner
   signs in to the platform owner's tenant (ADR-0059), so an ambient bot
   surface would connect a bot to the **platform** and answer 201 doing it.
   `resellerBotApiPath(tenantId)` builds every call and the spec holds it
   against the controller's own `@Controller` path.
2. **The body is the two fields the schema takes** (`connectBody`): the
   messenger and the pasted token, trimmed. The schema is `.strict()`, so a
   `tenantId` or a `role` is refused rather than ignored — the tenant is the
   path's, and every bot connected here is the `primary` (C-05). The `@handle`
   is never sent: it comes from `getMe`, because a typed one would file the row
   under a name no deep link resolves to.
3. **The token is held only against what the schema checks** (`botToken`:
   1-200 after a trim) and nothing about its shape. Both messengers have
   changed their format; the judge that cannot go stale is the messenger's own
   answer, which arrives as `invalid_token`.
4. **A connect the messenger did not register is still a connect.** `201` with
   `registered: false` is said out loud in the gate's own tone — the row is
   `pending` and `bot-service` registers it on its next boot — and the screen
   retries nothing. The same for a retire: `webhookRemoved: false` means the
   token is dead and the row gone, and the card says the messenger was never
   told rather than reporting a failure.
5. **One bot per messenger, said before the call.** A second is
   `primary_exists` (`isPrimaryTaken`), so the form disables its own submit and
   names the reason instead of spending a write on a refusal — the write bucket
   here is the tightest authenticated one on auth-service.
6. **A retire is asked once and names the `@handle`.** The webhook path is the
   bot's whole address and therefore a credential (F-323, ADR-0009): it is not
   on the wire, not in `ResellerBot`, and not in this screen. No token is ever
   read back either. The confirmation is there because the token is revoked and
   the reseller's customers stop reaching the bot.
7. **One sentence per refusal** (`BOT_REFUSAL_KEYS`, namespace
   `common.resellerBots`). It covers both doors — `ResellerAccess` and
   `ResellerBotService`'s own — and the spec reads the union from the
   controller's exhaustive `STATUS` map, so a reason added there has no blank
   line here.
8. **Printed, never inferred.** The status, its sentence and the role are the
   view's, and every status the Prisma enum can hold has a label — the spec
   reads the enum from source.
