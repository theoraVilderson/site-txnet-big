---
id: adr-0143
status: active
updated: 2026-10-14
---

# ADR 0143 — Who may pick a group as an audience

- **Status:** accepted (built by GR-1-w, GR-1-x)
- **Date:** 2026-10-14
- **Decision:** the user's (2026-10-14, the recommended option)
- **Affects units:** governance, billing, catalog, panel-web
- **Builds on:** ADR-0138 (one answer for what a user may do), ADR-0139 (one word: group)

## Context

Discounts, gateways, products and campaigns each name who they serve: everyone,
or a user group. Any manager of the feature could pick any group of the tenant.
The user asked that the choice follow the caller's access: some may target every
user only, some a group such as "resellers" or "VIP", some the Admin or Support
group. The user also asked for an "all users" group; the agent advised against a
real one and the user agreed.

## Decision

1. **"Every user" is a fixed choice in the picker, not a group.** It has no
   members and holds no keys; it is the "everyone" each feature already has.
   Any manager of that feature may pick it.
2. **A group that gives no keys** (a set of customers: "VIP", "resellers") may
   be picked by a manager of the feature who also holds `user_group.read`.
3. **A group that gives keys** (Admin, Support) may be picked only by a caller
   who holds every key the group gives — the rule a member add already holds
   (ADR-0138, `key_not_held`).
4. One function answers it, in governance, and every feature's write and list
   ask it. The panel lists only what the caller may pick; the server refuses the
   rest.

## Consequences

- Nothing to configure per group: a new group, key or reseller is answered by
  the rule as it stands.
- Not chosen: **a per-group "who may target this" setting**. More flexible, but
  one more thing to keep in step with access, and it drifts as tenants grow.
- Not chosen: **a real "all users" group**. Every registration would add a
  member row, every feature would need to read two kinds of "everyone", and a
  key ticked on it by mistake would make every customer staff.
