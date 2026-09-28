---
id: panel-web
layer: interface
status: active
version: 25
updated: 2026-09-28
---

# Contract — panel-web: the notifications control (F-093-h)

`_components/NotificationsButton.tsx` + `_hooks/useNotifications.ts` +
`_lib/notification-event.ts`, over `lib/notification-api.ts`. The bell in the
top bar, its unread badge, and the panel it opens. Its own file rather than a
section of [contract.shell.md](contract.shell.md), which is at §10's 250-line
ceiling.

It reads `notification-service`'s inbox
([notification/contract.md](../../domains/notification/contract.md), F-035-a)
and hears about new rows over the panel socket
([contract.realtime.md](contract.realtime.md), F-070-c).

## The rules

1. **The number is the service's, never this app's.** `unreadCount` is over the
   **whole** inbox whatever the page or filter, and the panel reads ten rows. A
   badge counted from what is rendered would be short for every user with more
   unread rows than that — and short in the direction that hides mail. This is
   the wallet control's rule 1 applied to a different figure, and the same
   legacy habit it corrects: counts kept and adjusted in a client store.
2. **A mark-read takes its new count from the write's own answer**, which
   carries `unreadCount`, and then re-reads the page for its `readAt`s.
   Nothing is decremented here. `POST notifications/read` answers no rows, so
   patching the list from what we hoped the write did would be a second source
   of truth for whether a message has been read.
3. **Only `notification.created` is a reason to ask again.** The `user:<userId>`
   channel also carries `billing.payment.confirmed` and `.reversed`
   (F-067-l/m), so `isNotificationCreated` filters on the event type — read
   from `@/generated/wire`'s `RealtimeEvents` (C-08), never spelled here. This
   is the opposite of `useWalletBalance`'s rule 2, and the difference is that
   the shape *is* agreed for this one
   ([automation/contract.outbox.md](../../domains/automation/contract.outbox.md),
   "the third consumer"): it was not for a payment when the wallet shipped.
   A reconnect (`onMissed`) re-reads too: nothing is queued for a dropped
   socket, so a message created meanwhile would leave the badge short (F-070-d).
4. **The event's payload is still not rendered.** It carries the row, but not
   `unreadCount`, and the badge is the point of hearing about it at all — so
   arrival is the signal and the route is the answer. A redelivery is
   therefore harmless here whatever the consumer's marker does.
5. **Opening the panel marks nothing read.** Each row has its own mark button
   and the header has "mark all". A badge that clears itself on a glance is a
   badge that loses the one message the user meant to come back to, and there
   is no page yet to find it again on.
6. **A failed read is not an empty inbox.** The last good page stays on screen
   under its own error line and a retry. "You have no notifications" and "we
   could not ask" are different sentences and only one of them is ever true at
   a time. The sentence is the panel's own: the route raises no domain error,
   so a failure is the limiter or the network and nothing translated came back
   ([contract.errors.md](contract.errors.md)).
7. **An unknown `type` renders, neutrally.** The three `NotificationType`
   values each get an icon and a theme tone; anything else gets the bell and
   `text-secondary` rather than being filtered out. `notification-service` may
   add a value before this app is redeployed, and a row dropped here is a
   message the user never learns exists.
8. **Every tone is a theme token**, never a raw palette class — three themes
   ship and a hard-coded `orange-500` is legible in one of them by luck
   (`financial/_lib/tones.ts` is where that was learned). Gold appears as the
   `low_balance` tone and on no control: a status may be gold, a button never.
9. **No "see all" footer.** Legacy had one and it led nowhere. A destination
   that does not exist is hidden, not rendered as a dead link
   ([contract.shell.md](contract.shell.md) rule 2); the row that builds an
   inbox page fills it in.
10. **The panel is `absolute`, not portalled.** Rule 9 of `contract.shell.md`
    predicted this control would need `GiftCodeModal`'s portal, and it does
    not: the two traps it names — the bar's `backdrop-filter` becoming the
    containing block, and its `z-20` capping the stack — are about `fixed`
    children. This is the wallet dropdown's shape, anchored to its own
    `relative` parent, opening over the page and never over the sidebar. A
    *modal* this control grows later still wants the portal.

## What it cost the bar, and what the bar bought

`contract.shell.md` rule 5 is the budget: at 360px the header has **304px** of
content box, and the menu button, wallet and switcher held **~286px**. A `p-2`
bell with a 20px icon is 36px, 40px with the row's `gap-1`. It did not fit, and
rule 5 is explicit that a control which does not fit does not belong in the bar.

Two of rule 5's three consequences applied unchanged — shrinking the last
control does not fix a row over budget, and a `sm:` escape hatch is not a fix —
so what moved was the term rule 5 itself names as the only unbounded one:
**the wallet's figure**. Below `sm` `WalletButton` is now the icon alone, and
the balance renders in that control's own dropdown header instead (shown at
every width there, because a figure that appears and disappears with the
viewport is one the user has to hunt for). That returns ~110px, and the phone
row is **~220px** against 304.

This was the user's call, asked before it was built (2026-09-20): the cheaper
answers were the bell from `lg` up with the badge hidden in the drawer below
it, or an inbox entry in the sidebar. Both keep the bar untouched and both make
the badge invisible on a phone, which is most of this product's traffic. The
figure was chosen instead because bounding the bar is the thing that does not
have to be redone when the control after this one arrives — and it was bounded
by **moving** the figure rather than truncating it, since a truncated balance is
a wrong number and rule 1 of the wallet control exists to stop those.

## The client

`lib/notification-api.ts`, the same shape as `billing-api.ts`: `/api` on the
page's own host (ADR-0060), the access token as a Bearer header, the shared
envelope and refresh of `lib/api-request.ts`. Two calls, `inbox` and
`markRead`. **No route names a user** — whose inbox it is comes off the gate's
`X-User-Id` — so there is no id to pass here and none to get wrong.

`markRead(undefined)` sends `{}`, which is the route's "mark all"; an empty list
is refused there rather than quietly meaning the same thing, so this client
never sends one.

## Notice settings on `/settings` (F-601-m)

`settings/_components/NotificationsSection.tsx`, below the email section, over
`notificationApi.preferences` / `savePreferences`
([notification/contract.retention.md](../../domains/notification/contract.retention.md)
"Mute and quiet hours").

1. **A switch that is on means "tell me"**, one per `NOTICE_KINDS` entry, words
   from an exhaustive `Record<NoticeKind, …>`. There is no switch for a stopped
   service: the subtitle says it is always told, and the server enforces it.
2. **Quiet hours are one switch, two `time` fields and a zone.** Switched on,
   the window reads 23:00–08:00 until moved; the zone list is the browser's
   `Intl.supportedValuesOf`, keeping the saved zone even if the browser lacks
   it. Equal ends block the save with a line — the server refuses them too.
3. **Saved whole with one button, and the answer is what is shown after**, so
   a value the server normalised (kind order, duplicates) reads as stored. A
   failed load shows one line and no form: an empty form saved would reset
   everything the user set.

## Which messenger tells them, on `/settings` (F-601-u)

`settings/_components/MessengerSection.tsx`, below the notice settings, over
`authApi.messenger` / `saveMessenger`
([identity/contract.messenger.md](../../domains/identity/contract.messenger.md)).

1. **Three options — both, Telegram, Bale — words from an exhaustive
   `Record<NoticeMessenger, …>`.** Unchosen reads as both, the server's
   default, so the form opens on it; `chosen` is not shown.
2. **A platform with no verified chat can be picked, and says so**: until it
   is linked, the notifier tells the other. Stated here, enforced there.
3. **Saved with one button; the answer is what is shown after.** A failed
   load shows one line and no form, as the notice settings do.

## A service's notice level on `/services` (F-601-o)

`services/_components/NoticeLevel.tsx`, under each row's "manage", over
`notificationApi.grantNoticeLevels` / `setGrantNoticeLevel`
([notification/contract.retention.md](../../domains/notification/contract.retention.md)
"One service, essentials only").

1. **Read once per visit, by the page**: one list of essential ids, not a read
   per row; a stored choice moves the page's copy. Loading shows nothing; a
   failed read shows one line under "manage" and no choice — "all" drawn from
   a failed read would be a guess shown as a fact.
2. **Two options, words from an exhaustive `Record<GrantNoticeLevel, …>`**; a
   tap saves at once, and the stored answer is what is shown after. A refused
   save says so and leaves the old choice checked.
3. **"Essential notices only" is a chip beside the status**, so a service
   whose notices were quieted is never a surprise with "manage" folded.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| notification | `GET /api/notifications`, `POST /api/notifications/read` | the last good page stays with an error line and a retry; the bell still opens |
| notification | `GET` / `PUT /api/notifications/preferences` | the settings section shows one error line and no form; the rest of `/settings` works |
| identity (auth-api) | `GET` / `PUT /api/auth/me/messenger` | the messenger section shows one error line and no form; the rest of `/settings` works |
| notification | `GET /api/notifications/preferences/grants`, `PUT …/grants/:grantId` | "manage" shows one line and no choice; the rest of `/services` works |
| realtime | `notification.created` on `user:<userId>` | no live badge; the count is right again on the next page load, because the row is durable and the push only spares a reload (D-15) |
