---
id: billing
layer: domain
status: active
version: 1
updated: 2026-10-15
---

# Contract — billing / an admin freezes one of a user's Grants

A §10 split of [contract.reseller-grants.md](contract.reseller-grants.md), which
was at its ceiling. The rules of a freeze itself — what it stops, its clock, hard
beats soft beats self — are entitlement's ([contract.admin.md](../entitlement/contract.admin.md)
"Freeze", "A freeze has a mode"). The user's own freeze is
[contract.gift.md](contract.gift.md) "Freezing one's own service" (F-0401-c).

## Routes (built — F-311-h, F-0401-d)

`ResellerGrantFreezeController`, under `/api/billing/tenants/:tenantId/users/:userId/grants/:grantId`:

| Route | Body | Answers `data` |
|---|---|---|
| `POST …/freeze` | `{until?, mode?, reason?}` — `until` an ISO instant with offset; `mode` `hard` \| `soft` | `{grantId, frozenUntil, configsDisabled, freezeMode}` |
| `POST …/unfreeze` | `{reason?}` or none | `{grantId, endsAt, configsRestored}` |
| `PUT …/freeze-mode` | `{mode, reason?}` — `mode` `hard` \| `soft`, required | `{grantId, freezeModeBefore, freezeMode}` |

## Rules

| Rule | Why |
|---|---|
| Door `staffWrite` (`grant.assign`), the reseller's user (**404** `user_not_found`) and **the path user's Grant** (**404** `grant_not_found`, read in the write's transaction) — as for config actions | the same fences as every act on the user sheet (`ResellerUserGrantsService`) |
| **`mode` absent is `hard`** (F-0401-d): only an admin lifts it. `soft` lets the user lift it themselves. `self` is refused (**400** `configActionInvalid`): it is the user's own act, counted against their three a day. Soft is allowed on any Grant, prepaid included | catalog F-0401 — the admin chose it; every body from before F-0401-d freezes exactly as it did |
| A frozen Grant takes a freeze that **beats** its mode in place (hard over soft over self); an equal or weaker one is **409** `grant_not_active` | `freezeModeBeats`; lowering a mode is the next row's, said on purpose |
| **`freeze-mode` changes who may lift a frozen Grant**, in either direction and over the user's own freeze: the mode alone — clock, `until` and configs as the first freeze left them. **409** `grant_not_frozen`; **400** `freeze_mode_unchanged`; **409** `grant_moved` (the mode changed in between). Audited `grant_freeze_mode_set` | `setFreezeMode`, conditional on the mode it read; a hard freeze paid off becomes the user's to lift without an unfreeze and a fresh freeze |
| **409** `grant_not_frozen` / `grant_moved` (unfreeze); **400** `freeze_until_not_future` | a quota stop stays the top-up's; a raced end is retried, never shifted twice |
| **The user is told who may lift it** (F-311-s, F-0401-d): a freeze and a mode change are both `entitlement.grant.admin_frozen`, whose closing line is `selfUnfreeze` (soft) or `supportUnfreeze` (hard) — notification [contract.retention.md](../notification/contract.retention.md) | a user frozen softly who is not told so waits for support for nothing; a mode change reads as the freeze it now is |
| Every freeze act — freeze, unfreeze, mode — also writes `entitlement.grant.freeze_changed` to `user:` after its notice (`auditedGrantAct`), single and bulk | the owner's My services re-reads the row (C-14) |
| Bucket `RESELLER_USER_CONFIG_ACTION`, shared with the config actions | all are an admin's writes on a user's service |

Bulk by id and by filter take the same `mode` on `freeze` ([contract.reseller-grants-bulk.md](contract.reseller-grants-bulk.md)).
The panel's mode picker, mode change and history: panel-web [contract.reseller-users.md](../../interfaces/panel-web/contract.reseller-users.md) rules 38–40 (F-0401-f).
