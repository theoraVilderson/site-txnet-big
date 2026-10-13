---
id: marketing-web
layer: interface
status: draft
version: 1
updated: 2026-10-13
---

# Contract — marketing-web

**DRAFT / skeleton.** `coinsite` is a `create-next-app` scaffold: `src/app/page.tsx`
and a `(Auth)` route group with placeholder `login/page.tsx` and `register/page.tsx`.
No backend calls, no i18n client, no tests.

- **Next.js stays on `site-pwa`'s major** (16 since FE-1-k). The 2026-09 compromise
  came in through this app's Next 15.x while the panel was already patched; one
  major means one advisory to follow, and `eslint.config.mjs` is the panel's.
- **Theme follows the system** through `prefers-color-scheme` in `globals.css` —
  no script, no stored choice, because there is no toggle. A toggle, when built,
  brings its own stored setting and a pre-paint answer, not a post-hydration one.

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
