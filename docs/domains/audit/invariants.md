---
id: audit
layer: domain
status: draft
updated: 2026-09-04
---

# Invariants — audit

**DRAFT** — extracted from schema comments; none are enforced in code yet.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | `admin_audit_log` rows are never updated or deleted by anyone | planned service layer / schema | see contract | 
| 2 | Every impersonation start and end writes an `admin_audit_log` row in the same transaction as the state change (already enforced in `auth-service`) | planned service layer / schema | see contract | 
| 3 | A user belongs to at most one `linked_account_group` (`linked_account_member.userId` unique) | planned service layer / schema | see contract | 
| 4 | Adding an account to a switch group requires `verifiedViaOtp = true` | planned service layer / schema | see contract | 
| 5 | `reasonNote` on an impersonation session is mandatory and >= 10 chars | planned service layer / schema | see contract | 

## How to test

To be written when a service exists.
