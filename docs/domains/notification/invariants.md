---
id: notification
layer: domain
status: draft
updated: 2026-09-04
---

# Invariants — notification

**DRAFT** — extracted from schema comments; none are enforced in code yet.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | A campaign with `tenantId` set only ever creates recipients whose user belongs to that tenant | planned service layer / schema | see contract | 
| 2 | `sentCount` + `failedCount` reconcile with `notification_campaign_recipient` rows | planned service layer / schema | see contract | 
| 3 | Delivery adapters (SMS/bot/push) are outside this unit — it owns *state*, not transport | planned service layer / schema | see contract | 
| 4 | A recipient row moves `queued -> sent | failed` and is not re-queued silently | planned service layer / schema | see contract | 

## How to test

To be written when a service exists.
