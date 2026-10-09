---
id: governance
layer: domain
status: draft
updated: 2026-09-25
---

# Invariants — governance

Rows 1–4 are **draft** — extracted from schema comments, not enforced in code yet. Rows 5–8 (user groups, F-114-j) are enforced.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | `user_setting` is unique per `(userId, key)` | planned service layer / schema | see contract | 
| 2 | A `recurring_daily` grant uses `dailyStartTime`/`dailyEndTime` + `timezone`; a `one_time` grant uses `startAt`/`endAt` — never both | planned service layer / schema | see contract | 
| 3 | `user_restriction` is logically unique per `(userId, restrictionKey)` on active rows only (needs a partial unique index — 'section 99') | planned service layer / schema | see contract | 
| 4 | A `hard_block` restriction is enforced before the action; a `soft_warning` only annotates | planned service layer / schema | see contract | 
| 5 | A user group and its member rows are exactly one tenant's | strict RLS on `user_group` / `user_group_member`; member FK on the group's `(id, tenantId)` | one tenant's discount or campaign reaches another's users |
| 6 | Only the platform owner's group holds another tenant's user, a reseller, or `allTenants` | `memberRefusal` / `groupRefusal`; trigger `user_group_scope_ok()` | a reseller targets people it does not serve |
| 7 | A member row names exactly one subject, matching `memberType`; once per group | CHECK `user_group_member_one_subject`; uniques `(groupId, userId)`, `(groupId, memberTenantId)` | a member counted twice, or as both |
| 8 | A group a discount rule names is not deleted | `discount_rule_groupId_tenantId_fkey` RESTRICT -> `group_in_use` | a rule silently serves nobody |
| 9 | A group's access (role and keys, AC-1-m) reaches only its own tenant's user members, and only while the membership lasts (`expiresAt`, ADR-0139 (3) — `liveMembership` in every read that asks membership); it is never on `allTenants`, never `*` or `platform.`, and only what the writer holds — attaching it, and adding or removing a member of a group that has it, alike (with authority over that member) | `AccessReader.personalOf`; `setAccess` / `mayMove` (`group-access.spec.ts`) | `user_group.manage` alone hands out keys its holder lacks, or a platform group gives a reseller's customer the platform's keys |

## How to test

User groups: `auth-service/src/app/governance/user-groups/user-group.spec.ts` (rules 5–8; group access, rule 9: `group-access.spec.ts` at the service; the trigger and RLS by hand against a database built from the migrations, F-114-j).
