/**
 * Every rate-limit bucket this platform counts, declared once (F-077,
 * ADR-0036).
 *
 * **What a bucket actually is.** The on-the-wire counter key is
 * `ratelimit:<tenantId>:<bucket>:<subject>`. `RedisKeys.rateLimit()` owns the
 * first half; the `<bucket>` segment was a free-form template literal at all
 * twenty-two `@RateLimit` call sites, with nothing checking it — it is part of
 * a Redis key name and it was the only part with no builder.
 *
 * **Why that mattered more than it looks.** Two call sites that mean to share a
 * budget must spell the bucket identically, and two that mean to be separate
 * must not collide. Both failures are silent. `login-failures:<identity>` was
 * spelled by hand in two places with a comment between them saying they had to
 * stay the same — which is the clearest possible statement that nothing was
 * making them. And several bucket names duplicate real key families
 * (`otp:delivery:`, `bot:session:`, `captcha:challenge:`, `register:`), so a
 * reader scanning the keyspace cannot tell a counter from the thing it counts.
 *
 * **A registry, not a builder.** There is no structure here to build: the
 * bucket is a name. What the registry buys is a compile error on a typo or a
 * duplicate, and one place to read the whole rate-limit surface of the
 * platform — which, before this, could only be assembled by grepping for a
 * decorator.
 */

/**
 * The declared buckets. Frozen and `as const`, so a typo is a type error and a
 * duplicate value is visible in one screen rather than across six controllers.
 *
 * Names are grouped by the surface they protect. The value is the wire segment
 * and must never change casually: changing one resets that limiter, which is
 * harmless for a counter and is still a thing to do deliberately.
 */
export const RateLimitBucket = {
  /** Password login. Shares its budget with nothing. */
  LOGIN_PWD: 'login:pwd',
  LOGIN_OTP_REQUEST: 'login:otp:req',
  LOGIN_OTP_VERIFY: 'login:otp:verify',

  /**
   * Failed password attempts for one identity, which is what locks an account.
   *
   * The one bucket keyed on **who is being guessed at** rather than on who is
   * guessing, which is why it must never be counted platform-wide: a
   * platform-wide counter over it locks every reseller's `admin` out because
   * one reseller's was attacked (F-066-o).
   *
   * Two routes spend it — ordinary login and the password-change check — on
   * purpose: the second is another way to guess a password, so it has to
   * consume the same budget or it becomes the cheaper door.
   */
  LOGIN_FAILURES: 'login-failures',

  REGISTER: 'register',
  REGISTER_VERIFY: 'register:verify',

  /**
   * Codes sent **to** one phone number, whatever asked for them (catalog 2.6:
   * 5 per hour).
   *
   * The second bucket keyed on the recipient rather than the caller, and for
   * the same reason as `LOGIN_FAILURES`: every other limit in front of an OTP
   * counts an IP, a signed-in caller or a bot chat, and all three are things
   * an attacker can get more of. The number on the receiving end cannot, so
   * this is the one counter that bounds what a person's phone can be made to
   * receive — across login, register, forgot, the account-switch proof, and
   * across every surface including the bot.
   *
   * Never counted platform-wide, for `LOGIN_FAILURES`' reason exactly: the
   * subject is the victim, so one platform-wide counter would let an attack on
   * one reseller's user silence that number at every other reseller.
   */
  OTP_PHONE: 'otp:phone',

  /**
   * A chat's **unproven** bot traffic across the captcha-gated routes
   * (F-0201-c, F-0201-e) — what stands in for the slide a bot cannot drag.
   *
   * Subject: `bot:<chatId>`, the same `rateLimitSubject()` every other counter
   * a bot call meets is keyed on. What it adds over those is that it is a
   * **cross-route aggregate**: `LOGIN_PWD`, `LOGIN_OTP_REQUEST` and
   * `PASSWORD_FORGOT` each bound one chat on one route, and this bounds one
   * chat across every route the captcha was waived on.
   *
   * It carried **no subject** when ADR-0069 shipped it — the key was the
   * tenant's alone, the shape `ROLE_WRITE` uses — to price the breadth of an
   * attacker who buys messenger accounts. ADR-0070 reversed that on the user's
   * call: a budget shared by a reseller's whole bot is a budget one attacker
   * can spend to the end of the window, and the sign-in it then refuses belongs
   * to a customer who spent nothing of it. Breadth is now unbounded here and
   * ADR-0070 says so plainly rather than leaving it implied.
   *
   * Never counted platform-wide: one reseller's attacker must not be able to
   * shut every other reseller's bot sign-in.
   */
  BOT_UNPROVEN: 'bot:unproven',

  PASSWORD_FORGOT: 'pwd:forgot',
  PASSWORD_FORGOT_VERIFY: 'pwd:forgot:verify',

  OTP_DELIVERY_STATUS: 'otp:delivery',
  OTP_CHANNELS: 'otp:channels',

  CAPTCHA_CHALLENGE: 'captcha:challenge',
  CAPTCHA_VERIFY: 'captcha:verify',

  BOT_LINK_RESOLVE: 'bot:link:resolve',
  BOT_LINK_CONTACT: 'bot:link:contact',
  BOT_LINK_STATUS: 'bot:link:status',
  BOT_SESSION: 'bot:session',
  BOT_WEBAPP_SESSION: 'bot:webapp:session',

  ACCOUNTS_ADD_OTP_REQUEST: 'accounts:add:otp:req',
  ACCOUNTS_ADD_OTP_VERIFY: 'accounts:add:otp:verify',
  ACCOUNTS_ADD_PASSWORD: 'accounts:add:pwd',
  ACCOUNTS_LIST: 'accounts:list',

  /**
   * `GET /auth/me` (F-097), per caller. A read of the caller's own row, but the
   * one every panel screen asks on load, so the budget is a client in a loop
   * rather than a person.
   */
  ME: 'me',
  /**
   * `POST /auth/me/email` and `.../verify` (F-035-g), per caller. The request
   * sends a real mail, so its budget is a person pressing "resend", not a loop.
   */
  ME_EMAIL_REQUEST: 'me:email:req',
  ME_EMAIL_VERIFY: 'me:email:verify',

  /**
   * The handoff to a reseller's own panel (F-061-f): the list and the mint per
   * caller, the redeem per `rateLimitSubject` — it runs before any session.
   */
  HANDOFF_LIST: 'handoff:list',
  HANDOFF_ISSUE: 'handoff:issue',
  HANDOFF_REDEEM: 'handoff:redeem',

  /**
   * `GET /auth/users?q=` (F-018-ad), per caller. The platform owner finds a
   * user as it types into a picker, so the budget is keystrokes — and a cap on
   * walking the user table a few characters at a time.
   */
  USER_SEARCH: 'users:search',

  /**
   * The writes of `/auth/roles` (F-018-n), per **tenant** rather than per
   * caller: a role is the tenant's, so two admins of one reseller share the
   * budget, and a reseller cannot widen it by adding admins.
   */
  ROLE_WRITE: 'roles:write',

  ACCOUNTS_SWITCH: 'accounts:switch',
  ACCOUNTS_REMOVE: 'accounts:remove',

  /**
   * The top-up page's read routes in `billing-service` (F-092-r), per user. A
   * quote at an automatic-fee gateway is one call to the bank, so this budget
   * is also what stands between a user and the merchant's own limit there.
   */
  DEPOSIT_GATEWAYS: 'deposit:gateways',
  DEPOSIT_QUOTE: 'deposit:quote',

  /**
   * Starting a top-up in `billing-service` (F-092-i), per user. Not a read: each
   * call holds coupons, writes a `payment_transaction` and mints an authority at
   * the bank, and every abandoned one sits pending until the expiry job clears
   * it. Its budget is therefore far below the quote's — a user picks a gateway
   * once and pays, and anything that looks like a hundred of these in a quarter
   * of an hour is a stuck client or somebody burning coupon capacity.
   */
  DEPOSIT_START: 'deposit:start',

  /**
   * Giving up a Mini App top-up before paying it (F-093-q), per user. One per
   * `DEPOSIT_START`, near enough — a sheet the payer closed is followed by
   * exactly one of these — so it gets a budget of its own rather than eating
   * the one a payer needs to try again.
   */
  DEPOSIT_ABANDON: 'deposit:abandon',

  /**
   * Creating an invoice in `billing-service` (F-111-a), per user. Each call
   * holds coupons for 30 minutes, so its budget sits with `DEPOSIT_START`'s
   * rather than a read's: a shopper makes one invoice and pays it.
   */
  INVOICE_CREATE: 'invoice:create',

  /**
   * Paying an invoice from the wallet (F-111-b), per user. Correctness does
   * not rest on it — a second pay of one invoice is refused under its row
   * lock — it bounds the transactions one caller can open on the wallet row.
   */
  INVOICE_PAY: 'invoice:pay',

  /**
   * Giving up one's own pending invoice (F-114-d), per user. The shop cancels
   * the invoice it replaces each time the codes change — one per
   * `INVOICE_CREATE`, near enough — so it has a budget of its own rather than
   * eating the one a shopper needs to make the next invoice.
   */
  INVOICE_CANCEL: 'invoice:cancel',

  /**
   * Reading one's own invoice back (F-111-e), per user — the shop returning to
   * it after a top-up. A read, so a read's budget: it writes and holds nothing.
   */
  INVOICE_READ: 'invoice:read',

  /** The shop's list of what is for sale (F-111-e), per user. A read, like `INVOICE_READ`. */
  SHOP_OFFERS: 'shop:offers',

  /**
   * The bot relaying an in-chat payment's `pre_checkout_query` or
   * `successful_payment` to `billing-service` (F-104-k), per **user** — the
   * payer the gate names. Generous: a `paid` refused here is money the
   * platform took and the wallet did not see until a person looks.
   */
  DEPOSIT_IN_CHAT: 'deposit:in-chat',

  /**
   * Settling a top-up in `billing-service` (F-092-j), per **payment** — the
   * one bucket on this list whose subject is not a caller, because the caller
   * is a bank redirecting a browser and carries no identity at all. The
   * authority names the payment where a gateway mints one, and the `p` the
   * callback URL carries where it does not (F-104-u), so the budget is how many
   * times a single payment may be presented for settlement in a window: a user
   * reloading the result page costs one each time, and anything beyond that is
   * a replay of a redirect that has already been answered.
   */
  DEPOSIT_CALLBACK: 'deposit:callback',

  /**
   * A provider's signed posts to `billing-service` (F-104-b, ADR-0051), per
   * **gateway** — public like the callback, with no caller to count. One
   * gateway's whole event stream shares it, so it is sized above a retry burst.
   */
  DEPOSIT_WEBHOOK: 'deposit:webhook',

  /**
   * The financial page's two read routes in `billing-service` (F-092-n), per
   * user. Cheaper per call than a quote — neither leaves the database — but the
   * page refetches on every filter change, so the budget is the panel's own
   * typing speed rather than a bank's limit.
   */
  WALLET_HISTORY: 'wallet:history',
  WALLET_PAYMENTS: 'wallet:payments',

  /**
   * Redeeming a gift code in `billing-service` (F-092-m), per user. The one
   * budget on this list that is a security control rather than a cost control:
   * a gift code is a bearer secret worth money, and the route is the only thing
   * that says whether one exists. Its limit is set far below the read routes'
   * for that reason, and lowering it further costs a user nothing — nobody
   * types twenty gift codes in a quarter of an hour.
   */
  GIFT_REDEEM: 'gift:redeem',

  /**
   * Reissuing the subscription key of one Grant in `billing-service`
   * (F-502-p), per user. Its own bucket and not `GIFT_REDEEM`'s: a user who
   * lost a key has usually just redeemed a code, and spending the gift box's
   * deliberately tiny budget on a recovery would lock them out of the box that
   * gave them the key in the first place.
   *
   * A security control like `GIFT_REDEEM`, for the mirror-image reason. The
   * route is owner-only, so it is no oracle — but every call destroys a working
   * key, so an unbounded one is a way to make a user's own subscription
   * unusable in a loop, by that user's own session. The budget is a handful:
   * a key is lost by accident, not repeatedly.
   */
  GRANT_ROTATE_TOKEN: 'grant:rotate-token',

  /**
   * A user's own Grants, listed (F-502-r), per user. Not a security control and
   * not the reissue budget: this reads no secret and destroys nothing, and it is
   * the page the panel refetches — sharing `GRANT_ROTATE_TOKEN`'s handful of
   * calls would spend a user's recovery budget on looking at the list that
   * offers the recovery. It is here because
   * `request/rate-limit-coverage.spec.ts` admits no unlimited route.
   */
  GRANT_LIST: 'grant:list',

  /**
   * Whether the collector is still reading the panels a user's configs sit on
   * (F-027-w), per user. Not a security control: it answers a flag and three
   * numbers about the user's own service. It is its own bucket because the
   * service page polls it while metering is down — which is exactly when a
   * user is also refreshing everything else, and sharing `GRANT_LIST` would
   * make the page they came to read the one that runs out.
   */
  TRAFFIC_COLLECTION_HEALTH: 'traffic:collection-health',

  /**
   * A user's own configs under one Grant (F-027-ac), per user: the list the
   * service page opens, and the actions on them. Two buckets because the list
   * is read on every expand and an action is a deliberate press — sharing
   * would let looking at the configs spend the budget for acting on them. The
   * action budget is per request, and one request may name fifty configs.
   */
  CONFIG_LIST: 'config:list',
  CONFIG_ACTION: 'config:action',

  /**
   * The platform owner's settlement surface in `billing-service` (F-096-e),
   * per operator. Two buckets rather than one because the surface is read far
   * more often than it is written — an operator refreshes what is owed while
   * making a transfer, and grants a gateway a handful of times ever.
   *
   * Neither budget is a security control: the door is the `platform_owner`
   * check and the permission, and an operator who reaches these routes at all
   * is already the one person allowed to. They are here because
   * `request/rate-limit-coverage.spec.ts` admits no unlimited route, and
   * because a runaway admin UI polling `owed` is a cost like any other.
   */
  SETTLEMENT_ADMIN_READ: 'settlement:admin:read',
  SETTLEMENT_ADMIN_WRITE: 'settlement:admin:write',

  /**
   * Gateway management in `billing-service` (F-102-c), per user. Two buckets for
   * the settlement surface's reason: the list is read on every visit, a gateway
   * is created or changed a handful of times ever. Each write also costs a call
   * to `auth-service`'s vault seam, which the write budget bounds.
   */
  GATEWAY_ADMIN_READ: 'gateway:admin:read',
  GATEWAY_ADMIN_WRITE: 'gateway:admin:write',

  /**
   * The platform owner's systems surface in `billing-service` (F-027-ar), per
   * user. Registering a panel is a handful of acts ever, and each costs a call
   * to `tenant-service`'s vault seam and, on the next tick, a connection test
   * against somebody's server — the budget bounds both.
   */
  SYSTEMS_ADMIN_WRITE: 'systems:admin:write',

  /**
   * The systems page's reads (F-027-as), per user: the panel list, a panel's
   * capability matrix and the drift report. Database reads only — nothing
   * here reaches a panel — so the budget is a screen's, not a remote's.
   */
  SYSTEMS_ADMIN_READ: 'systems:admin:read',

  /**
   * Manual payment confirmation in `billing-service` (F-092-z), per user. The
   * list is polled by a screen; an inquire or a confirm is a call to a bank.
   */
  PAYMENT_MANUAL_READ: 'payment:manual:read',
  PAYMENT_MANUAL_WRITE: 'payment:manual:write',

  /**
   * Coupon and gift-code management in `billing-service` (F-502-f), per user.
   * The list and reports are read on every visit; a write — including a batch
   * export, which hands out credit — is a deliberate human act.
   */
  COUPON_ADMIN_READ: 'coupon:admin:read',
  COUPON_ADMIN_WRITE: 'coupon:admin:write',

  /**
   * Catalog management in `billing-service` (F-026-d), per user. The page reads
   * on every visit; a write — a new price above all — is a deliberate human act.
   */
  CATALOG_ADMIN_READ: 'catalog:admin:read',
  CATALOG_ADMIN_WRITE: 'catalog:admin:write',

  /**
   * The platform owner adjusting a reseller's billing wallet by hand in
   * `billing-service` (F-019-a), per user. Moving money by hand is rare.
   */
  TENANT_BILLING_ADMIN_WRITE: 'tenant-billing:admin:write',

  /**
   * A platform user buying a reseller in `tenant-service` (F-019-h), per user.
   * The read budget covers the package list and the slug suggestion, which the
   * form asks again as the name is typed; a purchase moves money and is rare.
   */
  RESELLER_PURCHASE_READ: 'reseller-purchase:read',
  RESELLER_PURCHASE_WRITE: 'reseller-purchase:write',

  /**
   * One of the caller's own payments (F-093-l), per user. Its own bucket, not
   * `WALLET_PAYMENTS`: the pending page polls it, and a payer watching a
   * verifying payment must not use up the financial page's list budget.
   */
  WALLET_PAYMENT: 'wallet:payment',

  /**
   * A user's notification inbox in `notification-service` (F-035-a), per user.
   * The read budget is a polling budget — the panel's dropdown asks for the
   * unread count until F-035-b pushes it — and marking read is its own bucket
   * so a user clearing their inbox never uses up the badge's refreshes.
   */
  NOTIFICATION_READ: 'notification:read',
  NOTIFICATION_WRITE: 'notification:write',

  /** Campaign management in `notification-service` (F-035-c), per admin. */
  NOTIFICATION_CAMPAIGN_READ: 'notification:campaign:read',
  NOTIFICATION_CAMPAIGN_WRITE: 'notification:campaign:write',

  /**
   * A named reseller's bots in `auth-service` (F-066-w5), per caller. Two
   * buckets for the gateway surface's reason: the list is read on every visit
   * to the console's bot step, while connecting one is a person pasting a
   * token.
   *
   * The write budget is the tighter of the two and is a security control as
   * well as a cost one: a connect calls the messenger with a value the caller
   * supplied, so an unbounded one is a way to test tokens through this platform
   * — and each accepted one writes two vault versions.
   */
  RESELLER_BOT_READ: 'reseller-bot:read',
  RESELLER_BOT_WRITE: 'reseller-bot:write',

  /**
   * A named reseller's own users in `auth-service` (F-311-a), per caller. The
   * same two-bucket split the bots surface uses, for the same reason: the list
   * is paged and searched as the reseller types, while a block is a decision
   * somebody took.
   *
   * The write budget is the tighter of the two because each block ends every
   * live session of the account it names — an unbounded one is a way to sign a
   * reseller's customers out in a loop.
   */
  RESELLER_USER_READ: 'reseller-user:read',
  RESELLER_USER_WRITE: 'reseller-user:write',

  /**
   * A named reseller's own revenue figure in `billing-service` (F-311-b), per
   * caller. Read only, so there is one bucket and not the usual pair.
   *
   * It is the most expensive read on any reseller-named surface: two aggregates
   * over that tenant's whole wallet and payment ledgers for the period asked
   * for, with no index that narrows them further than the window. The schema
   * caps the window at a year; this caps how often a caller may ask for one.
   */
  RESELLER_REVENUE_READ: 'reseller-revenue:read',

  /**
   * A named reseller's own campaigns in `notification-service` (F-313-d), per
   * caller. The two-bucket split the reseller users surface uses, for the same
   * reason: the list and the audience count are asked repeatedly while a
   * reseller narrows a segment, and drafting or starting a send is a decision
   * somebody took.
   *
   * The read budget carries the **audience count**, which is the expensive one:
   * a count over that tenant's users joined to their wallets, for a filter the
   * caller composes. The write budget is the tighter of the two because each
   * `send` puts a recipient row in front of every user in the segment — an
   * unbounded one is a way to broadcast to a reseller's whole customer base in
   * a loop, and the outbound ceiling (F-313-a) paces delivery, not drafting.
   */
  RESELLER_CAMPAIGN_READ: 'reseller-campaign:read',
  RESELLER_CAMPAIGN_WRITE: 'reseller-campaign:write',

  /**
   * Everything under `/api/public/<service>/` — the routes nobody signs in to
   * (F-018-al, ADR-0065), per visitor IP.
   *
   * **One bucket for the whole prefix, spent in the middleware and not by a
   * `@RateLimit` per route.** A public route is meant to be a controller and a
   * decorator; a limit each route opts into is a limit a new one silently does
   * without, and an unauthenticated route without one is exactly what this row
   * closed. The middleware runs before every guard, so it also counts the
   * requests `PublicRouteGuard` answers with the neutral 404 — a flood on a
   * host that matches no `tenant_domain` row is still a flood, and
   * `RedisKeys.rateLimit` puts it under `none` rather than throwing.
   *
   * **Per IP, not per host** (user, 2026-09-20). The tenant segment
   * `RedisKeys.rateLimit` adds is already the host's tenant, so the budget is
   * per reseller; the subject is the visitor, so one attacker is cut off
   * instead of every visitor to the reseller they aimed at.
   */
  PUBLIC_ROUTE: 'public:route',

  /**
   * What one tenant's bot may **send** on one platform, per second
   * (F-313-a, ADR-0066). Subject: `<tenantId>:<platform>`.
   *
   * **The one bucket in this registry that counts outbound traffic**, and so
   * the one whose key is not `ratelimit:<tenantId>:…`: it is spent on a worker
   * that has no request and walks many tenants in a single run, so the tenant
   * is in the subject and the prefix is `UnscopedRedisKeys.outboundRate`. It
   * lives here anyway, because this file is meant to be the whole rate-limit
   * surface of the platform in one screen, and a ceiling nobody can find is a
   * ceiling a second sender will re-invent.
   *
   * Over budget is not a rejection: the caller is told how long to wait, in the
   * shape a platform's own 429 uses.
   */
  BOT_SEND: 'bot:send',
} as const;

export type RateLimitBucket =
  (typeof RateLimitBucket)[keyof typeof RateLimitBucket];

/**
 * Join a declared bucket to the subject being counted.
 *
 * The separator lives here for the same reason the bucket names do: it is part
 * of a key on the wire, and a call site that used `.` or `/` instead would
 * quietly get its own counter. One line, one place.
 */
export function rateLimitBucketKey(
  bucket: RateLimitBucket,
  subject: string,
): string {
  return `${bucket}:${subject}`;
}
