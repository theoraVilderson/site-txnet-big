---
id: support
layer: domain
status: active
updated: 2026-10-04
---

# Contract — support, the operator's side beyond the inbox

What an agent sees and reaches beyond its own tenant's inbox (`contract.md`
"Agent side"): the platform's staff in a reseller's support (F-033-l). Shape:
[ADR-0104](../../architecture/decisions/0104-platform-staff-see-a-resellers-people-only-with-its-consent.md) (4), catalog §11.6.

## Platform staff in a reseller's support (F-033-l)

`/api/support/tenants/:tenantId/agent/*` — the agent routes, minus presence and
typing, for a reseller named in the path. `agent/platform-agent.controller.ts`,
door `agent/platform-door.ts`.

| Route (under the prefix) | Consent needed |
|---|---|
| `GET conversations` (the inbox, same query as the agent's), `GET conversations/:id/messages`, `POST conversations/:id/read` | `read` |
| `POST conversations/:id/messages` (reply or note), `…/assign`, `…/priority`, `…/resolve`, `…/close` | `act` |

| Rule | Why |
|---|---|
| The caller's own tenant is `platform_owner` and they hold `support.agent`; otherwise **403 `not_platform_staff`**, before any consent is read | a reseller's agent has its own inbox; this door is the platform's only |
| The path names a reseller, not deleted, not terminated; otherwise **404 `reseller_not_found`** | one answer for both |
| A live consent of that reseller (`liveSupportConsent`, audit `contract.md` "Support consent"); none is **403 `consent_required`**, a `read` one on a write **403 `consent_read_only`** | ADR-0104 (4): the reseller decides, the platform asks |
| **Read on every request**, never cached | a revoke ends access on the next request |
| The work runs as the **reseller's tenant** (RLS scope and `tenantId` filters), the staff member as the agent: `SupportAgentService` unchanged | one rule set for a conversation, whoever answers |
| No presence, no typing | platform staff never make a reseller look staffed (`mode` stays the reseller's own, invariant 11) |
| A thread is not assignable to platform staff (`assignee_unknown`): the assignee is a user of the reseller | the reseller's queue stays the reseller's |

Not yet: each act recorded with tier and consent id in the reseller's history
(F-117-c, ADR-0104 (6)); a reply already names its sender in the thread.
