import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
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
import { DepositExpiryJob } from '../jobs/deposit-expiry.job';
import { CampaignFanOutJob } from '../jobs/campaign-fan-out.job';
import { CampaignDeliveryJob } from '../jobs/campaign-delivery.job';
import { DepositReconciliationJob, DepositVerifyRetryJob } from '../jobs/deposit-reconciliation.job';
import { OutboxRelayJob } from '../jobs/outbox-relay.job';
import { FxRateJob } from '../jobs/fx-rate.job';
import { TenantSubscriptionRenewalJob } from '../jobs/tenant-subscription-renewal.job';
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
    DepositExpiryJob,
    CampaignFanOutJob,
    CampaignDeliveryJob,
    DepositReconciliationJob,
    DepositVerifyRetryJob,
    OutboxRelayJob,
    FxRatePoller,
    FxRateSnapshotStore,
    FxRateJob,
    TenantSubscriptionRenewalJob,
    TenantDomainVerificationJob,
    {
      provide: JOBS,
      inject: [HeartbeatJob, VaultRetentionJob, DepositExpiryJob, DepositReconciliationJob, DepositVerifyRetryJob, OutboxRelayJob, FxRateJob, CampaignFanOutJob, CampaignDeliveryJob, TenantSubscriptionRenewalJob, TenantDomainVerificationJob],
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
