---
id: adr-0154
status: accepted
updated: 2026-10-18
---

# ADR 0154 — a reseller package is built whole, in one wizard, apart from the catalog

- **Status:** accepted, not built (series PK-1-a … PK-1-i)
- **Date:** 2026-10-18 (user: "we go with your recommendation"; backlog it so
  that a session can run each row without asking again)
- **Affects units:** tenant, shared-core, billing (catalog texts), ai, panel-web
- **Builds on:** ADR-0106 (limits at three levels), ADR-0107 (quotas, product
  listing), ADR-0050 and its amendments (item text in locale-service),
  UX-1-f (kit `Wizard`)

## Context

A package ("Gold") is defined today in three places on two pages: name,
prices, features and wholesale rates in one long sheet on
`/resellers/packages`; its limits on `/resellers/limits`, where every card is
one *limit* with a column per package; and the platform products it sells,
with their sales quotas, at the bottom of that same page. Nothing on the
packages page says that the other two exist. Because a reseller sells only
the products its package lists (ADR-0107 point 3), a package created on the
sheet alone sells nothing, and nothing tells the owner. The sheet has no
wizard and no guide, while the catalog's product create has both.

The package's name is one plain string, so a buyer reading the "become a
reseller" page in another language sees it in whatever language it was typed.

## Decision

1. **The data stays apart from the catalog.** A product is what an end user
   buys from a tenant's wallet; a package is what a reseller buys from its
   billing wallet, with features, limits, quotas, wholesale rates and
   prorated upgrades (ADR-0107). Different buyer, ledger and lifecycle.
   Merging them would make every catalog rule (discounts, audience, sales
   cap, rate cards) ask "package or product?". What is shared is the *way*
   of building: the kit `Wizard`, `ReviewRows`, and the translated name.
2. **One page per package**, `/resellers/packages/[id]`: prices, features,
   the products it sells with their quotas, its limits (its own value beside
   the platform's), overage modes and wholesale rates, each section edited
   in its own sheet over the endpoints that exist today. `/resellers/limits`
   stays for "one limit, every package and reseller". The list's card opens
   the page.
3. **Create is a kit `Wizard`**, in this order, each step checked before the
   next: name and description (source language + text) → prices → features →
   products and quotas → limits → wholesale rates → review. Defaults:
   - products: **every active platform product ticked**, no window, `stop` —
     the same default ADR-0107's amendment gave the packages existing then,
     so a new package sells unless the owner narrows it;
   - limits: every registry key shown at the platform's value, labelled as
     the platform's; only a value the owner changes is written, and "no
     limit" is an explicit choice, never an empty field;
   - wholesale rates: blank allowed, and the review says in words what a
     blank one stops the reseller selling (contract.reseller-packages 4–4c).
   The review lists what the package sells and warns when it sells no
   product or prices no traffic. Edit is never the wizard: it is the page.
4. **Create is one request and one transaction.** `POST /tenant-packages`
   gains optional `limits`, `quotaOverages` and `products`, written with the
   package in tenant-service's one transaction — all of it or none (the
   tables are all in the `tenant` schema). The body without them stays
   valid. A refusal names the field, and the wizard returns to its step.
5. **Name and description are locale-service text**, as a product's are:
   namespace `packages` under `shareds`, key `packages.p_<id, no dashes>.name`
   / `.description`, derived by the server only. The owner picks a source
   language (default `DEFAULT_LANGUAGE`) and writes it; every other language
   gets a machine draft that a human publishes. Read falls back
   requested → source language → the `name` column. `name` stays (unique,
   the source text, used by refusals and logs); `sourceLang` is a new
   nullable column, additive.
6. **One writer for item text.** The generic part of billing's
   `CatalogTextService` (source language, drafting, publishing, review) moves
   to `shared-core`, parametrised by namespace and key pattern; the catalog
   keeps its keys and behaviour and its suite proves it. tenant-service uses
   the same writer, and the panel's `TranslationsView` reviews package
   drafts through its surface (`useCatalogSurface`'s api) over
   `/api/tenant-packages/translations`, with catalog's request shapes.
7. **Every reader shows the translated name:** the packages list and page,
   "become a reseller" (with the description), the resellers list and a
   reseller's page, a reseller's own subscription, and the AI upgrade
   suggestion (`packageName` becomes the key, resolved at delivery in the
   recipient's language).
8. **A package listing no product is flagged** on its card and its page,
   with a link to the products section.

## Consequences

- Building a package is one place and one flow; a half-built package cannot
  be saved by the wizard.
- `PackageSheet`'s create path is deleted with the wizard (C-21); its edit
  fields move to the page's section sheets.
- Rejected: packages as catalog products (two lifecycles in one model);
  a wizard writing step by step over the existing endpoints (a failure
  midway leaves a package that sells nothing); a `name` per language in a
  JSON column (a second translation system beside locale-service).
- `usageIncludedJson` / `overageRuleJson`, unused since D-41, are dropped
  (PK-1-i, the user's call 2026-10-18): their meaning lives in
  `package_product`, `package_quota_overage` and the meter rates.
