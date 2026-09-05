---
id: surfaces
status: active
updated: 2026-09-05
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
| panel-auth-proxy | auth proxy, login proxy, api auth proxy, register proxy, signup proxy |  | panel-web |  | — | (removed) 2026-09-05 — replaced by panel-auth-direct; browser calls auth-service cross-origin now instead of via a same-origin Next.js hop |
| panel-auth-direct | refresh token cookie, refresh_token cookie, کوکی رفرش توکن, کوکی ست نمیشه, مستقیم به api, direct api call, api.txnet.cyou مستقیم | `${NEXT_PUBLIC_API_ORIGIN}/api/auth/*` | panel-web | site-pwa/src/lib/auth-api.ts | — | browser -> auth-service direct, cross-origin, `credentials:"include"`; cookie lands via auth-api's CORS (`FRONTEND_ORIGIN` + `credentials:true`), not a proxy rewrite; see panel-web/contract.md TL;DR for the latency tradeoff this accepts |
| panel-i18n-route | i18n route, translations endpoint | /api/i18n/[lang]/[ns] | panel-web | site-pwa/src/app/api/i18n | — | |
| panel-auth-screens | login screen, auth screens, login page | /(auth)/auth | panel-web | site-pwa/src/app/(auth)/auth | — | |
| panel-captcha-widget | captcha, slide captcha, human verification, bot check, کپچا, تایید ربات, اسلایدر کپچا | (embedded in login/signup/forgot-password) | panel-web | site-pwa/src/app/(auth)/auth/_components/NatureCaptchaUI.tsx | F-0201 | driven by `_hooks/useCaptcha.ts` |
| panel-password-field | password field, password label, floating label, autocomplete پسورد, پسورد لیبل بالا نمیره, اتوکامپلیت پسورد لیبل بالا نمیره | (embedded in login/signup/forgot-password) | panel-web | site-pwa/src/app/(auth)/auth/_components/PasswordField.tsx | — | label float relied on React `value` state; browser/password-manager autofill doesn't fire onChange, so label stayed down until a manual click — fixed 2026-09-05 via `:-webkit-autofill` CSS-animation detection |

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
| auth-api-captcha | captcha endpoint, human verification api, bot check api, کپچا, تایید ربات | POST /auth/captcha/challenge, POST /auth/captcha/verify | auth-api | txnet-backend/auth-service/src/app/auth/captcha | F-0201 | required (`X-Captcha-Token`) on register/login/forgot |

## Bot / other

| surface | aliases | route | unit | component | spec ref | note |
|---|---|---|---|---|---|---|
| | | | | | | |

## Flows

A surface is a thing you point at. A flow is a **behaviour that crosses units**:
a cookie login touches `panel-web`, `auth-api` and `redis-keyspace`.
`python3 tools/where.py --walk "<sentence>"` derives that chain from
`depends_on` plus the runtime edges in
`architecture/dependency-graph.md` every time it is asked. This table is the
cache.

**Never write a flow row in advance.** A row written before the walk is a guess
at which files matter, and it is wrong in the most expensive way — it looks like
knowledge. Rows are written **after** a fix, from the path actually taken, by
MODE: DIAGNOSE (`00-PROTOCOL.md` §6g) step 7. The second time the same thing is
reported, there is no walk at all.

- `flow` — kebab-case, permanent, unique. An id, like a surface.
- `aliases` — **the user's own sentence, verbatim**, symptom words included,
  Persian phrasing included. That is the row's whole value.
- `path` — the unit chain, `->` separated, in the order the walk took it. Every
  id must exist; `where.py --check` fails otherwise.
- `files` — only the files the fix actually touched, not the files that were
  read. A flow row is evidence, not a reading list.
- Never delete a row. A flow that stops existing keeps its id and gets
  `(removed)` in the note.

| flow | aliases | path | files | spec ref | note |
|---|---|---|---|---|---|
| | | | | | |
