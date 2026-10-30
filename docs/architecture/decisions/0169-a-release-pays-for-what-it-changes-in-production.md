---
id: adr-0169
status: accepted
updated: 2026-10-30
---

# ADR 0169 — A release pays for what it changes in production

- **Status:** accepted (row OPS-1-ah-l)
- **Date:** 2026-10-30
- **Decision:** the user's (2026-10-30: «یه دکمه فقط درست کردم داخل پنل و قرار بره
  پروداکشن 30 دقیقه طول میکشه»; «راه اصولی و بلند مدت … که حتما در بلند مدت به
  مشکل نخوریم»)
- **Affects units:** hosting (release)
- **Amends:** ADR-0166 point 4 and ADR-0168 point 4: "every release passes the
  twin" becomes "every release the reach cannot clear passes the twin".

## Context

A release took about 30 minutes whatever it changed. The twin alone measured
21 minutes (2026-10-29): k3s up, production's commit deployed from scratch and its
data restored, HEAD over it, then `ready`, `panels` (up to 600s), `roll` (up to
600s waiting for a quiet host) and `stores`. `roll` always rolls billing-service
and `stores` always kills the same three stores. They prove the platform's shape,
not the change. So a panel button paid for a rehearsal of Kubernetes. As services,
languages and resellers grow, the twin grows, and a release that is always slow is
the one people learn to route around.

The repo already scopes work by reach in two places: tests and typecheck run what
Nx's import graph says a change reaches, and R12 rolls only the images whose source
moved. Only the twin ignored it.

## Decision

1. **The reach is measured from what production would run.** Production's commit
   and HEAD are each rendered by their own render, and the two are compared: moved
   image tags (a service's code, R12) and every other difference (the platform's
   shape). No list of paths to keep in step with the code.
2. **A service declares what proves it**, in its compose file (`x-release`). It
   says either that it is safe without the twin (`lane: quick`) or which twin check
   covers it. The tool names no service, so the next frontend or store declares
   itself in its own change.
3. **Quick only when proven quick.** No twin only when the shape is unchanged and
   every moved image is declared quick. Otherwise the twin runs, with `ready` plus
   the declared checks, or all of them for a change of shape.
4. **Unknown is full.** A reach that cannot be measured (`--full`, `--from`, a
   commit that does not render here, a production running other than its checkout)
   takes the full twin. A misspelt declaration stops the release.
5. **The owner's approval and production's own safety stay on every lane**: the
   typed approval (ADR-0168 point 4), and the smoke check with automatic setting
   back (R6, R7).
6. **Every step reports its time**, so the next slow step is found by a figure.

## Consequences

- A change to site-pwa or coinsite alone goes out in minutes: checks, reach (~40s),
  build, approval, and a deploy that rolls one pod. A migration, a shared library or
  a locale-client change still takes the full twin, because every service is
  reached. That is the case the twin exists for.
- A frontend change is not tried on production's data before production. The owner
  tries it on the dev stack. A failure there is caught by the smoke check, or undone
  by `rollback` in minutes.
- Rejected: skipping the twin by a flag the person chooses (the decision would be a
  guess under time pressure); path globs per lane (they drift from the render);
  keeping the twin always and only narrowing its checks (staging's start, two
  deploys and the restore stay, over 10 minutes for a button).
