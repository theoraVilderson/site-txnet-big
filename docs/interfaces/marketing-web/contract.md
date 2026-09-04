---
id: marketing-web
layer: interface
status: draft
version: 1
updated: 2026-09-04
---

# Contract — marketing-web

**DRAFT / skeleton.** `coinsite` is a `create-next-app` scaffold: `src/app/page.tsx`,
a `(Auth)` route group with `login/page.tsx` and `register/page.tsx`, and empty
`lib/auth.ts` / `register.ts` files. No backend calls, no i18n client, no tests.

## TL;DR

Public marketing pages. Routed by Traefik at `Host(<domain>) || Host(www.<domain>)`,
container port 8080. Ships `winston` logging deps but nothing wired.

## Provides

Static/SSR pages only. No API, no events.

## Consumes

Nothing yet. If it grows auth, it should proxy to `auth-api` like `panel-web`.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
