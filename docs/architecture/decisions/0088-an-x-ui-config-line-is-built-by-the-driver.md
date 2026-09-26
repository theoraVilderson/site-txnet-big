---
id: adr-0088
status: active
updated: 2026-09-26
---

# ADR 0088 — an x-ui config line is built by the driver, not read from the panel

- **Status:** accepted
- **Date:** 2026-09-26
- **Affects units:** network (`contract.links.md` rule 1), panel-web and sub-api (read only)
- **Decision row:** D-46 (the user's call, over the agent's recommendation of a fallback)
- **Amends:** `docs/domains/network/contract.links.md` rule 1 ("none is assembled here")

## Context

On 2026-09-26 the user opened My services and saw no connection line for any
config, only "this server gives no link for this config". Every active config
on the dev panel (`x_ui_alireza`) had `linksCapturedAt` set and zero
`linkLines`. The capture reads x-ui's own subscription server, which is off
by default in x-ui. When it is off, or it answers nothing, capture records
"a panel that gives none" (rule 2). That covers the page, and `/sub` too,
because ADR-0082 renders `/sub` from the same stored lines.

The user wants a config to always have a line a VPN app can import. That
must not depend on each panel admin turning on a setting. With more tenants
and panels, the off-by-default case becomes the common one.

Rule 1 kept us from building lines ourselves, because a line we build could
disagree with the one x-ui's page shows. Porting the page's own code
(`inbound.js`) is the answer to that concern, instead of reading the panel.

## Decision

1. **Built, not read.** For x-ui alireza0 and Sanaee (3x-ui v2), `ClientLinks`
   builds the client's line itself and never reads the panel's subscription
   server (user, 2026-09-26: "build it directly; leave the subscription
   alone for now"). The recommendation was to read the sub server first and
   build only when it gave nothing. The user chose not to depend on it at all.
2. **Ported from x-ui's own page.** The builder is a port of x-ui's
   `inbound.js` (`genVLESSLink`, `genVmessLink`, `genTrojanLink`,
   `genAllLinks`) for the protocols these drivers provision: vless, vmess and
   trojan. It uses what the inbound list already returned: `listen`, `port`,
   `settings`, `streamSettings` (network, security, TLS/REALITY fields,
   `externalProxy`) and the client's id, password and flow. The address is
   the inbound's `listen` when it is not `0.0.0.0`, as the page does, else
   the panel's `clientBaseUrl` host, else its `apiBaseUrl` host (the page's
   `location.hostname`). An inbound with `externalProxy` gives one line per
   entry, at that entry's address and port.
3. **Never a guessed line.** A network, security or protocol the port does
   not cover builds nothing for that client. The config keeps "gives none",
   because a line that imports but never connects is worse than no line.
4. **A read failure is still a fault** (rule 2 unchanged). The build uses
   the one inbound read `ClientLinks` already makes, and a failed read is a
   `*driver.Fault`, never an empty answer.
5. **An empty capture is asked again.** Lines captured empty are re-captured
   on a slow schedule, not never. A config captured before this ADR then
   fills in without a new key.

## Consequences

- Every x-ui config with a known transport gets a line on the page and in
  `/sub`, with no panel setting to change.
- A builder to maintain, in one place (`internal/driver`), shared by both
  families. It follows `inbound.js`: a panel upgrade that changes the page's
  lines is a change to port.
- A panel's sub-server settings (`subURI`, custom remarks) no longer shape
  the line. The remark is the inbound's remark and the client's email, as
  the page's default `-ieo` model gives.
- 3x-ui v3 (`threexui`) keeps reading its sub server until it gets its own
  row.
- One extra capture per empty config per re-ask interval, inside the panel's
  request budget.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Read the sub server first, build only when it is empty (the agent's recommendation) | keeps a dependency on a setting that is off by default, and two paths to test |
| Keep rule 1 and ask admins to enable the sub server | repeated for every new panel, and a config that silently has no line until someone does |
| Build at `/sub` request time | ADR-0082's rejected option: a driver call on the hot path |

## Revisit trigger

A built line reported as not connecting where the panel's page works: the
port has fallen behind `inbound.js`, or rule 3 is too loose for that
transport. Reading the sub server again is then a row of its own.
