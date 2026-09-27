---
id: panel-web
layer: interface
status: active
version: 40
updated: 2026-09-27
---

# Contract — panel-web: a service that looks alive (F-307-u)

A topic file of [contract.my-services.md](contract.my-services.md), split from
it because that file is at the 250-line ceiling. It covers three parts of a row
on `/services`: whether a service is moving data (`_components/ServicePulse.tsx`),
its traffic and time left (`_components/UsageMeter.tsx`), and a purchase on its
way to ready (`_components/ServiceBuilding.tsx`). The verdicts behind them are
pure functions in `_lib/pulse.ts`. User, 2026-09-27: "active configs don't feel
alive; show when one is used and when it moves nothing; a purchase being built
should say so; the usage bar is confusing".

## Rules

1. **"In use" is what the panels saw, never a guess.** A Grant in use is
   pushed its bytes about every 40 s (`PUSH_GAP_MS`; measured on dev on
   2026-09-27 over 43 gaps: median 40 s, p99 42.5 s). On first paint the last
   traffic is billing's `lastTrafficAt` (metering's `usagePushedAt`,
   [billing/contract.gift.md](../../domains/billing/contract.gift.md)).
   Metering writes it only for a charged, non-zero delta, so a service that
   moves nothing never reads live. After that it is the moment a push raised
   `consumedBytes` (`useGrantsPage` stamps the row, contract.my-services.md 13b).
   To recompute the cadence, take percentiles of the gaps between one Grant's
   `automation.outbox_event` rows of type `entitlement.grant.usage`.
2. **A stop is said as soon as it can be known, and no sooner** (user,
   2026-09-27: a stopped service kept reading live). The row is **live** under
   `LIVE_WINDOW_MS` (one gap + 10 s = 50 s): a beating dot, "in use", the
   seconds since the last traffic counting up and resetting on each push, and
   "+45 MB" for 4 s. It is **cooling** under `STOPPED_AFTER_MS` (90 s): the
   push is late, so "no new traffic, probably stopped", with a still dot. After
   that it is **idle**, "last used N min ago" on the whole minute, and a Grant
   that never moved a byte reads "not used yet". The hover text says usage
   arrives about every 40 s, so a stop shows up late. Nothing is read on a
   clock; the timers only redraw.
2a. **What the socket missed is read back when the user looks** (F-307-w;
   user, 2026-09-27: "last used 34 min ago" until a refresh). A tab in the
   background (the VPN app in front, a phone freezing the page) loses its
   socket, and every push sent meanwhile reaches nobody. So `useGrantsPage`
   re-reads the rows quietly after every reconnect, and when the tab comes back
   into view, at most once per 15 s so the `GRANT_LIST` bucket is never what
   tab-flicking spends. The rows carry `lastTrafficAt` and `consumedBytes`, so
   one read restores both. These are events, not a clock.
3. **Nothing is claimed that cannot be known.** The pulse shows only on an
   `active` Grant, and not while `collection-health` answers `unavailable`,
   because silence then means nothing. The page's banner already says why.
4. **The meter leads with what is left** (user: the used-bar read both ways).
   There are two tiles, traffic left and time left. Each has a big figure, a
   percent pill, a tank and one plain sentence (used-of-bought; until when).
   The tank is a glossy capsule whose fill is what is left, with ticks at the
   quarters. It fills up when the page opens, a glint crosses it every 5 s,
   and a glowing head rides its edge. A live traffic tank runs a current
   toward the head and beats it, and each push sends a ring out of the head.
   The tank turns gold under a quarter left and red under a tenth; red also
   tints the tile and makes the fill breathe. The percent is whole, never 100
   once a byte is used and never 0 while one is left. The bound is rule 15's:
   unlimited reads "unlimited", and a prepaid Grant with no cap shows what it
   used. An `active` Grant under a tenth of its traffic, or under a day of its
   time, gets one red line; a suspended one's purge line already says what to do.
5. **A purchase shows its steps** (over F-111-f, F-111-l). The steps are paid →
   built on the server (`pending`) → connection links (`active`, and every
   config read has no lines and no `linksCapturedAt`) → ready. The card
   replaces the meter and the configs while a step is in progress. A sweep and
   a turning ring show it is working, and every sentence says there is nothing
   to do. The page moves it on by the events it already hears: a delivery
   re-reads the rows, a capture re-reads the configs. A config whose panel
   gives no lines (`linksCapturedAt` set) is an answer, not a wait. A row this
   page watched on its way shows "ready" for 10 s once it lands. A row that
   was already ready shows no "ready".
6. **Motion is decoration, never the message.** Every state has its words.
   Under `prefers-reduced-motion` the fill-up, glint, current, beat, ripple,
   bump, ring and sweep stop, and nothing else changes (`globals.css`, "My services").

## Proof

`services/pulse.test.tsx` covers these rules. `activityOf`: live, cooling,
idle, never, and a server clock ahead; `nextChangeIn`; `agoOf` with seconds.
A live row's seconds count up, it says "probably stopped" at 50 s and idle at
90 s. `levelOf` and `buildStage`, including one
config with lines and a panel that gives none. A row that is live from
billing's stamp falls idle when the window closes and turns on the minute. A
never-used row. A push that makes a row live, shows "+100 MB", runs the
tank's current and sends its ring. A critical tank. Nothing shown
while metering is down or on a non-active Grant. The meter's figure, its "of",
its percent and the red line. Unlimited traffic. The steps while pending. The
links step after delivery, then "ready". `useGrantsPage.test.ts` checks that a
push stamps `lastTrafficAt`, that any reconnect re-reads, and that the tab
coming into view re-reads at most once per 15 s. `connection.test.tsx` checks the links step while
every config waits. Billing's `grant-list.spec.ts` checks `lastTrafficAt`.

## Not covered

Per-config activity: the push and the stamp are per Grant. A speed figure:
pushes are at least 30 s apart, so a rate would be an average passed off as
live.
