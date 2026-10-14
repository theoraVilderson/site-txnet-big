import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { WorkerRow } from '@txnet-backend/shared-core';
import { BrokerService } from '../broker/broker.service';
import { TickPublisher } from './tick.publisher';
import { WorkerRegistryService } from './worker-registry.service';

/**
 * OPS-1-r, hosting H18 — **a window whose schedule read failed is asked again,
 * not lost.** A short database outage over 03:00 used to swallow the nightly
 * job: the failed tick had already moved `since` past 03:00, so the next tick
 * asked only about 03:00:30 onwards.
 */
describe('TickPublisher', () => {
  const nightly: WorkerRow = {
    key: 'nightly_job',
    isActive: true,
    schedules: [
      {
        scheduleType: 'cron_expression',
        windowStartAt: null,
        windowEndAt: null,
        cronExpression: '0 3 * * *',
        timezone: 'UTC',
        isActive: true,
      },
    ] as WorkerRow['schedules'],
  };

  afterEach(() => vi.useRealTimers());

  it('re-asks the failed window on the next tick, so a cron inside it still fires once', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-14T02:59:30.000Z') });
    const schedulable = vi
      .fn<() => Promise<WorkerRow[]>>()
      .mockRejectedValueOnce(new Error('connection terminated'))
      .mockResolvedValue([nightly]);
    const publishTick = vi.fn().mockResolvedValue(undefined);
    const publisher = new TickPublisher(
      { schedulable } as unknown as WorkerRegistryService,
      { publishTick } as unknown as BrokerService,
      {} as SchedulerRegistry,
      {} as ConfigService,
    );

    vi.setSystemTime(new Date('2026-10-14T03:00:30.000Z'));
    await publisher.tick(); // 02:59:30 -> 03:00:30, the read fails
    vi.setSystemTime(new Date('2026-10-14T03:01:30.000Z'));
    await publisher.tick(); // must ask 02:59:30 -> 03:01:30
    vi.setSystemTime(new Date('2026-10-14T03:02:30.000Z'));
    await publisher.tick(); // 03:01:30 -> 03:02:30: nothing, and no second 03:00

    expect(publishTick).toHaveBeenCalledTimes(1);
    expect(publishTick).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'nightly_job', at: '2026-10-14T03:01:30.000Z' }),
    );
  });
});
