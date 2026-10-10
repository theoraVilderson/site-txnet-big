---
id: adr-0139
status: active
updated: 2026-10-09
---

# ADR 0139 — One word: group

- **Status:** accepted (GR-1; built by GR-1-a … GR-1-g)
- **Date:** 2026-10-09
- **Decision:** the user's (2026-10-09, four answers, each the recommended one)
- **Affects units:** tenant, governance, identity, panel-web
- **Amends:** tenant invariant 21 (the seat as a door), ADR-0138 (7) (no
  `platform.` key through a group)

## Context

A tenant had two pages for one idea. **Team** (F-1201-c): each person holds one
role, and a reseller admits them through a seat (invite, accept, end date).
**User groups** (F-114-m, AC-1-o): named sets of users, a person in many, each
group able to give keys (ADR-0138). The user wanted "a Support group and a
Finance group, one person in both, groups and their access changed at will",
and also "a group of every reseller" or "the heaviest users". Both pages were
asked for in one sentence, with one word: *group*. Two concepts on two pages,
where one person could be on both, confused them.

## Decision

1. **A group is the only way to give access in the panel.** Keys are ticked on
   the group itself. A person's role stays in the data, as the base every
   customer holds (`user`), but the panel no longer offers roles as a thing to
   build. The panel shows the word *group* only — no *team*, no *role*.
2. **Membership is admission.** `ResellerAccess` admits a user of the reseller,
   signed in to it, who holds the route's key, whatever its source (ADR-0138's
   one answer). The seat no longer admits anyone. A group with no key gives
   nothing and admits nobody. So a customer in "VIP" stays a customer.
3. **A membership may end.** `user_group_member.expiresAt` replaces the seat's
   `accessExpiresAt`. `accessOf` ignores an ended membership, and a sweep
   recomputes the person and writes `access.changed` when it ends.
4. **The platform's own groups may give `platform.` keys to its own users**,
   and only to them. The giver must hold the key. This is how the platform's
   staff become a group like any other. A reseller's group may not hold one,
   as before.
5. **A reseller's groups are reached through the reseller's path** (ADR-0064),
   as every other reseller page is. The owner is a platform user and has no
   session on the reseller.
6. **Existing seats and tenant roles become groups**, once, by migration: one
   group per role held by seated people, with the role's keys; its members are
   the seated holders, with the seat's end. The seat table stays for history.
7. **The platform's own people are reached by the route's key, as a
   reseller's are** (GR-1-o, user 2026-10-10). A user of the platform holding
   `user.read`, `grant.read` or `grant.repair` from a platform group reaches
   the platform's own users and their services, as the platform's staff do.
   `platform.tenant.manage` stays the only way to a *reseller's* people, and
   figures stay behind `platform.report.read`. Found when the platform's
   Support group, given `grant.read` and `grant.repair`, had no page to use
   them on.

## Consequences

- The reseller's `staff_members_max` counts people who hold a reseller key
  through a group, not seats (GR-1-b).
- No invitation or acceptance step. A member gets access on the next token
  move, which ADR-0138 already makes immediate, and is told (AC-1-s).
- Not chosen: **keeping the seat and adding invitations to group joins**. That
  leaves two ideas on one page — the confusion this removes. **Keeping roles
  as the thing a group picks**: it works today (AC-1-o), but it puts the second
  word back on screen.
