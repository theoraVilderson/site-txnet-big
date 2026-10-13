---
id: adr-0140
status: active
updated: 2026-10-13
---

# ADR 0140 — A key opens one kind of act

- **Status:** accepted (KS-1; built by KS-1-a … KS-1-h)
- **Date:** 2026-10-10
- **Decision:** the user's (2026-10-10: "split the keys properly, and any
  other key that needs it"); the table was proposed by the agent and approved
  as it stands, with one row per key
- **Affects units:** identity, billing, catalog, engagement, auth-api,
  forward-auth, panel-web
- **Amends:** the key list in `auth-handler/configs/permissions.yaml`, and the
  group presets (GR-1-h)

## Context

The support preset (GR-1-h) could answer a user but not fix their service.
An audit of every registry key against the routes that check it (2026-10-10)
found that several keys each open acts of very different weight:

- **`grant.assign`** gates 35 routes: reading a user's services, regenerating
  a config, gifting traffic, creating and deleting a service. A support agent
  who must *see* a service has to be trusted to give one away.
- **`coupon.manage`** makes discount codes and also `wallet_credit` coupons,
  which put money in a wallet. A discount and money creation share one key.
- **`catalog.manage`** (66 routes) covers both a product's text and its price.
- **`gateway.manage`** covers switching a gateway on and replacing its
  credentials, which decides whose account the money reaches.
- **`campaign.manage`** covers both drafting a campaign and sending it to
  every user.
- **Keys that open nothing:** `wallet.manual_adjust`, `credential.manage` and
  `export.request` are checked by no route. `staff.manage` reaches only the
  seat table, which ADR-0139 retired. The panel offers all four as ticks.

## Decision

1. **A key opens one kind of act, and the kinds are: see, repair (no value
   moves), move value, configure.** A key that spans two of those is split.
2. **The splits** (one backlog row each):

   | today | becomes |
   |---|---|
   | `grant.assign` | `grant.read` (services, configs, usage, link, history, why one was not built) · `grant.repair` (regenerate, disable, enable or move a config, rotate the link, retry a service not built) · `grant.compensate` (days or traffic, up to a cap the tenant sets) · `grant.assign` (create, renew, delete, set traffic, speed or devices, bulk work, the caps) |
   | `coupon.manage` | `coupon.manage` (discounts) · `wallet.credit` (wallet-credit coupons, later a manual credit). `wallet.manual_adjust` is folded into it |
   | `catalog.manage` | `catalog.read` · `catalog.manage` (products, categories, text, translations) · `catalog.price` (prices, seasons, rate cards, price campaigns) |
   | `gateway.manage` | `gateway.read` · `gateway.manage` (on/off, audience, tax, presets) · `credential.manage` (a gateway's credentials) |
   | `campaign.manage` | `campaign.manage` (draft) · `campaign.send` |
   | `export.request`, `staff.manage` | removed. A key comes back with the feature that checks it |

3. **Nobody loses anything.** Each split's migration gives every holder of the
   old key — a role, a group (`user_group_permission`) or a person
   (`user_permission`) — every part it becomes. A key *taken* from a person
   is taken in all its parts, so a removal still wins (ADR-0138 (1)).
4. **No key without a check.** A key in the policy file that no route or
   service checks is a defect. KS-1-h adds the check to `contracts.py`, so a
   new dead key fails before it reaches the panel.
5. **The presets follow** in the same row as each split: support gains
   `grant.read`, `grant.repair` and `grant.compensate` (KS-1-c, 2026-10-13:
   capped, so an agent can apologise without being able to give a service away), finance gains `wallet.credit`, sales gains
   `catalog.price` and `campaign.send`.

## Consequences

- More ticks on a group's Access sheet, grouped by area as today. The preset
  is how most tenants will never have to read them.
- Every split touches the gate (`permissions.yaml` and the tenant ceiling),
  the service that checks it, the panel's checks, the locale texts and one
  migration. That is why it is one row per key and not one change.
- Not chosen: **adding `grant.assign` to the support preset** — every support
  group made from then on could give away unlimited traffic, and taking it back
  means touching every tenant's groups. **One split for all six keys at once**:
  one migration across five services, with no way to tell which part broke.
