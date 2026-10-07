---
id: adr-0127
status: active
updated: 2026-10-06
---

# ADR 0127 — an inbound is sold by every group, or by the groups it lists

- **Status:** accepted (nothing built yet — rows F-027-ep..F-027-ev)
- **Date:** 2026-10-06
- **Affects units:** billing (systems routes, group fulfilment, drain), entitlement (Grant), network (`panel_inbound` schema), panel-web (systems page, users)
- **Decision row:** D-64 (the agent's recommendations, accepted by the user)
- **Amends:** ADR-0090 decision 3 ("an inbound is the default pool's or one group's")

## Context
ADR-0090 let one panel serve many groups, but an inbound is either the
panel's default pool — sold by **every** group holding the panel — or **one**
group's. And a membership with any inbound of its own stops selling the pool.
So a router's OpenVPN cannot be sold by groups A, B and C while A also has a
V2Ray inbound of its own. The admin's only workaround is a second registration
of the panel, which ADR-0090 refuses for good reason.

Three other gaps show up as soon as an inbound is shared:

- **Seats.** A member's effective `maxClients` counts every Grant on the panel,
  of every group and tenant, so one busy group uses up another's room.
- **A Grant's group is only inferred.** It is read through `variantId ->
  product_variant.panelGroupId` in about ten billing files. A migrated Grant
  (`variantId` null) has no group, and moving a Grant to another group would
  mean changing what was bought.
- **Taking a group off an inbound** with live configs is refused
  (`inbound_has_configs`), with no way forward. The admin may want those users
  moved, or simply removed from that inbound.

Usage and money are unaffected: a client is one config of one Grant (its own
`claimTag`), and metering, ceilings and the lease planner work per Grant. A
shared inbound changes who may be **placed** on it, not how traffic is counted.

## Decision
1. **An inbound's audience is explicit.** `panel_inbound.audience` is
   `every_group` (today's pool) or `listed`. A `listed` inbound is sold by
   exactly the memberships in `panel_group_member_inbound`: none, one
   (dedicated) or several (shared). The unique `(panelId, inboundRemoteId)` is
   dropped. A membership sells its listed inbounds **plus** the panel's
   `every_group` ones. A group that joins later gets the `every_group` inbounds
   and none of the listed ones. `sellingInbounds` stays the only resolution.
2. **The migration moves nobody.** An assigned inbound becomes `listed` with
   its one group. Where any member of a panel has an assignment, every pool
   inbound becomes `listed` to the members without one, so no group gains or
   loses an inbound. Elsewhere the pool stays `every_group`.
3. **Two caps.** The inbound's `maxClients` and the panel layer's `maxClients`
   stay physical caps, counted over every Grant. A listing may carry its own
   `maxClients`, the group's share of that inbound. It counts only Grants of
   that group, and so does a member-layer `maxClients`. Every cap that applies
   must have room, all under the panel's fulfilment lock.
4. **A Grant names its group.** `entitlement.grant.panelGroupId` is set at
   issue from the variant, back-filled for existing Grants, and written by a
   migration commit from its target. Every reader of "this Grant's group"
   (fulfilment, the due scan, drain and evict, delivery, the caps, analytics by
   group) reads the Grant, never the variant. A renewal keeps the Grant's group.
   A new purchase takes the variant's.
5. **Moving a Grant to another group** changes `panelGroupId` only: money,
   quota and end date stay as they are. A config on an inbound the target group
   also sells on that panel stays where it is: same client, same link, no write
   to the panel. Every other config is moved by `ConfigActions.move`. A target
   that cannot deliver (F-111-i) or whose share is full refuses that Grant, with
   the reason. Single, or bulk as a move job.
6. **Releasing an inbound is the admin's choice, never a side effect.**
   Removing a group from a listing, or turning `every_group` into `listed`
   without it, while that group has live configs there, is still 409
   `inbound_has_configs`. The answer now names the count for each group and two
   ways out, each a job with live progress (C-14): **move** (each config to that
   group's next placement; a Grant with no target is reported and left
   serving) or **empty** (the configs there are retired; a Grant left with no
   line follows a chosen `pause | refund`, as an evict does, F-027-eg). The
   listing is removed only after the job ends.

## Consequences
- Positive: one router's OpenVPN, or any inbound, serves any chosen set of
  groups with no second registration. Fair shares stop one group starving
  another. Moving users between groups that share an inbound costs no new link.
  Migrated Grants get a group.
- Negative / accepted cost: one more column on `panel_inbound` and on the
  Grant, and a back-fill. About ten files switch from the variant's group to the
  Grant's. A Grant's group can now differ from its variant's, and the panel shows both.
- User Manager: an "inbound" is a router entry (`ListInbounds`). Every buyer
  logs in with their own name over the panel-wide `ovpnProfile`, so sharing
  needs nothing family-specific.
- What this forecloses: inferring a Grant's group from what was bought.

## Alternatives rejected
| Option | Why rejected |
|---|---|
| A member flag "also sell the pool", ownership still pool-or-one | cannot share with B and C but not D; reopened as soon as resellers multiply |
| Only the inbound's total cap | one group or reseller can take every seat, and the rest drop out of the shop silently |
| Move a Grant between groups by changing its variant | ties a placement change to price and plan; impossible for a migrated Grant |
| Releasing an inbound moves its users automatically | one wrong click changes hundreds of links |
