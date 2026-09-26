---
id: adr-0089
status: active
updated: 2026-09-26
---

# ADR 0089 — a config line is named when it is served, never on the panel

- **Status:** accepted
- **Date:** 2026-09-26
- **Affects units:** network (a column), billing (`billing-config-list`, a label write), sub-api (`/sub`), panel-web (My services), tenant (a template, second stage)
- **Decision row:** D-47 (the agent's recommendation, accepted by the user)

## Context

The name a VPN app shows for an imported line is the line's `#fragment`, or
`ps` in a `vmess://` JSON. The driver builds it as x-ui's page does
(ADR-0088): the inbound's remark, the client's email, the proxy's remark.
The result is something like `DE-1-tx_ab12cd`, which means nothing to the
buyer. The user (2026-09-26) wants a buyer to name each config, wants a
copied line to carry that name, and wants a default name. They asked where
the default belongs and when it should be set.

The client's name on the panel is one of the keys a config is matched by
(F-027-aa), and changing it reads as drift (`renamed`). The stored lines are
served from two readers in two languages: billing's config list (TypeScript)
for the panel, and `sub-service` (Go) for `/sub`.

## Decision

1. **Display only.** A name is never written to the panel. `network.config`
   gets `userLabel` (nullable). Capture keeps storing the lines exactly as
   the panel built them.
2. **Named where served, by both readers alike.** Billing's config list and
   `/sub` replace a line's name as they answer it: the `#fragment` of a URI
   line, or `ps` of a `vmess://` line. A line of any other shape is answered
   unchanged. A copied line and an imported `/sub` show the same name. The
   two implementations share one file of cases, and each language's test
   reads it.
3. **Resolution order:** the buyer's `userLabel`, then the tenant's template,
   then the platform template, then the panel's own name. The platform
   template is `{region}`, the panel's region as the admin wrote it
   (e.g. `آلمان`). A name already given in the Grant gets ` 2`, ` 3` (the
   first free), so no two lines share a name in an app, even two configs in
   one region. Both readers number the same list: configs not retired whose
   lines are their current client's, oldest first, before `/sub` drops what
   it does not serve.
4. **The default is a template evaluated per request, not a value stored at
   create.** A tenant's template (`{brand}`, `{region}`; numbering stays automatic) lives in
   that tenant's branding settings, because in a white-label product the
   name in the buyer's app belongs to the reseller's brand. A changed
   template reaches every config without a stored label at once, with no
   backfill.
5. **A buyer's label** is at most 40 characters, trimmed, and any character
   allowed (percent-encoded in the fragment). An empty label clears it back
   to the default. It is written only by the config's owner, through
   billing, like the other config actions.

## Consequences

- A line copied before a rename keeps its old name until it is copied
  again. An app that imported `/sub` picks up the new name on its next
  refresh.
- Two small naming functions, one per reader, held together by a shared
  case file. A new line shape means one change in each.
- The panel shows the name the API answers. It never builds one itself.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Rename the client on the panel | the name is a matching key; a rename reads as drift and is repaired back |
| Store the default name on each config at create | a rebrand or template change would need a backfill of every config |
| Store named lines beside the raw ones | every template change re-renders every stored line of the tenant |
| Name lines in the browser at copy time | `/sub` would show a different name for the same config |
| A platform-only default | the reseller's brand never reaches the buyer's app; rebuilt once tenants ask |

## Revisit trigger

A third reader of the stored lines. The naming then moves into one shared
place, instead of a third copy.
