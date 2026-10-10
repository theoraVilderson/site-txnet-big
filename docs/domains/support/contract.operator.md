---
id: support
layer: domain
status: active
updated: 2026-10-04
---

# Contract — support, the operator's side beyond the inbox

What an agent sees and reaches beyond its own tenant's inbox (`contract.md`
"Agent side"): the platform's staff in a reseller's support (F-033-l), and the
user sidebar (F-033-m). Shape:
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
| A live consent of that reseller (`liveSupportConsent`, audit `contract.md` "Support consent"); none is **403 `consent_required`**, a `read` one on a write **403 `consent_read_only`** | ADR-0104 (4): the reseller decides, the platform asks. Short of one, the caller's own running emergency entry admits as `act` (tier C, F-117-d) |
| **Read on every request**, never cached | a revoke ends access on the next request |
| The work runs as the **reseller's tenant** (RLS scope and `tenantId` filters), the staff member as the agent: `SupportAgentService` unchanged | one rule set for a conversation, whoever answers |
| No presence, no typing | platform staff never make a reseller look staffed (`mode` stays the reseller's own, invariant 11) |
| A thread is not assignable to platform staff (`assignee_unknown`): the assignee is a user of the reseller | the reseller's queue stays the reseller's |

Each admitted request — the inbox viewed as much as a reply — is one
`platform_access` row in the reseller's trail, with the consent id, written by
the door (F-117-c, audit `contract.md` "The platform's trail").

## The agent's sidebar (F-033-m)

`GET /api/support/agent/conversations/:id/context`, and for platform staff
`GET /api/support/tenants/:tenantId/agent/conversations/:id/context` (`read`
consent — it names a person). `agent/user-context.ts`.

Answer: `{userId, user, billing}` — `user` is `{fullName, username}` as the tenant has it (F-033-q), `billing` is billing's `support-context` as it
shaped it (wallet, current Grants, recent invoices, last connection; billing
`contract.md` "Support's sidebar"), or **`null`** when billing fails or
`BILLING_API_BASE_URL` is unset.

| Rule | Why |
|---|---|
| The conversation is found **in the caller's tenant** first (tenant transaction); another tenant's is `not_found` and billing is never asked | billing is handed only a tenant and user support has proved |
| Billing gets the thread's own `userId`, never one from the request | no route here looks up an arbitrary person |
| A billing failure answers `billing: null`, logged, never an error | the sidebar is help, the conversation is the work |
| Billing's tables are never read from support (user, 2026-10-04) | billing decides what of its data leaves |

Not shown yet: the catalog's "recent errors" and ISP (§11.3) — nothing records them per user.

## Retention (F-033-n)

worker-service's `support_retention` (daily 03:30) on `POST
/api/internal/support/retention` (`ServiceOnlyGuard`) → `{expired, months}`.
`retention/retention.ts`; storage in `data-model.md` "Partitions".

| Rule | Why |
|---|---|
| A file goes `SUPPORT_ATTACHMENT_RETENTION_DAYS` (90) after its conversation **closed**; never while open or resolved | user 2026-10-04: files cost the most, and help after the fix rarely |
| The row stays — `expired: true`, no URL — and no longer counts toward the user's quota | the thread still says a file was there |
| A message month older than `SUPPORT_MESSAGE_RETENTION_MONTHS` (12, at least 3) whole months is archived per tenant, then its partition dropped | ADR-0112 point 3; one month is shared by every tenant, so the age is the platform's |
| A month whose archive failed for any tenant is kept and redone whole next run | nothing is dropped without its archive |
| An archive is gzip JSONL on the storage port, private, never served by a route yet | reading one back is a later row |

