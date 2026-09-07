---
id: bot-app
layer: interface
version: 1
updated: 2026-09-07
---

# Contract — bot-app · the switch group

Split out of [contract.md](contract.md) on 2026-09-07 (§10 line ceiling). Same
unit, same consumers: everything about the set of accounts a chat holds — moving
between them (`F-0210`), whose set it is (ADR-0015), and how one joins
(`F-0205`).

## Switching accounts (`F-0210`, ADR-0014)

The member menu offers the group: who this chat is signed in as, and who else
it may become in one tap. It is `panel-web`'s switcher (`F-0209`) on a chat —
the same `GET /auth/accounts` and `POST /auth/accounts/switch`, and the same
absence of any credential, because the group is the proof.

**What moves is the session, never the link.** The Redis entry is overwritten;
`LinkedBotAccount` is untouched, so a chat stays linked to one account and
identity invariant #12 stands. ADR-0014's accepted cost follows: after
`/logout` the one-tap sign-in returns to the **linked** account, and reaching
the other one is a switch from there.

**These were the first routes here behind `AuthGuard`**, so they need the
*user's* access token, not only the service credential. `ChatAccess.token`
mints one from the stored refresh token; refreshing **rotates**, so the new
refresh token is written back before anything else, and a refusal means the
session is gone — the entry is dropped and the chat is told so, rather than
failing on a later screen that cannot explain itself.

## The group belongs to this chat (ADR-0015)

Since ADR-0015 a switch group is not a property of the person but of the
surface it was built on, and for the bot that surface is **one chat**. The set
offered above is this chat's alone: the same user may hold a different set in
their browser, and neither is visible from the other.

Two consequences an edit must not undo:

- **Every account call carries `x-bot-platform` beside `x-bot-chat-id`.**
  `auth-api` names the scope `bot:<platform>:<chatId>` and refuses outright
  when the platform is missing — Telegram and Bale number their chats
  independently, so a chat id alone can name two different chats.
- **Removing an account (`F-0208`) removes it here only**, and revokes only the
  sessions minted in this chat. Removing the chat's *own* account is a sign-out
  here: the stored refresh token is dropped, because `auth-api` has already
  revoked the session behind it. The remove path re-reads the group before it
  asks, and again on the confirming tap, so a stale keyboard cannot remove
  someone who has since moved.

## Adding an account (`F-0205`, `flows/account-add.flow.ts`)

The other half of the screen above: this is how an account becomes one of the
set — the panel's add-account page (`accounts/add/page.tsx`) as a conversation,
same routes, same two proofs, same order.

Membership is **proved, never asserted** (`audit` invariant #4), so the whole
conversation exists to carry exactly one credential and the caller picks which:
a code to the **joining account's own phone** (`add/otp/request` then
`add/otp/verify`), or that **account's own password** (`add/password`).

Three properties are not incidental, and an edit should not quietly drop them:

- **It signs nobody in.** All three routes answer with a group id and the
  joining account's `userId`, never a token pair. The proof is spent once,
  here, and reaching that account is a separate credential-free switch —
  which this flow then makes for the user (see below).
- **The code goes to a phone that is not the person in this chat**, so this is
  the one caller passing `inPlace: false` to `OtpStep.request`. The in-place
  link would bind *this* chat to the joining account, which identity refuses
  (`takenByAnotherAccount`, invariant #12) — so that path could only end in a
  refusal, reached after the user shared a contact card for nothing.
- **The phone is typed, never shared.** `askContact` sends *this* user's number,
  already signed in — its only outcome is `accountSwitch.sameAccount`.

The password message is deleted on every path out of that step, including the
one where the session turned out to be gone, and including the one where the
switch below is refused after the add itself succeeded.

**A successful add lands the chat on the account it added.** The proof has
already answered the only question a switch asks, so making the user open the
accounts list and tap the account they just proved they own was ceremony. The
flow reuses the add's own access token for a `POST /auth/accounts/switch` on
the `userId` that came back, through `session/account-switcher.ts` — the same
class `flows/accounts.flow.ts` uses, because the call and the write that keeps
it are one step, not two (`audit` invariant #7).

A refused switch is **not** reported as a failure. Cross-tenant, a deactivated
target, a session revoked between the two calls: the add still happened and the
group still changed, so the chat stays where it was and shows the plain
"it is in your list" message. Only the convenience was lost.
