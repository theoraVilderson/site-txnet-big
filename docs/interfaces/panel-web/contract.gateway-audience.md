---
id: panel-web
layer: interface
status: active
version: 2
updated: 2026-10-14
---

# Contract — panel-web: who a record is for (F-102-g-e, GR-1-x)

A topic file of [contract.md](contract.md) (§10). One audience picker for every
feature that aims at a group (ADR-0143): the panel half of governance
`contract.md` "A group as an audience". The file keeps its first subject's name.

1. **One picker** — `_components/AudiencePicker.tsx`, rows from `_lib/audience.ts`
   (`audience.test.ts`). "Every user" is a fixed first choice, never a group (`[]`
   is what every feature stores); then the groups the caller may pick, each with
   its live user count and, when it gives keys, a "gives access" badge. A group
   the record has that the caller may not pick is a `kept` row: shown, removable,
   never re-pickable. No group to pick says so; a failed read says so.
2. **Whose groups** — `useAudienceGroups(tenantId)` over `GET /auth/audience-groups`
   (the session's tenant) or `GET /auth/tenants/:id/audience-groups` (a reseller's
   workspace, on the platform panel and at `/reseller/...` alike). The server's
   rule decides the list, so a save never meets a group the picker offered.
3. **Where it is** — multiple: a gateway's and a product's audience section
   (`_components/AudienceSection.tsx`: own save, the set replaced whole on the
   feature's own route, never part of the editor's "what changed"); single: a
   discount rule's group (its own radio keeps "every user" and "named users", so
   the picker hides "every user"), the wheel's group, a lottery's group (required:
   no "every user"). The campaign page (F-035-k, not built) takes it single.
4. **Only on a record the surface's tenant owns** (`ownsAudience`, gateway and
   product): the platform owner's lists include every reseller's; their audience
   is set from that reseller's workspace, with its groups.
5. **A refusal** `audience_not_allowed` reads `common.audience.notAllowed` on every
   page that names its reasons (discount, catalog, reseller gateways and catalog,
   wheel, lottery).
6. **The lists mark a limited gateway or product** with a "groups only" pill. A
   new gateway is offered to everyone; its audience is set in the editor after.

Proof: `_lib/audience.test.ts`, `gateways/gateway-audience.test.tsx`.
