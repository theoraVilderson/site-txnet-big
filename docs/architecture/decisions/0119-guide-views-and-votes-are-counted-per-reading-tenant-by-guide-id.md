# ADR-0119 — Guide views and votes are counted per reading tenant, by guide id

- Status: accepted (user, 2026-10-04)
- Feature: F-414 (row F-414-l)

## Context

A guide's author has no way to tell whether a guide is read or whether it
helps. The user asked for a view count and a helpful / not-helpful vote. A
platform guide is read on every reseller's Host and may be replaced there by
the reseller's own guide of the same key (ADR-0115), so "this guide's numbers"
has two readers: the reseller, about what its own users saw, and the platform
owner, about its guide everywhere. The user was asked on 2026-10-04 who may
vote and chose only a known user (a signed-in panel user, a chat with a
session); views are counted for everyone.

## Decision

1. **Counted per reading tenant, by guide id** — `guide_view_daily` and
   `guide_vote` hold the tenant whose Host or bot showed the guide, and the id
   of the guide row that was shown. A key is not enough: a reseller's override
   shares the platform guide's key, and its numbers are about another text.
   Both tables have strict RLS on the reading tenant; the guide id may name a
   platform row.
2. **A view is one viewer, one guide, one UTC day, on one surface.** The panel
   reports a view when a guide is shown whole; the bot when it sends one. A
   viewer is a hash of IP and user agent on the panel's public route, the
   chat on the bot. A Redis marker (`guideViewSeen`, 48 h) makes the second
   report of a day a no-op; with Redis down nothing is counted, never counted
   twice. Days are UTC: a bucket for "the last N days", not a calendar.
3. **A vote is one per user per guide, and can be changed.** `PUT
   /api/guides/feedback/:key` behind `forward-auth` — the panel's and the
   bot's user token, so the identity says whose vote it is. The guide must be
   one the user's tenant sees now; the vote names the row that resolved.
4. **Who reads the numbers.** On `/api/guides/settings/stats` a reseller gets
   its own tenant's rows, for its guides and the platform guides it shows; the
   platform owner gets every tenant's rows for the platform's guides, summed.
   A reseller never sees another reseller's numbers.
5. **Deleting a guide deletes its numbers** (`ON DELETE CASCADE`): they are
   about a text that no longer exists.

## Consequences

- One `INSERT … ON CONFLICT DO UPDATE` per counted view. Fine at the scale of
  help pages; a busy tenant moves this to a Redis counter flushed in batches
  without changing the tables.
- A viewer hash of IP and user agent undercounts a household behind one NAT
  and overcounts one person on two browsers. It is a view count, not a billing
  figure.
