---
id: adr-0170
status: accepted
updated: 2026-11-01
---

# ADR 0170 — Where images and packages come from is one committed switch

- **Status:** accepted
- **Date:** 2026-11-01
- **Decision:** the user's (2026-11-01: «وقتی نت ملی شد من چیز های خارجی بتونم
  mirror کنم»; «اگه بخوام یهو بگردونم حالت قبل … قابلیت اینو داشته باشم»;
  «با پیشنهاد تو میریم جلو»)
- **Affects units:** hosting

## Context

Builds and host downloads fetched from abroad: Docker Hub (through Arvan's
mirror), npm, Go modules, Alpine, Prisma's engines, Debian and PyPI, GitHub
releases. In a national-internet outage they stop. The user set up our own
mirrors (Nexus for packages, `registry.mytxnet.ir` for images) and wanted to
switch back to the previous sources at once when the internet is open.

The addresses lived in `.env`. Production holds `.env` sealed with SOPS to the
node's age key, so switching production meant ssh to the node and `sops edit`
there, under time pressure, on the day it matters.

## Decision

1. Three variables, `DOCKER_REGISTRY`, `PKG_MIRROR`, `APK_MIRROR`, leave `.env`
   for a plain committed `mirrors.env`, read after every env file so it wins.
   Nothing in them is secret.
2. Two whole profiles, `scripts/mirrors/local.env` and `upstream.env`;
   `scripts/mirrors/mirrors.py local|upstream` copies one into `mirrors.env`,
   `status` says which and whether each source answers.
3. A switch takes on the build host at once and in production at the next
   release, like any committed change. No path through the sealed files.
4. Alpine keeps its own variable: the upstream profile must restore Arvan's
   Alpine mirror (dl-cdn stalls from Iranian datacenters), which one Nexus base
   cannot say.

## Consequences

- The rules are `docs/platform/hosting/contract.mirrors.md` M1…M4.
- A stale `DOCKER_REGISTRY` in a sealed `.env` is harmless (it is overridden)
  and is removed the next time that file is edited.
- A mirror holds only what passed through it: it is warmed by building while the
  internet is open. Forgejo (the code mirror) is not part of this switch yet.
