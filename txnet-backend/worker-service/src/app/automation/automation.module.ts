import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { Client } from 'pg';
import { WorkerRegistryService } from './worker-registry.service';
import { TickPublisher } from './tick.publisher';
import { TickConsumer } from './tick.consumer';
import { TenantStatusGate } from './tenant-status.gate';
import { DeadLetterDrain } from './dead-letter.drain';
import { TenantConcurrencyGate } from './tenant-concurrency.gate';
import { TenantRunLeases } from './tenant-run.leases';
import { JOBS, Job } from './job';
import { HeartbeatJob } from '../jobs/heartbeat.job';
import { VaultRetentionJob } from '../jobs/vault-retention.job';
import { GrantPurgeJob } from '../jobs/grant-purge.job';
import { GrantBulkJobDrainJob } from '../jobs/grant-bulk-job.job';
import { GrantUnusedNoticeJob } from '../jobs/grant-unused-notice.job';
import { AnalyticsRollupJob } from '../jobs/analytics-rollup.job';
import { GrantEndNoticeJob } from '../jobs/grant-end-notice.job';
import { GrantIdleNoticeJob } from '../jobs/grant-idle-notice.job';
import { UsageCaptureJob } from '../jobs/usage-capture.job';
import { VpnReserveJob } from '../jobs/vpn-reserve.job';
import { GrantExhaustionForecastJob } from '../jobs/grant-exhaustion-forecast.job';
import { AiProfileRebuildJob } from '../jobs/ai-profile-rebuild.job';
import { AiSuggestionDeliveryJob } from '../jobs/ai-suggestion-delivery.job';
import { RetentionHeldNoticeJob } from '../jobs/retention-held-notice.job';
import { GrantDeliveryJob } from '../jobs/grant-delivery.job';
import { LotteryCloseJob } from '../jobs/lottery-close.job';
import { SupportAutoCloseJob } from '../jobs/support-auto-close.job';
import { SupportRetentionJob } from '../jobs/support-retention.job';
import { GuideFileSweepJob } from '../jobs/guide-file-sweep.job';
import { GrantGroupFulfilmentJob } from '../jobs/grant-group-fulfilment.job';
import { DepositExpiryJob } from '../jobs/deposit-expiry.job';
import { InvoiceExpiryJob } from '../jobs/invoice-expiry.job';
import { GroupMembershipEndJob } from '../jobs/group-membership-end.job';
import { KeyWindowJob } from '../jobs/key-window.job';
import { CampaignFanOutJob } from '../jobs/campaign-fan-out.job';
import { CampaignDeliveryJob } from '../jobs/campaign-delivery.job';
import { DepositReconciliationJob, DepositVerifyRetryJob } from '../jobs/deposit-reconciliation.job';
import { OutboxRelayJob } from '../jobs/outbox-relay.job';
import { OUTBOX_READY_LISTEN_CLIENT, OutboxRelayListener } from '../jobs/outbox-relay.listener';
import { FxRateJob } from '../jobs/fx-rate.job';
import { TrafficRollupJob } from '../jobs/traffic-rollup.job';
import { AutomationHousekeepingJob } from '../jobs/automation-housekeeping.job';
import { TenantSubscriptionRenewalJob } from '../jobs/tenant-subscription-renewal.job';
import { ResellerQuotaDigestJob } from '../jobs/reseller-quota-digest.job';
import { CatalogSeasonWriteJob } from '../jobs/catalog-season-write.job';
import { TenantDomainVerificationJob } from '../jobs/tenant-domain-verification.job';
import { FxRatePoller } from '../currency/fx-rate.poller';
import { FxRateSnapshotStore } from '../currency/fx-rate.snapshot';

/**
 * Adding a job is two lines here and one new class: the class itself, and its
 * entry in the `JOBS` array. Nothing else in this service learns its name —
 * the registry reconciles it into a `bot_worker` row on boot, the publisher
 * finds it by that row's schedules, and the consumer dispatches on its `key`.
 *
 * The publisher and the consumer are in one module and, today, in one process.
 * They need not stay that way: they share only the broker, so splitting the
 * timer out into its own single replica while several consumers drain the queue
 * is a deployment change, not a code change.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [
    HeartbeatJob,
    VaultRetentionJob,
    GrantPurgeJob,
    GrantBulkJobDrainJob,
    GrantGroupFulfilmentJob,
    GrantDeliveryJob,
    LotteryCloseJob,
    SupportAutoCloseJob,
    SupportRetentionJob,
    GuideFileSweepJob,
    GrantUnusedNoticeJob,
    AnalyticsRollupJob,
    GrantEndNoticeJob,
    GrantIdleNoticeJob,
    UsageCaptureJob,
    VpnReserveJob,
    GrantExhaustionForecastJob,
    AiProfileRebuildJob,
    AiSuggestionDeliveryJob,
    RetentionHeldNoticeJob,
    DepositExpiryJob,
    InvoiceExpiryJob,
    GroupMembershipEndJob,
    KeyWindowJob,
    CampaignFanOutJob,
    CampaignDeliveryJob,
    DepositReconciliationJob,
    DepositVerifyRetryJob,
    OutboxRelayJob,
    // Wakes the relay on `outbox_ready` (F-067-n). Its own `pg.Client`, held
    // open for the life of the process — never the request pool, and direct
    // to main-db: a LISTEN does not survive db-pool (hosting H8, C-41).
    OutboxRelayListener,
    {
      provide: OUTBOX_READY_LISTEN_CLIENT,
      useFactory: (config: ConfigService) => () => new Client({ connectionString: config.get<string>('DATABASE_LISTEN_URL') }),
      inject: [ConfigService],
    },
    FxRatePoller,
    FxRateSnapshotStore,
    FxRateJob,
    TrafficRollupJob,
    AutomationHousekeepingJob,
    TenantSubscriptionRenewalJob,
    TenantDomainVerificationJob,
    ResellerQuotaDigestJob,
    CatalogSeasonWriteJob,
    {
      provide: JOBS,
      inject: [HeartbeatJob, VaultRetentionJob, GrantPurgeJob, GrantBulkJobDrainJob, GrantGroupFulfilmentJob, GrantDeliveryJob, LotteryCloseJob, SupportAutoCloseJob, SupportRetentionJob, GuideFileSweepJob, GrantUnusedNoticeJob, GrantEndNoticeJob, GrantIdleNoticeJob, UsageCaptureJob, VpnReserveJob, RetentionHeldNoticeJob, DepositExpiryJob, InvoiceExpiryJob, GroupMembershipEndJob, KeyWindowJob, DepositReconciliationJob, DepositVerifyRetryJob, OutboxRelayJob, FxRateJob, TrafficRollupJob, AutomationHousekeepingJob, CampaignFanOutJob, CampaignDeliveryJob, TenantSubscriptionRenewalJob, TenantDomainVerificationJob, ResellerQuotaDigestJob, AiProfileRebuildJob, AiSuggestionDeliveryJob, CatalogSeasonWriteJob, AnalyticsRollupJob],
      useFactory: (...jobs: Job[]) => jobs,
    },
    WorkerRegistryService,
    TickPublisher,
    TenantRunLeases,
    TenantConcurrencyGate,
    TenantStatusGate,
    TickConsumer,
    DeadLetterDrain,
  ],
})
export class AutomationModule {}
