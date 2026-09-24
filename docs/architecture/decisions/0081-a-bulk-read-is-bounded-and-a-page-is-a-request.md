---
id: adr-0081
status: active
updated: 2026-09-24
---

# ADR 0081 — a bulk read is bounded, not one request, and a page is a request

- **Status:** accepted
- **Date:** 2026-09-24
- **Affects units:** network, panel-web

## Context

ADR-0074's questionnaire made `bulk_usage_in_one_call` a `required` row, and
F-027-k's conformance scenario held a bulk pass over 5000 clients to exactly
**one** request. The rule was written against catalog 8.4, whose failure is a
driver that reads client by client: 5000 clients, 5000 requests a pass, on a
server we do not own.

Building Marzneshin (F-027-ba) found a family between the two. Its only user
listing, `GET /api/users`, is paged by `fastapi-pagination` at 100 users a page
at most, and it has no unpaged read. 5000 users is fifty requests. Under the
rule as written, every Marzneshin panel is refused at registration, and every
later family that pages would be too.

`driver.Pace` counted a driver **method** call as one request. A paged bulk read
would have spent one slot of `maxRequestsPerMinute` and sent fifty.

## Decision

1. **`bulk_usage_in_one_call` asks for a bounded read.** Every client's usage
   in one request, or in one request per page of at least
   `driver.MinPageSize` (100) clients. It stays `required`: a family that can
   only read client by client is still refused. The key keeps its words. It is
   an address stored in every panel's capabilities document and read by the
   TypeScript matrix, so renaming it would be a version bump and a migration
   to fix a spelling. The question and its cost are what changed.
2. **A page is a request.** `Pace` carries its budget on the call's context,
   and a paged driver calls `driver.NextPage` before every page after the
   first. The page waits for its slot the way the first request did, and it
   gives up with a `timeout` fault at the caller's deadline. A family that
   reads in one request never calls it.
3. **The conformance bulk scenario is `bulk_pass_is_bounded`.** 5000 clients
   cost at most `ceil(5000 / MinPageSize)` = 50 requests, and every client is
   read. A paged read that stops early is a pass that silently misses users.
4. **The hot pass is unchanged: one request per panel.** So a family whose
   bulk read is paged needs a subset endpoint. Served from fifty pages, the hot
   loop would send fifty requests every few seconds.

## Consequences

- Positive: a paged family is accepted, and its real cost is charged to the
  panel's budget. The owner's `maxRequestsPerMinute` still bounds what the
  panel sees.
- Positive: a family with no subset endpoint and a paged bulk read still fails
  conformance, instead of arriving as a hot loop flood.
- Negative / accepted cost: a pass over a large paged panel takes longer, and
  a budget smaller than its page count spreads one pass over more than a
  minute. The pass waits for its slots instead of dropping reads (invariant
  18), and the hot loop's horizon already sizes blocks by observed time.
- Negative / accepted cost: the key `bulk_usage_in_one_call` no longer reads
  as what it asks. The question text, this ADR and the constant's comment say
  so.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Keep the rule and drop Marzneshin, as Cloudius was | every paged family would be refused the same way, one decision at a time |
| Build the driver and let it answer `no` | a driver no panel could ever be registered with |
| Rename the key and bump the capabilities version | every stored document becomes unreadable until retested, to fix a word |
| Count pages inside each driver | thirteen places for the same mistake. The budget is `Pace`'s, and the page's cost belongs there |

## Revisit trigger

A family whose bulk read pages below 100, or one whose bulk read is paged and
has no subset endpoint. Either one needs its own decision, not a smaller
`MinPageSize`.
