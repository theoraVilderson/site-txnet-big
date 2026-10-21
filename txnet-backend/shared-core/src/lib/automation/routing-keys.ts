/**
 * Every routing key and outbox event type that more than one process spells
 * (C-08).
 *
 * The publisher and the binder of one key are always in different Nx apps —
 * `billing-service` writes `billing.payment.confirmed`, `worker-service` binds a
 * queue to it; `auth-service` publishes `automation.tick.<key>` and
 * `otp.delivery.send`, `worker-service` binds `automation.tick.#` and
 * `otp.delivery.#`. A key renamed on one side still publishes: to no queue,
 * with `mandatory` turning it into an `unroutable` nobody reads as a typo. So
 * each is written once, here, beside `BOT_UPDATE_ROUTING_PREFIX` and
 * `OUTBOX_ROUTING_PREFIX`, for the reason those already are.
 */

/**
 * The outbox events a browser also reads off a `user:` channel (or, for
 * `network.panel.tested`, its operator's `tenant:` one), under the same name —
 * held to `contracts/realtime/events.json` (C-08).
 */
export const RealtimeEventType = {
  PAYMENT_CONFIRMED: 'billing.payment.confirmed',
  PAYMENT_REVERSED: 'billing.payment.reversed',
  NOTIFICATION_CREATED: 'notification.created',
  /** F-027-bs: `network-service` wrote a connection test's verdict or fault (`register.PostgresStore`). */
  PANEL_TESTED: 'network.panel.tested',
  /** F-027-el (ADR-0122): a panel's health changed, confirmed — state or cause, with since when (`panelstate.PostgresWriter`). */
  PANEL_STATE_CHANGED: 'network.panel.state_changed',
  /** F-027-fg (ADR-0130): a halting drift event was raised on a panel (`collect.PostgresDriftEvents.Raise`). */
  PANEL_DRIFT_RAISED: 'network.panel.drift_raised',
  /** RT-1-f: a drain sweep retired configs of a draining group member, or removed it (`GroupDrainService.drainDue`). */
  PANEL_DRAINED: 'network.panel.drained',
  /** F-111-d: a paid Grant was delivered — `pending` -> `active` (spec §5.8 step 3). */
  GRANT_DELIVERED: 'entitlement.grant.delivered',
  /** F-111-d: a paid Grant could not be delivered — cancelled, its invoice refunded in full. */
  GRANT_REFUNDED: 'entitlement.grant.refunded',
  /** F-111-l: `network-service` captured a config's link lines — a Grant's configs are ready to use (`converge.PostgresDesired.Record`). */
  GRANT_LINKS_CAPTURED: 'network.grant.linksCaptured',
  /** F-111-m: a wallet balance moved, any reason, any writer (`WalletLedgerService`). */
  WALLET_CHANGED: 'billing.wallet.changed',
  /** F-307-t: a Grant's committed `consumedBytes`, at most once per 30 s per Grant (`MeteringService.charge`). */
  GRANT_USAGE: 'entitlement.grant.usage',
  /** F-0401-c: a Grant's freeze changed by its user — its owner's pages re-read it; nobody is told. */
  GRANT_FREEZE_CHANGED: 'entitlement.grant.freeze_changed',
  /** RT-1-e / EDGE-1-e: a reseller domain's status or edge step changed (`TenantDomainService`). */
  TENANT_DOMAIN_CHANGED: 'tenant.domain.changed',
  /** F-019-c1: a reseller's renewal was paid — a new period, and a suspension for non-payment lifted (`TenantRenewalService`). */
  TENANT_SUBSCRIPTION_RENEWED: 'tenant.subscription.renewed',
  /** F-019-c2: a reseller's status or suspension cause changed, any writer (`applyTenantStatus`, `makeSuspensionManual`). */
  TENANT_STATUS_CHANGED: 'tenant.status.changed',
  /** F-019-c3: the platform owner moved a reseller's renewal deadline (`graceUntil`), status changed or not (`TenantSubscriptionService.grantGrace`). */
  TENANT_SUBSCRIPTION_GRACE_EXTENDED: 'tenant.subscription.grace_extended',
  /** AC-1-q: what a person may do moved — a role set or edited, a seat removed (`recordAccessChange`, shared-core). */
  ACCESS_CHANGED: 'identity.access.changed',
  /** RT-1-l: a tenant's operating currency changed — every member's money pages re-read (`TenantOperatingCurrencyService.set`). */
  TENANT_CURRENCY_CHANGED: 'tenant.currency.changed',
  /** RT-1-m2: a reseller's currency changed — its owner and the platform's staff re-read its workspace (`TenantOperatingCurrencyService.set`). */
  TENANT_RESELLER_CURRENCY_CHANGED: 'tenant.currency.reseller_changed',
  /** RT-1-j: an open payment (`pending`/`expired`) appeared, moved or settled — the manual-payments list and its badge re-read (`announceOpenPayment`). */
  PAYMENT_OPEN_CHANGED: 'billing.payment.open_changed',
  /** F-093-v: the same, for a reseller's payment — its owner's `user:` channel, since they sit in the platform's tenant (`announceOpenPayment`). */
  PAYMENT_RESELLER_OPEN_CHANGED: 'billing.payment.reseller_open_changed',
  /** The same, to the payer's own `user:` channel — any status move of their payment, so their financial page re-reads that row (`announceOpenPayment`). */
  PAYMENT_CHANGED: 'billing.payment.changed',
  /** F-1001-a: a rollup pass changed a tenant's analytics rows for `{from, to}` — the analytics page re-reads (`AnalyticsRollupService`). */
  ANALYTICS_REFRESHED: 'billing.analytics.refreshed',
  /** The same pass, for a reseller's workspace: its owner's `user:` and the platform's `tenant:` (F-1001-p, RT-1-e's pair). */
  ANALYTICS_RESELLER_REFRESHED: 'billing.analytics.reseller_refreshed',
  /** F-1006-a: a scheduled analytics report is due (or asked now) — one per send, to the schedule's person (`AnalyticsReportService`); worker-service tells it and pushes its schedule live. */
  ANALYTICS_REPORT: 'billing.analytics.report',
  /** F-311-ad: a config move job moved a batch, finished or was cancelled — its page re-reads the job (`ConfigMoveJobDrainService`). */
  CONFIG_MOVE_JOB_PROGRESS: 'network.config_move_job.progress',
  /** F-206, F-207: an import's run moved — previewed, back to draft, a commit batch, its end, a cancel — its page re-reads the run. */
  MIGRATION_RUN_PROGRESS: 'entitlement.migration_run.progress',
  GRANT_BULK_PROGRESSED: 'billing.grant_bulk.progressed',
  /** F-513-b: a capped variant's sold or held count moved — its tenant's shop and catalog re-read what is left (`moveSales`). */
  CATALOG_VARIANT_SALES_CHANGED: 'catalog.variant.sales_changed',
} as const;

/**
 * The realtime events a service publishes on a channel itself, never through
 * the outbox — so never an {@link OutboxEventType} and never bound by a queue.
 * Held to `contracts/realtime/events.json` beside {@link RealtimeEventType}.
 */
export const DirectRealtimeEventType = {
  /** RT-1-g: a support conversation moved in its tenant's queue — opened, assigned, answered, settled, reopened (`SupportRealtime.tenant`). */
  SUPPORT_INBOX_CHANGED: 'support.inbox.changed',
} as const;

/** Outbox event types (`outbox_event.type`), routed as `outboxRoutingKey(type)`. Only {@link RealtimeEventType} reach a browser. */
export const OutboxEventType = {
  ...RealtimeEventType,
  /** F-019-c: a reseller's billing wallet was credited — its renewal may now be paid (`TenantBillingLedger.credit`). */
  TENANT_BILLING_CREDITED: 'tenant.billing.credited',
  /** F-019-c: a renewal is unpaid and in grace; the owner is warned. */
  TENANT_SUBSCRIPTION_PAYMENT_DUE: 'tenant.subscription.payment_due',
  /** F-019-c: grace ran out and the reseller was suspended for non-payment. */
  TENANT_SUBSCRIPTION_SUSPENDED: 'tenant.subscription.suspended',
  /** F-118-w: a reseller's billing wallet refused a wholesale leg — once per refusal spell; its users on platform panels are cut (`noticeWholesaleUnfunded`). */
  TENANT_WHOLESALE_UNFUNDED: 'tenant.billing.wholesale_unfunded',
  /** F-019-v8: a reseller's quota crossed 80%, filled (overage started, or stopped), or stopped for want of money — once per window and period (`quota-alerts.ts`). */
  TENANT_QUOTA_ALERT: 'tenant.quota.alert',
  /** F-019-v8: yesterday's refused units and overage, told to a reseller's owner from 09:00 on the quota clock — once a day (`quotaDigests`). */
  TENANT_QUOTA_DIGEST: 'tenant.quota.digest',
  /** RT-1-e2: a reseller's custom domain went live (verified and its certificate issued), failed its window, or lost its record — told to its owner (`TenantDomainService`). */
  TENANT_DOMAIN_NOTICE: 'tenant.domain.notice',
  /** F-117-d (ADR-0104 (5)): the platform's staff entered a reseller in an emergency, without its consent — told to its owner at entry. */
  TENANT_EMERGENCY_ENTRY: 'tenant.support.emergency_entry',
  /** F-707-e: a tenant's wheel spent 80% of the day's cap — once a tenant day, one event per admin holding `engagement.manage` (`alertCapCrossing`). */
  TENANT_WHEEL_CAP_NEARING: 'tenant.engagement.wheel_cap_nearing',
  /** F-805-b: a payer sent a manual transfer's proof — one event per person of the gateway's owner who holds `payment.confirm_manual` (`tellReviewers`). */
  TRANSFER_PROOF_SENT: 'billing.payment.transfer_proof_sent',
  /** F-1003: a user's 30-day cost passed their net by the tenant's percent — one per staff member told, once a tenant month (`tellLosses`). */
  ANALYTICS_USER_LOSS: 'billing.analytics.user_loss',
  /** F-707-m: a lottery winner was given its prize — once per winner row (`LotteryDeliveryService`). */
  LOTTERY_WON: 'engagement.lottery.won',
  /** F-707-q: a lottery was published — once per lottery, in the publish (`LotteryAdminService.publish`); worker-service tells its group's members. */
  LOTTERY_PUBLISHED: 'engagement.lottery.published',
  /** F-027-at: the platform owner released a usage hold; `metering-service` bills it (ADR-0080 decision 3). */
  USAGE_RELEASE: 'network.usage.release',
  /** F-118-f: a reporter's usage of a non-VPN meter; `metering-service` advances the Grant's `grant_meter.consumed` (ADR-0105 decision 5). */
  USAGE_EVENT: 'billing.usage.event',
  /** F-1001-f: a user signed up — identity's registration; `metering-service` records it for analytics' signups (`user-signed-up.ts`). */
  USER_SIGNED_UP: 'identity.user.signed_up',
  /** F-111-b: a paid invoice issued a Grant, `pending` until delivery (spec §5.8 step 2). */
  GRANT_CREATED: 'entitlement.grant.created',
  /** F-111-n: `network-service` read a Grant's config back from its panel — `complete` (`converge.PostgresDesired.Record`). */
  CONFIG_CONFIRMED: 'network.config.confirmed',
  /** F-027-dw: the lease planner closed a Grant — served reached Quota (`leaseplan.PostgresStore.SaveClosure`). */
  GRANT_CLOSED: 'network.grant.closed',
  /** F-601-c: an active Grant consumed nothing in the 24 h after activation — "not connected yet?" (`GrantUnusedNoticeService`). */
  GRANT_NOT_CONNECTED: 'entitlement.grant.not_connected',
  /** F-601-c: the same, 72 h after activation — the second and last ask. */
  GRANT_STILL_NOT_CONNECTED: 'entitlement.grant.still_not_connected',
  /** F-601-d: a prepaid Grant's usage crossed 50 % of its period's bytes (`MeteringService.charge`). One type per level: notification's ledger holds each once. */
  GRANT_USAGE_50: 'entitlement.grant.usage_50',
  /** F-601-d: the same at 80 %. */
  GRANT_USAGE_80: 'entitlement.grant.usage_80',
  /** F-601-d: the same at 95 %. */
  GRANT_USAGE_95: 'entitlement.grant.usage_95',
  /** F-601-e: an active Grant is 7 days from its end — one per end (`GrantEndNoticeService`). */
  GRANT_ENDS_IN_7D: 'entitlement.grant.ends_in_7d',
  /** F-601-e: the same, 3 days out. */
  GRANT_ENDS_IN_3D: 'entitlement.grant.ends_in_3d',
  /** F-601-e: the same, 1 day out — the last. */
  GRANT_ENDS_IN_1D: 'entitlement.grant.ends_in_1d',
  /** F-601-b: a Grant was cut off because its time ran out — renewing brings it back (`suspendIfClosed`). Cutoff notices are never muted (F-601-m). */
  GRANT_ENDED: 'entitlement.grant.ended',
  /** F-601-b: a prepaid Grant was suspended because its volume ran out — renewing brings it back (`suspendIfClosed`). */
  GRANT_VOLUME_SPENT: 'entitlement.grant.volume_spent',
  /** F-601-b: a metered Grant was suspended because its wallet cannot buy the next block — a top-up brings it back, a renewal does not (`suspendIfExhausted`). */
  GRANT_WALLET_SPENT: 'entitlement.grant.wallet_spent',
  /** F-118-t: the same stop when the Grant's spending cap, not the wallet, refused the next block — raising or removing the cap brings it back. */
  GRANT_CAP_REACHED: 'entitlement.grant.cap_reached',
  /** F-601-j: a suspended prepaid Grant's configs are dropped from its panel within a day (`purgeAfterDays`) — renewing keeps them. Never muted (F-601-m). */
  GRANT_PURGE_SOON: 'entitlement.grant.purge_soon',
  /** F-601-j: the same for a metered Grant — a top-up keeps them, a renewal does not. */
  GRANT_PURGE_SOON_METERED: 'entitlement.grant.purge_soon_metered',
  /** F-118-t: the same for a Grant its spending cap stopped — raising or removing the cap keeps them. */
  GRANT_PURGE_SOON_CAPPED: 'entitlement.grant.purge_soon_capped',
  /** F-601-k: a stopped Grant runs again — a renewal or a top-up revived it, or a renewal broke the close that stood on it (`reactivated.ts`). */
  GRANT_REACTIVATED: 'entitlement.grant.reactivated',
  /** F-601-l: an active Grant that was used has consumed nothing for 7 days — one "trouble connecting?" per idle stretch (`idle-notice.ts`). */
  GRANT_IDLE: 'entitlement.grant.idle',
  /** F-602: a prepaid Grant's last 72 h spend what is left of its period within 5 days — "runs out in N days", once per usage period (`exhaustion-forecast.ts`). */
  GRANT_RUNS_OUT_SOON: 'entitlement.grant.runs_out_soon',
  /** F-602: the same forecast, within a day. */
  GRANT_RUNS_OUT_WITHIN_A_DAY: 'entitlement.grant.runs_out_within_a_day',
  /** F-601-g: a metered Grant's wallet now buys less than a GB at its rate — once per crossing; a top-up is what keeps it running (spec 9.3 `wallet.low_balance`). */
  GRANT_LOW_BALANCE: 'entitlement.grant.low_balance',
  /** F-601-i: a paid Grant still `pending` 5 minutes on — the buyer is told it is being prepared, the tenant's owner why; once per Grant. */
  GRANT_DELIVERY_DELAYED: 'entitlement.grant.delivery_delayed',
  /** F-311-s: an admin froze the user's Grant — one per act, its audit row's id the period (`grant-audit/admin-notice.ts`). Every admin notice is never muted. */
  GRANT_ADMIN_FROZEN: 'entitlement.grant.admin_frozen',
  /** F-311-s: an admin unfroze it; the frozen time was added to its end. */
  GRANT_ADMIN_UNFROZEN: 'entitlement.grant.admin_unfrozen',
  /** F-311-s: an admin moved its end later — `days`, whole and never zero; `reactivated` when that brought a stopped Grant back (one message, not two). */
  GRANT_ADMIN_DAYS_ADDED: 'entitlement.grant.admin_days_added',
  /** F-311-s: an admin moved its end earlier — `days`. */
  GRANT_ADMIN_DAYS_REMOVED: 'entitlement.grant.admin_days_removed',
  /** F-311-s: an admin raised its traffic, or gifted bytes — `amount` ("5.0 GB"). */
  GRANT_ADMIN_TRAFFIC_ADDED: 'entitlement.grant.admin_traffic_added',
  /** F-311-s: an admin lowered its traffic — `amount`. */
  GRANT_ADMIN_TRAFFIC_REMOVED: 'entitlement.grant.admin_traffic_removed',
  /** F-311-s: an admin reset its traffic; the full volume is left again. */
  GRANT_ADMIN_TRAFFIC_RESET: 'entitlement.grant.admin_traffic_reset',
  /** F-311-s: an admin deleted it. */
  GRANT_ADMIN_DELETED: 'entitlement.grant.admin_deleted',
  /** F-311-s: an admin rotated its `/sub` link; the old one no longer answers. */
  GRANT_ADMIN_LINK_ROTATED: 'entitlement.grant.admin_link_rotated',
  /** F-311-s: an admin capped its speed — `mbps`. */
  GRANT_ADMIN_SPEED_CAPPED: 'entitlement.grant.admin_speed_capped',
  /** F-311-s: an admin lifted its speed cap. */
  GRANT_ADMIN_SPEED_UNCAPPED: 'entitlement.grant.admin_speed_uncapped',
  /** F-311-s: an admin limited its devices at once — `limit`. */
  GRANT_ADMIN_DEVICES_LIMITED: 'entitlement.grant.admin_devices_limited',
  /** F-311-s: an admin lifted its device limit. */
  GRANT_ADMIN_DEVICES_UNLIMITED: 'entitlement.grant.admin_devices_unlimited',
  /** F-311-s: an admin issued the user a service — born `active`, so the purchase's "ready" never fires; optional `servicesUrl`. */
  GRANT_ADMIN_ISSUED: 'entitlement.grant.admin_issued',
  /** F-311-s: an admin renewed it in place. */
  GRANT_ADMIN_RENEWED: 'entitlement.grant.admin_renewed',
  /** F-311-s: an admin regenerated one of its configs — the line changed. Told on the config's Grant. */
  GRANT_ADMIN_CONFIG_REGENERATED: 'entitlement.grant.admin_config_regenerated',
  /** F-311-s: an admin turned one of its configs off. */
  GRANT_ADMIN_CONFIG_DISABLED: 'entitlement.grant.admin_config_disabled',
  /** F-311-s: an admin turned one of its configs back on. */
  GRANT_ADMIN_CONFIG_ENABLED: 'entitlement.grant.admin_config_enabled',
  /** F-311-s: an admin retired one of its configs. */
  GRANT_ADMIN_CONFIG_RETIRED: 'entitlement.grant.admin_config_retired',
  /** F-311-s: an admin moved one of its configs to another server. */
  GRANT_ADMIN_CONFIG_MOVED: 'entitlement.grant.admin_config_moved',
} as const;
export type OutboxEventType = (typeof OutboxEventType)[keyof typeof OutboxEventType];

/**
 * Which app binds a queue to each outbox event type (F-114-i). The relay
 * publishes `mandatory` and never skips a row, so a type nobody binds is
 * `unroutable` for ever and holds every later event behind it. Exhaustive: a
 * new type does not compile until somebody says who consumes it, and
 * `grant-created.consumer.spec.ts` holds worker-service's broker to its share.
 */
export const OUTBOX_EVENT_BINDER: Record<OutboxEventType, 'worker-service' | 'metering-service'> = {
  [OutboxEventType.PAYMENT_CONFIRMED]: 'worker-service',
  [OutboxEventType.PAYMENT_REVERSED]: 'worker-service',
  [OutboxEventType.NOTIFICATION_CREATED]: 'worker-service',
  [OutboxEventType.PANEL_TESTED]: 'worker-service',
  [OutboxEventType.PANEL_STATE_CHANGED]: 'worker-service',
  [OutboxEventType.PANEL_DRIFT_RAISED]: 'worker-service',
  [OutboxEventType.GRANT_DELIVERED]: 'worker-service',
  [OutboxEventType.GRANT_REFUNDED]: 'worker-service',
  [OutboxEventType.GRANT_LINKS_CAPTURED]: 'worker-service',
  [OutboxEventType.WALLET_CHANGED]: 'worker-service',
  [OutboxEventType.GRANT_USAGE]: 'worker-service',
  [OutboxEventType.GRANT_FREEZE_CHANGED]: 'worker-service',
  [OutboxEventType.TENANT_DOMAIN_CHANGED]: 'worker-service',
  [OutboxEventType.TENANT_SUBSCRIPTION_RENEWED]: 'worker-service',
  [OutboxEventType.TENANT_STATUS_CHANGED]: 'worker-service',
  [OutboxEventType.ACCESS_CHANGED]: 'worker-service',
  [OutboxEventType.PAYMENT_OPEN_CHANGED]: 'worker-service',
  [OutboxEventType.PAYMENT_RESELLER_OPEN_CHANGED]: 'worker-service',
  [OutboxEventType.PAYMENT_CHANGED]: 'worker-service',
  [OutboxEventType.TENANT_CURRENCY_CHANGED]: 'worker-service',
  [OutboxEventType.TENANT_RESELLER_CURRENCY_CHANGED]: 'worker-service',
  [OutboxEventType.ANALYTICS_REFRESHED]: 'worker-service',
  [OutboxEventType.ANALYTICS_RESELLER_REFRESHED]: 'worker-service',
  [OutboxEventType.ANALYTICS_USER_LOSS]: 'worker-service',
  [OutboxEventType.ANALYTICS_REPORT]: 'worker-service',
  [OutboxEventType.CONFIG_MOVE_JOB_PROGRESS]: 'worker-service',
  [OutboxEventType.MIGRATION_RUN_PROGRESS]: 'worker-service',
  [OutboxEventType.GRANT_BULK_PROGRESSED]: 'worker-service',
  [OutboxEventType.CATALOG_VARIANT_SALES_CHANGED]: 'worker-service',
  [OutboxEventType.PANEL_DRAINED]: 'worker-service',
  [OutboxEventType.TENANT_SUBSCRIPTION_GRACE_EXTENDED]: 'worker-service',
  [OutboxEventType.TENANT_BILLING_CREDITED]: 'worker-service',
  [OutboxEventType.TENANT_SUBSCRIPTION_PAYMENT_DUE]: 'worker-service',
  [OutboxEventType.TENANT_SUBSCRIPTION_SUSPENDED]: 'worker-service',
  [OutboxEventType.TENANT_WHOLESALE_UNFUNDED]: 'worker-service',
  [OutboxEventType.TENANT_QUOTA_ALERT]: 'worker-service',
  [OutboxEventType.TENANT_QUOTA_DIGEST]: 'worker-service',
  [OutboxEventType.TENANT_EMERGENCY_ENTRY]: 'worker-service',
  [OutboxEventType.TENANT_DOMAIN_NOTICE]: 'worker-service',
  [OutboxEventType.TENANT_WHEEL_CAP_NEARING]: 'worker-service',
  [OutboxEventType.TRANSFER_PROOF_SENT]: 'worker-service',
  [OutboxEventType.LOTTERY_WON]: 'worker-service',
  [OutboxEventType.LOTTERY_PUBLISHED]: 'worker-service',
  [OutboxEventType.USAGE_RELEASE]: 'metering-service',
  [OutboxEventType.USAGE_EVENT]: 'metering-service',
  [OutboxEventType.USER_SIGNED_UP]: 'metering-service',
  [OutboxEventType.GRANT_CREATED]: 'worker-service',
  [OutboxEventType.CONFIG_CONFIRMED]: 'worker-service',
  [OutboxEventType.GRANT_CLOSED]: 'worker-service',
  [OutboxEventType.GRANT_NOT_CONNECTED]: 'worker-service',
  [OutboxEventType.GRANT_STILL_NOT_CONNECTED]: 'worker-service',
  [OutboxEventType.GRANT_USAGE_50]: 'worker-service',
  [OutboxEventType.GRANT_USAGE_80]: 'worker-service',
  [OutboxEventType.GRANT_USAGE_95]: 'worker-service',
  [OutboxEventType.GRANT_ENDS_IN_7D]: 'worker-service',
  [OutboxEventType.GRANT_ENDS_IN_3D]: 'worker-service',
  [OutboxEventType.GRANT_ENDS_IN_1D]: 'worker-service',
  [OutboxEventType.GRANT_ENDED]: 'worker-service',
  [OutboxEventType.GRANT_VOLUME_SPENT]: 'worker-service',
  [OutboxEventType.GRANT_WALLET_SPENT]: 'worker-service',
  [OutboxEventType.GRANT_CAP_REACHED]: 'worker-service',
  [OutboxEventType.GRANT_PURGE_SOON]: 'worker-service',
  [OutboxEventType.GRANT_PURGE_SOON_METERED]: 'worker-service',
  [OutboxEventType.GRANT_PURGE_SOON_CAPPED]: 'worker-service',
  [OutboxEventType.GRANT_REACTIVATED]: 'worker-service',
  [OutboxEventType.GRANT_IDLE]: 'worker-service',
  [OutboxEventType.GRANT_RUNS_OUT_SOON]: 'worker-service',
  [OutboxEventType.GRANT_RUNS_OUT_WITHIN_A_DAY]: 'worker-service',
  [OutboxEventType.GRANT_LOW_BALANCE]: 'worker-service',
  [OutboxEventType.GRANT_DELIVERY_DELAYED]: 'worker-service',
  [OutboxEventType.GRANT_ADMIN_FROZEN]: 'worker-service',
  [OutboxEventType.GRANT_ADMIN_UNFROZEN]: 'worker-service',
  [OutboxEventType.GRANT_ADMIN_DAYS_ADDED]: 'worker-service',
  [OutboxEventType.GRANT_ADMIN_DAYS_REMOVED]: 'worker-service',
  [OutboxEventType.GRANT_ADMIN_TRAFFIC_ADDED]: 'worker-service',
  [OutboxEventType.GRANT_ADMIN_TRAFFIC_REMOVED]: 'worker-service',
  [OutboxEventType.GRANT_ADMIN_TRAFFIC_RESET]: 'worker-service',
  [OutboxEventType.GRANT_ADMIN_DELETED]: 'worker-service',
  [OutboxEventType.GRANT_ADMIN_LINK_ROTATED]: 'worker-service',
  [OutboxEventType.GRANT_ADMIN_SPEED_CAPPED]: 'worker-service',
  [OutboxEventType.GRANT_ADMIN_SPEED_UNCAPPED]: 'worker-service',
  [OutboxEventType.GRANT_ADMIN_DEVICES_LIMITED]: 'worker-service',
  [OutboxEventType.GRANT_ADMIN_DEVICES_UNLIMITED]: 'worker-service',
  [OutboxEventType.GRANT_ADMIN_ISSUED]: 'worker-service',
  [OutboxEventType.GRANT_ADMIN_RENEWED]: 'worker-service',
  [OutboxEventType.GRANT_ADMIN_CONFIG_REGENERATED]: 'worker-service',
  [OutboxEventType.GRANT_ADMIN_CONFIG_DISABLED]: 'worker-service',
  [OutboxEventType.GRANT_ADMIN_CONFIG_ENABLED]: 'worker-service',
  [OutboxEventType.GRANT_ADMIN_CONFIG_RETIRED]: 'worker-service',
  [OutboxEventType.GRANT_ADMIN_CONFIG_MOVED]: 'worker-service',
};

/** Every tick routing key starts with this. The suffix is the worker key. */
export const AUTOMATION_TICK_ROUTING_PREFIX = 'automation.tick.';
export const automationTickRoutingKey = (workerKey: string): string =>
  `${AUTOMATION_TICK_ROUTING_PREFIX}${workerKey}`;

/** Every OTP delivery routing key starts with this. */
export const OTP_DELIVERY_ROUTING_PREFIX = 'otp.delivery.';
/** The routing key an OTP send is published under. */
export const OTP_DELIVERY_ROUTING_KEY = `${OTP_DELIVERY_ROUTING_PREFIX}send`;

/**
 * A combined notice's flush (F-067-p, ADR-0084 decision 3). Published to the
 * delay queue under `DELAY`; the broker dead-letters it after the window under
 * `FLUSH`, which the flush queue binds.
 */
export const NOTICE_BURST_DELAY_ROUTING_KEY = 'notice.burst.delay';
export const NOTICE_BURST_FLUSH_ROUTING_KEY = 'notice.burst.flush';
/**
 * The hour lane's delay (F-601-p): a non-urgent retention notice waits up to an
 * hour for the same notice of the user's other services. Its own queue, since a
 * delay queue expires only its head and every message in one must share a window.
 */
export const NOTICE_BURST_HOUR_DELAY_ROUTING_KEY = 'notice.burst.delay-hour';
/**
 * A Grant's lines changed on its panel (F-027-eo): the check waits out
 * `AUTOMATION_LINES_SETTLE_MS` in a delay queue of its own and lands on
 * `GRANT_LINES_SETTLE_ROUTING_KEY`, the buyer-notice queue's, as an
 * outbox-shaped message of that type.
 */
export const GRANT_LINES_SETTLE_DELAY_ROUTING_KEY = 'grant.lines.settle-delay';
export const GRANT_LINES_SETTLE_ROUTING_KEY = 'grant.lines.settle';

/** A topic binding matching every routing key under `prefix` (which ends in `.`). */
export const topicBindingAll = (prefix: string): string => `${prefix}#`;
