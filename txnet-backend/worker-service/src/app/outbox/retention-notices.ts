import { OutboxEventType } from '@txnet-backend/shared-core';

/**
 * How one retention event is told: auth-service's template, the payload
 * fields passed to it as params, and `optional` ones passed only when the
 * payload has them (the tenant's support link, which it may not have set).
 */
export type RetentionNotice = { template: string; params: readonly string[]; optional?: readonly string[]; ahead?: AheadNotice };

/**
 * A second notice the event may carry, told with it as one message (F-601-f):
 * the payload's `endNotice` names it (one of `types`), `endPeriod` its period
 * and `days` the whole days left, which pick the combined text and its extra
 * params. Told combined only when the ledger gives this event both rows.
 */
export type AheadNotice = { types: readonly string[]; told: (days: string) => { template: string; params: readonly string[] } };

/** F-601-f: a time level due, carried by a usage threshold told with it (F-601-n: metering, or entitlement's end sweep). */
const USAGE_WITH_END: AheadNotice = {
  types: [OutboxEventType.GRANT_ENDS_IN_7D, OutboxEventType.GRANT_ENDS_IN_3D, OutboxEventType.GRANT_ENDS_IN_1D],
  told: (days) =>
    days === '1' ? { template: 'serviceUsageAndEndsWithinADay', params: [] } : { template: 'serviceUsageAndEndsSoon', params: ['days'] },
};

/**
 * Each retention event type (F-601, spec 9.5) and how it is told (F-601-a).
 * A producing row adds its type here, its template in auth-service's notify
 * seam, and `OUTBOX_EVENT_BINDER` names worker-service for it — the broker
 * binds the retention queue to every key of this table.
 *
 * Every payload carries `tenantId`, `userId`, `grantId` and `period` (the
 * producer's name for the Grant's current period; a renewal opens a new one)
 * besides the params named here, all required.
 *
 * Its own file, not the consumer's: `BrokerService` reads the keys, and the
 * consumer imports the broker.
 */
export const RETENTION_NOTICES: Partial<Record<OutboxEventType, RetentionNotice>> = {
  // F-601-c: nothing consumed 24 h, then 72 h, after activation — the steps, and the tenant's support.
  [OutboxEventType.GRANT_NOT_CONNECTED]: { template: 'serviceNotConnected', params: [], optional: ['supportUrl'] },
  [OutboxEventType.GRANT_STILL_NOT_CONNECTED]: { template: 'serviceStillNotConnected', params: [], optional: ['supportUrl'] },
  // F-601-d: a prepaid Grant's period crossed 50 / 80 / 95 % of its bytes — the level and what is left;
  // with a time level due the same day when there is one (F-601-f, F-601-n).
  [OutboxEventType.GRANT_USAGE_50]: { template: 'serviceUsageThreshold', params: ['percent', 'remaining'], ahead: USAGE_WITH_END },
  [OutboxEventType.GRANT_USAGE_80]: { template: 'serviceUsageThreshold', params: ['percent', 'remaining'], ahead: USAGE_WITH_END },
  [OutboxEventType.GRANT_USAGE_95]: { template: 'serviceUsageThreshold', params: ['percent', 'remaining'], ahead: USAGE_WITH_END },
  // F-601-e: 7 / 3 / 1 day(s) before a Grant's end — the whole days left; the last level reads "within a day".
  [OutboxEventType.GRANT_ENDS_IN_7D]: { template: 'serviceEndsSoon', params: ['days'] },
  [OutboxEventType.GRANT_ENDS_IN_3D]: { template: 'serviceEndsSoon', params: ['days'] },
  [OutboxEventType.GRANT_ENDS_IN_1D]: { template: 'serviceEndsWithinADay', params: [] },
  // F-601-b: the service stopped — time, a prepaid volume, a metered wallet. Cutoff notices: never muted (F-601-m).
  [OutboxEventType.GRANT_ENDED]: { template: 'serviceEnded', params: [] },
  [OutboxEventType.GRANT_VOLUME_SPENT]: { template: 'serviceVolumeSpent', params: [] },
  [OutboxEventType.GRANT_WALLET_SPENT]: { template: 'serviceWalletSpent', params: [] },
  // F-601-g: a metered Grant's wallet buys under a GB at its rate — what it still buys; once per crossing.
  [OutboxEventType.GRANT_LOW_BALANCE]: { template: 'serviceWalletLow', params: ['remaining'] },
  // F-601-j: a suspended Grant's configs are dropped from the panel within a day — renew, or top up if metered. Never muted (F-601-m).
  [OutboxEventType.GRANT_PURGE_SOON]: { template: 'servicePurgeSoon', params: [] },
  [OutboxEventType.GRANT_PURGE_SOON_METERED]: { template: 'servicePurgeSoonTopUp', params: [] },
  // F-601-k: a stopped Grant runs again — told once per stop undone, the link unchanged.
  [OutboxEventType.GRANT_REACTIVATED]: { template: 'serviceReactivated', params: [] },
  // F-601-l: used, then nothing for 7 days — one check-in per idle stretch, and the tenant's support.
  [OutboxEventType.GRANT_IDLE]: { template: 'serviceIdle', params: [], optional: ['supportUrl'] },
  // F-602: at the last 72 h's rate, what is left of the period runs out within 5 days (or a day) — once per usage period.
  [OutboxEventType.GRANT_RUNS_OUT_SOON]: { template: 'serviceRunsOutSoon', params: ['days', 'remaining'] },
  [OutboxEventType.GRANT_RUNS_OUT_WITHIN_A_DAY]: { template: 'serviceRunsOutWithinADay', params: ['remaining'] },
  // F-311-s: an admin's act on the service, told once per act (period = its audit row); never muted. `reactivated`: the act
  // also brought a stopped service back, said as the message's closing line instead of a second "active again".
  [OutboxEventType.GRANT_ADMIN_FROZEN]: { template: 'serviceFrozenByAdmin', params: [] },
  [OutboxEventType.GRANT_ADMIN_UNFROZEN]: { template: 'serviceUnfrozenByAdmin', params: [] },
  [OutboxEventType.GRANT_ADMIN_DAYS_ADDED]: { template: 'serviceDaysAddedByAdmin', params: ['days'], optional: ['reactivated'] },
  [OutboxEventType.GRANT_ADMIN_DAYS_REMOVED]: { template: 'serviceDaysRemovedByAdmin', params: ['days'] },
  [OutboxEventType.GRANT_ADMIN_TRAFFIC_ADDED]: { template: 'serviceTrafficAddedByAdmin', params: ['amount'], optional: ['reactivated'] },
  [OutboxEventType.GRANT_ADMIN_TRAFFIC_REMOVED]: { template: 'serviceTrafficRemovedByAdmin', params: ['amount'] },
  [OutboxEventType.GRANT_ADMIN_TRAFFIC_RESET]: { template: 'serviceTrafficResetByAdmin', params: [], optional: ['reactivated'] },
  [OutboxEventType.GRANT_ADMIN_DELETED]: { template: 'serviceDeletedByAdmin', params: [] },
  [OutboxEventType.GRANT_ADMIN_LINK_ROTATED]: { template: 'serviceLinkRotatedByAdmin', params: [] },
  [OutboxEventType.GRANT_ADMIN_SPEED_CAPPED]: { template: 'serviceSpeedCappedByAdmin', params: ['mbps'] },
  [OutboxEventType.GRANT_ADMIN_SPEED_UNCAPPED]: { template: 'serviceSpeedUncappedByAdmin', params: [] },
  [OutboxEventType.GRANT_ADMIN_DEVICES_LIMITED]: { template: 'serviceDevicesLimitedByAdmin', params: ['limit'] },
  [OutboxEventType.GRANT_ADMIN_DEVICES_UNLIMITED]: { template: 'serviceDevicesUnlimitedByAdmin', params: [] },
  [OutboxEventType.GRANT_ADMIN_ISSUED]: { template: 'serviceIssuedByAdmin', params: [], optional: ['servicesUrl'] },
  [OutboxEventType.GRANT_ADMIN_RENEWED]: { template: 'serviceRenewedByAdmin', params: [], optional: ['reactivated'] },
  [OutboxEventType.GRANT_ADMIN_CONFIG_REGENERATED]: { template: 'configRegeneratedByAdmin', params: [] },
  [OutboxEventType.GRANT_ADMIN_CONFIG_DISABLED]: { template: 'configDisabledByAdmin', params: [] },
  [OutboxEventType.GRANT_ADMIN_CONFIG_ENABLED]: { template: 'configEnabledByAdmin', params: [] },
  [OutboxEventType.GRANT_ADMIN_CONFIG_RETIRED]: { template: 'configRetiredByAdmin', params: [] },
  [OutboxEventType.GRANT_ADMIN_CONFIG_MOVED]: { template: 'configMovedByAdmin', params: [] },
};
