---
id: governance
layer: domain
status: draft
updated: 2026-10-13
---

# Invariants — governance

Row 1 is **draft** — extracted from schema comments, not enforced in code yet. Rows 3, 5–9 are enforced; row 2 and 4 were retired with the schema they described (F-030-a, F-030-d).

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | `user_setting` is unique per `(userId, key)` | planned service layer / schema | see contract | 
| 2 | (retired 2026-10-13: `temporal_access_grant` dropped, F-030-a) | — | — |
| 3 | A restriction is one registry key per person, its value as the key's kind reads it, on the person's tenant, and set or lifted only by a writer with authority over them, audited (F-030-d) | PK `(userId, key)`; strict RLS; `restrictionValueOf`; `UserRestrictionsService` (`user-restrictions.spec.ts`) | the enforcement (F-030-e) reads a value it cannot apply, or a peer caps a peer |
| 4 | (retired 2026-10-13: `scope` dropped with the draft table — every restriction refuses, F-030-e) | — | — |
| 5 | A user group and its member rows are exactly one tenant's | strict RLS on `user_group` / `user_group_member`; member FK on the group's `(id, tenantId)` | one tenant's discount or campaign reaches another's users |
| 6 | Only the platform owner's group holds another tenant's user, a reseller, or `allTenants` | `memberRefusal` / `groupRefusal`; trigger `user_group_scope_ok()` | a reseller targets people it does not serve |
| 7 | A member row names exactly one subject, matching `memberType`; once per group | CHECK `user_group_member_one_subject`; uniques `(groupId, userId)`, `(groupId, memberTenantId)` | a member counted twice, or as both |
| 8 | A group a discount rule names is not deleted | `discount_rule_groupId_tenantId_fkey` RESTRICT -> `group_in_use` | a rule silently serves nobody |
| 9 | A group's access (role and keys, AC-1-m) reaches only its own tenant's user members, and only while the membership lasts (`expiresAt`, ADR-0139 (3) — `liveMembership` in every read that asks membership); it is never on `allTenants`, never `*` or `platform.`, and only what the writer holds — attaching it, and adding or removing a member of a group that has it, alike (with authority over that member) | `AccessReader.personalOf`; `setAccess` / `mayMove` (`group-access.spec.ts`) | `user_group.manage` alone hands out keys its holder lacks, or a platform group gives a reseller's customer the platform's keys |

## How to test

User groups: `auth-service/src/app/governance/user-groups/user-group.spec.ts` (rules 5–8; group access, rule 9: `group-access.spec.ts` at the service; the trigger and RLS by hand against a database built from the migrations, F-114-j).
