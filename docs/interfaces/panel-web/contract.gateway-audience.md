---
id: panel-web
layer: interface
status: active
version: 1
updated: 2026-10-08
---

# Contract — panel-web: who sees a gateway (F-102-g-e)

A topic file of [contract.md](contract.md) (§10). The panel half of billing's
[contract.gateways.md](../../domains/billing/contract.gateways.md) "Who a gateway
is offered to": `PUT …/gateways/:source/:id/audience`, and `userGroupIds` on
every gateway the editor reads.

1. **A section of the gateway editor with its own save** —
   `gateways/_components/GatewayAudienceSection.tsx`, under the editor's four
   sections. Billing takes it on its own route and replaces the set whole, so
   it is never part of the editor's "what changed" footer; saving it leaves
   the editor open and re-reads the list.
2. **Two choices, `RadioCards`:** everyone, or chosen groups only — then a
   checkbox per group with its member count. Chosen-groups with none ticked is
   refused before the request (`audienceError`): a gateway offered to nobody is
   switching it off, which is its own control. No groups yet says so instead
   of an empty list.
3. **Whose groups.** `GatewaySurface.groups`: the ambient page lists the
   session tenant's (`/auth/user-groups`), a reseller's workspace its own by
   path (`/auth/tenants/:id/user-groups`, F-102-g-d) — on the platform panel
   and at `/reseller/gateways` alike.
4. **Only on a gateway the surface's tenant owns** (`ownsAudience`). The
   platform owner's `/gateways` also lists every reseller's gateways; their
   audience is set from that reseller's workspace, with its groups.
5. **The list marks a limited gateway** with a "groups only" pill beside its
   active state.
6. **Not in the add wizard.** A new gateway is offered to everyone; its
   audience is set in the editor afterwards.

Proof: `gateways/gateway-audience.test.tsx`.
