---
id: identity
layer: domain
status: active
version: 32
updated: 2026-10-26
---

# Contract — identity / a fresh install owner's first sign-in

A topic file of [contract.md](contract.md) (§10), opened because that file is
at its 250-line cap. F-0102: the seeded platform owner keeps the account under
its own username, password and phone before any session exists. The wire
shapes are [auth-api/contract.owner-setup.md](../../interfaces/auth-api/contract.owner-setup.md).

## Rules

| # | Rule |
|---|---|
| 1 | `user.setupRequired` is set by the seed on the owner it creates, and by migration `20261026000200` on an install's owner still named `platform_owner`. Nothing else sets it; completing the setup clears it, once. |
| 2 | The first password stays the sealed file's (or the generated one shown once, hosting R13) — never a fixed default: whoever reaches a new panel first must not be able to claim it (user, 2026-10-26). |
| 3 | A proven password of a `setupRequired` account opens **no session**: the answer is a setup token, checked before the second factor (the seeded owner has no phone to send one to). Every other API is refused because there is no session to present — no gateway rule. |
| 4 | The phone is proved like registration's (`register_phone_verify`, `PhoneCodeSender`, a bot link included). A number another account of the tenant holds is refused before a code is sent. |
| 5 | Completion is one conditional write `where {id, setupRequired: true}` of username, argon2id hash, phone and `phoneVerifiedAt`; 2.2 is checked before the code is spent. Then the session opens on both factors (ADR-0145): the first password and the code. |
| 6 | The account stays the tenant's `ownerUserId` and keeps its role: the owner is renamed, never replaced. |
