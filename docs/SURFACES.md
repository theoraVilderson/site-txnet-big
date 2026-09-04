---
id: surfaces
status: active
updated: 2026-09-04
code_roots:
  - site-pwa/src
  - coinsite/src
  - txnet-backend/auth-service/src
  - auth-handler/internal
  - i18n-platform/services/locale-service
---

# Surface map — what the user can point at

`MASTER_INDEX.md` answers *"which unit owns this concern?"*. This file answers
the question a user actually asks: **"the register form on the landing site is
broken"** — a thing they can see, named in their own words, with no path
attached.

One row per user-visible surface: a screen, a tab, a button, a form, a bot
command, a public endpoint. Resolve a row with:

```bash
python3 tools/where.py "the register form on the landing site"
```

Never make the user say a path. If they had to, this file is missing a row.

## Rules

- `surface` — kebab-case, permanent, unique. It is an **id**, not a label.
- `aliases` — comma-separated, in the words a person actually types, including
  the sloppy short forms. This column is the whole point of the file; a row
  without aliases will never be found by a human's own phrasing. **Add an alias
  the moment a query misses.** Persian phrasing goes here too — `tools/where.py`
  normalises Persian/Arabic script.
- `unit` — must exist in `MASTER_INDEX.md`. A surface with no owning unit is a
  BLOCKING question (`00-PROTOCOL.md` §9), not a row to invent.
- `component` — a real path or glob, checked by `python3 tools/where.py --check`.
  This is the **only** place a UI path is written down.
- `spec ref` — the catalog id, never a line range. `—` if the surface predates
  the catalog.
- One surface = one thing a person can point a finger at. A page with six
  independent controls is one row for the page **plus** a row for each control
  that gets edited on its own.
- Never delete a row. A removed surface keeps its id and gets `(removed)` in the
  note, for the same reason a catalog id is never deleted.

## Panel (site-pwa)

| surface | aliases | route | unit | component | spec ref | note |
|---|---|---|---|---|---|---|
| panel-auth-proxy | auth proxy, login proxy, api auth proxy | /api/auth/[...path] | panel-web | site-pwa/src/app/api/auth | — | |
| panel-register-proxy | register proxy, signup proxy | /api/auth/register | panel-web | site-pwa/src/app/api/auth/register | — | |
| panel-i18n-route | i18n route, translations endpoint | /api/i18n/[lang]/[ns] | panel-web | site-pwa/src/app/api/i18n | — | |
| panel-auth-screens | login screen, auth screens, login page | /(auth)/auth | panel-web | site-pwa/src/app/(auth)/auth | — | |

## Marketing (coinsite)

| surface | aliases | route | unit | component | spec ref | note |
|---|---|---|---|---|---|---|
| marketing-login | landing login, login page on landing site | /(Auth)/login | marketing-web | coinsite/src/app/(Auth)/login | — | |
| marketing-register | landing register, signup page on landing site | /(Auth)/register | marketing-web | coinsite/src/app/(Auth)/register | — | |

## API

| surface | aliases | route | unit | component | spec ref | note |
|---|---|---|---|---|---|---|
| auth-api-register | register endpoint | POST /auth/register | auth-api | txnet-backend/auth-service/src/app/auth | — | |
| auth-api-login | login endpoint, password login | POST /auth/login/password | auth-api | txnet-backend/auth-service/src/app/auth | — | |
| auth-api-impersonate | impersonation, impersonate user | POST /admin/users/:userId/impersonate | auth-api | txnet-backend/auth-service/src/app/impersonation | — | |

## Bot / other

| surface | aliases | route | unit | component | spec ref | note |
|---|---|---|---|---|---|---|
| | | | | | | |
