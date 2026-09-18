---
id: panel-web
layer: interface
status: active
version: 20
updated: 2026-09-18
---

# panel-web — the domain's brand (F-066-v, ADR-0059)

A topic file of `contract.md` (§10). The panel wears the brand of **the domain
it was loaded on** — name, light/dark logo, favicon, OG image, colours — from
tenant's public `GET /api/branding` (`domains/tenant/contract.branding.md`).

## The rule

The brand is read **by host, never by session**. On a reseller's domain the
reseller's owner is signed in to their own platform tenant (ADR-0059 (1)), and
the page is still the reseller's: the request is scoped to the session, the
surface only brands it (`ResolvedTenant.brand ?? current`). A read that took
the session's tenant would show the owner the platform's brand on their own
domain. So the read carries the visitor's host and no cookie.

## Where it is read

| | |
|---|---|
| who | the root layout (`app/layout.tsx`), on the server, before first byte |
| code | `lib/branding.ts` (`fetchBranding`, `parseBranding`, `brandStyle`); the host is `lib/visitor-host.ts`, shared with the session guard |
| hop | `TENANT_SERVICE_ORIGIN` (internal, `http://tenant-service:3000`) with `Host: <visitor host>`; unset -> `https://<visitor host>`, where Traefik routes `/api/branding` on every host |
| transport | `node:http`, not `fetch`: `fetch` drops a `Host` header, and tenant-service resolves `/api/branding` from `Host` alone (tenant rule 6) |
| cache | per host, 60s, in process; capped at 500 hosts, then cleared — every host reaches this app, so the key is the visitor's choice |
| timeout | 2s |

Server-side on purpose: the first HTML already carries the title, favicon,
colours and logo. A white-label page that paints the platform's name before its
own shows every reseller's customer whose platform it is.

## What it renders

| brand field | where |
|---|---|
| `brandName` | `<title>`, OG title, the sidebar and the auth nav (`components/BrandMark.tsx`) |
| `logoLightUrl` / `logoDarkUrl` | `BrandMark`: the `light` theme takes the light logo, `dark` and `ocean` the dark one; each falls back to the other, then to the name's initial on the accent colour |
| `faviconUrl`, `ogImageUrl` | `generateMetadata` in the root layout |
| `primaryColorHex` | `--accent-primary`, and `--accent-glow` / `--leaf-bg` mixed from it, as a style on `<html>` — over every theme block |
| `secondaryColorHex` | `--card-gradient`, from primary to it; only with a primary |

Client components get it through `context/BrandContext.tsx` (`useBrand()`).

## Rules

| Rule | Why |
|---|---|
| 1. Every field is checked again before it renders: a colour is `#rrggbb` or dropped, a URL `https` or dropped, a name 1-64 characters or the whole brand is null | tenant rule 3: the schema is the second wall, the renderer the first. A colour reaches a style, a URL an `<img>` |
| 2. The name is text React escapes; no field is ever `dangerouslySetInnerHTML` | a `</title>` in a brand name reaches every visitor |
| 3. **No brand is the neutral look**, not the platform's: the host itself as the name, the theme's own colours, the default favicon. That is a 404 (not a tenant's door), a failed or slow read and a body that does not parse | a reseller's page must never show the platform's or another tenant's name, and must never fail to render for want of a brand |
| 4. A logo is a plain `<img>`, not `next/image` | the file is served on the tenant's own domain, which `next/image` would need in `remotePatterns` per reseller |

A replaced logo can take up to 60s here plus the file route's five minutes
(`max-age=300`) to show.
