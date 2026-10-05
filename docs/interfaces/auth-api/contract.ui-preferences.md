---
id: auth-api
layer: interface
status: active
version: 40
updated: 2026-10-05
---

# Contract — auth-api / the caller's display preferences

A topic file of [contract.md](contract.md) (§10), opened because that file is
at its 250-line cap. The wire shapes of `/api/auth/me/ui-preferences` (UX-1-k).
What each key means to the panel is
[panel-web/contract.ux.md](../panel-web/contract.ux.md) P1–P4; where they are
stored is [governance/contract.md](../../domains/governance/contract.md).

Schemas live in code: `UI_PREFERENCE_SCHEMAS` in
`txnet-backend/auth-service/src/app/governance/ui-preferences/ui-preferences.ts`.

## Routes

Both are **Bearer required** and share the `ME_UI_PREFERENCES` bucket, 120 /
900s per caller (`ME_UI_PREFERENCES_RATE_LIMIT`).

| Method + path | Request | Response | Tenant capability |
|---|---|---|---|
| GET `/auth/me/ui-preferences` | — | 200, every key with defaults filled in (`auth.uiPreferences`) | `read` |
| PATCH `/auth/me/ui-preferences` | any subset of the keys below | 200, every key after the write (`auth.uiPreferencesSaved`); 400 `{reason}` on a refusal, nothing written | `account` |

| Key | Value | Default |
|---|---|---|
| `ui.motion` | `'system' \| 'full' \| 'reduced'` | `'system'` |
| `ui.dashboard` | `{order: string[], hidden: string[]}`, ≤30 ids each, an id 1–40 chars | `{order: [], hidden: []}` |
| `ui.pins` | `string[]`, ≤8, each 1–200 chars | `[]` |
| `ui.sidebar` | `{collapsed: boolean, closedSections: string[]}`, ≤30 ids, 1–40 chars | `{collapsed: false, closedSections: []}` |

## Rules

| # | Rule |
|---|---|
| 1 | Refusals: `unknown_preference` (a key not in the table — checked before any value), `invalid_preference` (a value off its schema, an extra field, a body that is not an object), `preference_too_large` (a value whose JSON is over 4096 bytes) |
| 2 | A PATCH is one transaction: two keys land as both or neither |
| 3 | A stored value that no longer fits its key's schema reads as the default, so narrowing a schema needs no migration |
| 4 | Only the caller's own rows, by the token's `sub`; there is no path to another user's |

Consumers: panel-web (UX-1-l, `src/stores/ui-preferences-store.ts`; `ui.pins` and
`ui.sidebar.closedSections` from UX-1-m, `PanelSidebar.tsx`).
