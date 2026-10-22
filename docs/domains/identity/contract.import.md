---
id: identity
layer: domain
status: active
version: 40
updated: 2026-10-22
---

# Contract — identity / the people an import brings (F-201-e), their Telegram (F-210), and removes on a rollback (F-211)

A topic file of `contract.md` (§10). A reseller leaving another panel brings
its users with it (D-63). Each source client becomes a Grant
([../entitlement/contract.import.md](../entitlement/contract.import.md),
F-202), and a Grant needs a person. This file says how an import finds or
creates that person.

Code: `auth-service/src/app/auth/users/user-import.service.ts` (the rule),
`user-import-internal.controller.ts` (the route), `end-user-room.ts` (the lock
and the cap, shared with registration), `bot-link/link-writes.ts` (the claim,
its redemption and every proof's write — F-210, ADR-0157).

## Rules

1. **Found by the source's key.** `user.remoteIdentity` is the client's
   `remoteIdentityOf` (entitlement's rule 2), unique per tenant
   (`user_tenantId_remoteIdentity_key`). A person already imported is
   answered `created: false` and never created again, so a re-run, or a
   batch retried after a timeout, is safe.
2. **One transaction per batch, under registration's lock**
   (`lockEndUserRoom`, `reseller_limit:end_users_max:<tenant>`). The cap and
   the usernames read inside it hold at commit, against a registration and
   against another batch.
3. **The cap is per person, never the batch.** Past the reseller's
   `end_users_max` (F-019-t2, ADR-0106) each one left is refused `over_cap`;
   the rest are created. The platform's own tenant has no cap.
4. **A deleted person is not revived.** Found with `deletedAt` set, refused
   `deleted`.
5. **The username is the label's**, as the register form allows it:
   lower-cased, every run of other characters folded to one `_`, cut to 32. A
   label with fewer than 3 Latin characters left is `user` or
   `user_<what is left>`. Taken in the tenant or earlier in the batch: `_2`,
   `_3`, … cut so the suffix fits. `fullName` is the label (120), else the
   username.
6. **No phone, no known password.** The hash is argon2id of 32 random bytes
   discarded at once — one per batch, since hashing is the slow part. Such a
   person signs in by the reseller's bot once its chat's card redeems the
   source's claim (rule 10), or by linking a phone later.
   Role `user`, `active`.
7. **Not a signup.** No `USER_SIGNED_UP`: analytics' signups count people who
   signed up; an import's are counted by its run.
8. **A rollback removes only an import's person who did nothing here**
   (F-211; entitlement `contract.import.md` rule 26). Billing names the
   people the run made and holding nothing there; each is kept, with why,
   when it has no `remoteIdentity` (`not_imported`), a phone
   (`phone_linked`), an email (`email_linked`), a proved messenger link
   (`messenger_linked`; a claim is not one, and goes with them) or a session
   (`signed_in`), or is not the tenant's (`not_found`). The rest are soft-deleted (`deletedAt`) with their
   `remoteIdentity` and username released, so a later run of the same source
   makes them afresh under the same name instead of refusing them `deleted`
   (rule 4). One already removed is answered removed: a retry is safe.
9. **The source's Telegram id is a claim, never a proof** (F-210, ADR-0157).
   A `telegramId` beside a person — the snapshot's (network `contract.source.md`)
   or a balance file's column (`/import/telegram`) — becomes, in the same
   transaction, a `linked_bot_account` on `telegram` with `claimedAt` and no
   `contactVerifiedAt`: `claimed`. A chat already linked in the tenant to
   anyone else, claimed or proved, is `taken` and never moved; a person
   already linked to another chat keeps it (`has_other`); a re-run finds its
   own claim. A claim carries nothing — every reader asks `contactVerifiedAt`.
10. **The chat's own contact card redeems it.** At `bots/session` (rules.md
    14) a card that passes invariant #12 and whose phone is nobody's in the
    tenant gives the claimed person — one with no phone — that phone,
    verified, proves the link and signs them in. A proof for another person
    (a card, a registration, an OTP link) releases the claim first.

## Route

Service-only (`x-service-token`, a neutral 404 otherwise), never routed by
Traefik. The tenant is `X-Tenant-Id`, honoured because the token verified.
Capability `staffWrite`: the reseller's own act, closed when its staff could
not write either.

| Route | Body | Answers |
|---|---|---|
| `POST /api/internal/users/import` | `users[]` (1..200): `remoteIdentity` (1..512, trimmed), `label` (≤ 200), `telegramId?` (a positive decimal id) | in `data`: `users[]`: `remoteIdentity`, `userId`, `created`, `telegram?` (rule 9); `refused[]`: `remoteIdentity`, `reason` `over_cap` \| `deleted` |
| `POST /api/internal/users/import/telegram` | `links[]` (1..200): `userId` (uuid), `chatId` (as `telegramId`) | in `data`: `links[]`: `userId`, `telegram` (rule 9); a person not the tenant's or deleted is left out |
| `POST /api/internal/users/import/remove` | `userIds[]` (1..200, uuids) | in `data`: `removed[]` (user ids); `kept[]`: `userId`, `reason` (rule 8) |

A `remoteIdentity` named twice in one body is one person. A username taken
outside the lock while the batch runs fails the
batch (P2002); the caller retries it, and rule 1 makes the retry safe.
