import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { WorkerRegistryService } from './worker-registry.service';
import { TickPublisher } from './tick.publisher';
import { TickConsumer } from './tick.consumer';
import { TenantConcurrencyGate } from './tenant-concurrency.gate';
import { JOBS, Job } from './job';
import { HeartbeatJob } from '../jobs/heartbeat.job';
import { VaultRetentionJob } from '../jobs/vault-retention.job';

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
    {
      provide: JOBS,
      inject: [HeartbeatJob, VaultRetentionJob],
      useFactory: (...jobs: Job[]) => jobs,
    },
    WorkerRegistryService,
    TickPublisher,
    TenantConcurrencyGate,
    TickConsumer,
  ],
})
export class AutomationModule {}
