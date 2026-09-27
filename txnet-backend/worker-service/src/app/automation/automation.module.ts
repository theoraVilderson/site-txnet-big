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
import { GrantDeliveryJob } from '../jobs/grant-delivery.job';
import { GrantGroupFulfilmentJob } from '../jobs/grant-group-fulfilment.job';
import { DepositExpiryJob } from '../jobs/deposit-expiry.job';
import { InvoiceExpiryJob } from '../jobs/invoice-expiry.job';
import { CampaignFanOutJob } from '../jobs/campaign-fan-out.job';
import { CampaignDeliveryJob } from '../jobs/campaign-delivery.job';
import { DepositReconciliationJob, DepositVerifyRetryJob } from '../jobs/deposit-reconciliation.job';
import { OutboxRelayJob } from '../jobs/outbox-relay.job';
import { OUTBOX_READY_LISTEN_CLIENT, OutboxRelayListener } from '../jobs/outbox-relay.listener';
import { FxRateJob } from '../jobs/fx-rate.job';
import { TrafficRollupJob } from '../jobs/traffic-rollup.job';
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
    GrantPurgeJob,
    GrantGroupFulfilmentJob,
    GrantDeliveryJob,
    DepositExpiryJob,
    InvoiceExpiryJob,
    CampaignFanOutJob,
    CampaignDeliveryJob,
    DepositReconciliationJob,
    DepositVerifyRetryJob,
    OutboxRelayJob,
    // Wakes the relay on `outbox_ready` (F-067-n). Its own `pg.Client`, held
    // open for the life of the process — never the request pool.
    OutboxRelayListener,
    {
      provide: OUTBOX_READY_LISTEN_CLIENT,
      useFactory: (config: ConfigService) => () => new Client({ connectionString: config.get<string>('DATABASE_APP_URL') }),
      inject: [ConfigService],
    },
    FxRatePoller,
    FxRateSnapshotStore,
    FxRateJob,
    TrafficRollupJob,
    TenantSubscriptionRenewalJob,
    TenantDomainVerificationJob,
    {
      provide: JOBS,
      inject: [HeartbeatJob, VaultRetentionJob, GrantPurgeJob, GrantGroupFulfilmentJob, GrantDeliveryJob, DepositExpiryJob, InvoiceExpiryJob, DepositReconciliationJob, DepositVerifyRetryJob, OutboxRelayJob, FxRateJob, TrafficRollupJob, CampaignFanOutJob, CampaignDeliveryJob, TenantSubscriptionRenewalJob, TenantDomainVerificationJob],
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
