---
id: adr-0013
status: accepted
updated: 2026-09-06
---

# ADR 0013 — asking whether a session is live never rotates it

- **Status:** accepted
- **Date:** 2026-09-06
- **Affects units:** auth-api, panel-web, identity

## Context

`F-0101` wants a signed-in visitor kept off the login screen. `panel-web`
answers that in its Next proxy, server-side, before the screen renders: read the
httpOnly `refresh_token` cookie, ask auth-service what it means, redirect or
show the form.

The question was asked of `POST /auth/refresh`, on the reasoning that it is the
only route taking a refresh token, so it is already the "does this user need to
log in?" question. It is not. Refresh *rotates*: `AuthService.refresh` revokes
the session the token names and mints a replacement, returning the new token in
a `Set-Cookie`. Asking it a question changes the answer.

That is survivable only if every asker stores the replacement. The proxy cannot
promise that. `config.matcher` covers every non-static path, so the handler runs
on far more requests than the visitor ever sees a response to — RSC prefetches
of `/auth/login`, redirects, requests already in flight with the previous
cookie. Each one rotated the session and handed back a cookie the browser might
discard, leaving it holding a revoked token that still looked present in
devtools. The next real refresh — the panel's own `ensureSession()` on its first
paint — then failed, and `PanelSessionProvider` sent the user back to the login
screen.

The fingerprint was in `identity.session`: live rows whose `userAgent` is `node`,
minted by the proxy's server-to-server call, alongside the browser's own rows.
No browser ever held those tokens.

## Decision

**A read of authentication state is a separate route from a change to it.**

`GET /auth/session` answers `{ active: boolean }` from Postgres and mutates
nothing. `POST /auth/refresh` keeps rotating and is called only by a client that
will store the result — in practice one call per page load, from
`authApi.ensureSession()`.

A dead cookie is still cleared by the read route. Clearing a token that can
never succeed again is not a state change to the session; the session is already
gone.

## Consequences

- Any future "is this visitor signed in?" caller — `forward-auth`, `bot-app`, a
  second front end — has a route to ask that costs the asker nothing. Before
  this, each new asker was one more source of silent sign-outs.
- Rotation stays single-use and single-caller, which is what makes it a useful
  signal at all. A refresh that failed now means something.
- `GET /auth/session` is reachable from the browser and returns a boolean about
  the caller's own cookie, so it discloses nothing the caller does not have.
- Postgres is asked, not the Redis liveness cache — the record decides
  (identity `invariants.md` #8), and this route is not on a hot path.

## Alternatives rejected

- **Have the proxy replay the rotated cookie harder.** It cannot: it does not
  know which of its own responses the browser will keep.
- **Stop checking, and let the login screen render for signed-in users.** That
  drops `F-0101` to fix a bug in how it was implemented.
- **Make refresh idempotent within a short window.** Turns a single-use token
  into a briefly-replayable one and weakens the reuse signal, to avoid adding
  one read-only route.
