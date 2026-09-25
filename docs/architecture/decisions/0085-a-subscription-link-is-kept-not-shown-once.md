---
id: adr-0085
status: active
updated: 2026-09-25
---

# ADR 0085 — a subscription link is kept, not shown once

- **Status:** accepted
- **Date:** 2026-09-25
- **Affects units:** entitlement, billing (gift routes), panel-web, sub-api (unchanged)
- **Reverses:** the user's call of 2026-09-14 that the token is stored only as
  its hash and shown once (D-35, `entitlement/contract.md` invariants)

## Context

A Grant's `/sub/{token}` link is how a VPN app (v2rayNG, Clash, Sing-box) reaches
the service. The app cannot sign in, so the link has to carry a secret. The token
was stored only as SHA-256, so it could be answered only when it was minted. The
panel therefore showed a "subscription key" once (gift code, shop payment) and
offered "reissue key" (F-502-p), which kills the link the user's app already holds.

The user (2026-09-25, D-43) asked why a user should handle a key at all. They chose
this: the link is always available in "My services", and the word "key" is gone.

## Decision

1. **The token is kept sealed beside its hash.** `grant.subscriptionTokenSealed`
   (JSON `{kekId, iv, authTag, ciphertext}`) is AES-256-GCM under a key derived
   from the vault KEK with HKDF-SHA256 (info `txnet:grant-token:v1`). HKDF is used
   so that this key never unwraps a vault DEK, and a DEK key never opens a token.
   `kekId` is the KEK's file name, as for `tenant_dek`, so a KEK rotation can
   re-seal the tokens.
2. **The hash stays the lookup.** `sub-service` still finds a Grant by
   `subscriptionTokenHash` and never decrypts anything. Nothing in `sub-api`
   changes.
3. **Only billing's entitlement code opens it**, and only for the Grant's own
   user (`subscriptionTokenFor`). A Grant list, an event or a log never carries it.
4. **A Grant without a sealed token is not an error.** Grants issued before this
   change, and any Grant issued while no KEK is loaded, hold `null`. For those the
   user resets the link once, and from then on it is kept. The one alternative
   was to rotate every live Grant in the migration, which would have broken every
   link already in a user's app.
5. **Rotation is a security action, not recovery.** "Reset link" exists for a link
   that leaked. It is no longer how a lost key comes back.

## Consequences

- One more secret-bearing column. A database dump alone does not open it: the
  KEK is a mounted file (ADR-0026), outside the database.
- Rows F-114-e-a..c: storage (a), the link route (b), the panel (c).
- The bot shows the same link when it gets a services view. There is no second
  mechanism.
