import { NotFoundException } from '@nestjs/common';
import { WorkerAdminService } from './worker-admin.service';

/**
 * The invariants this item turns on, at the surface that writes them.
 *
 * Before F-031-b a `bot_schedule` row could only be typed into the database by
 * hand, so invariant #2's malformed row was reachable and nobody was told: the
 * tick publisher skipped it and logged a line no admin reads. The write
 * surface is where that stops — a shape that could never run is refused at the
 * moment it is asked for, by the *same* function the publisher uses, so the
 * writer and the runner cannot disagree about what a schedule means.
 *
 * The manual trigger is the other half. "Run now" is allowed to bypass the
 * schedule — that is the whole point of the button — and is not allowed to
 * bypass `isActive`, or invariant #1 stops being the switch an operator can
 * trust to stop a worker that is misbehaving.
 */
describe('WorkerAdminService', () => {
  const WORKER = {
    id: '11111111-1111-1111-1111-111111111111',
    key: 'heartbeat',
    isActive: true,
  };
  const ADMIN = '22222222-2222-2222-2222-222222222222';

  const build = (worker: typeof WORKER | null = WORKER) => {
    const botWorker = {
      findUnique: jest.fn(async () => worker),
      update: jest.fn(async () => ({ ...(worker as typeof WORKER), isActive: false })),
      findMany: jest.fn(async () => []),
    };
    const botSchedule = { create: jest.fn(async (args: unknown) => args) };
    const adminAuditLog = {
      create: jest.fn(async (_args: { data: Record<string, unknown> }) => ({
        id: 'audit-1',
      })),
    };
    const prisma = {
      botWorker,
      botSchedule,
      adminAuditLog,
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
        fn({ botWorker, adminAuditLog }),
      ),
    };
    const publisher = { publishManualTick: jest.fn(async () => undefined) };
    const service = new WorkerAdminService(
      prisma as never,
      publisher as never,
    );
    return { service, prisma, botWorker, botSchedule, adminAuditLog, publisher };
  };

  const window = {
    scheduleType: 'time_window' as const,
    windowStartAt: new Date('2026-09-09T00:00:00.000Z'),
    windowEndAt: new Date('2026-09-16T00:00:00.000Z'),
    cronExpression: null,
    timezone: 'Asia/Tehran',
  };

  describe('setSchedule — invariant #2 at write time', () => {
    it('writes a well-formed window', async () => {
      const { service, botSchedule } = build();

      const result = await service.setSchedule('heartbeat', window, ADMIN);

      expect(result.ok).toBe(true);
      expect(botSchedule.create).toHaveBeenCalled();
    });

    it('refuses a window that also carries a cron expression, and writes nothing', async () => {
      const { service, botSchedule } = build();

      const result = await service.setSchedule(
        'heartbeat',
        { ...window, cronExpression: '*/5 * * * *' },
        ADMIN,
      );

      expect(result.ok).toBe(false);
      expect(botSchedule.create).not.toHaveBeenCalled();
    });

    it('refuses a window that ends before it starts', async () => {
      const { service, botSchedule } = build();

      const result = await service.setSchedule(
        'heartbeat',
        { ...window, windowEndAt: new Date('2026-09-01T00:00:00.000Z') },
        ADMIN,
      );

      expect(result.ok).toBe(false);
      expect(botSchedule.create).not.toHaveBeenCalled();
    });

    it('refuses a cron expression that is not one', async () => {
      const { service, botSchedule } = build();

      const result = await service.setSchedule(
        'heartbeat',
        {
          scheduleType: 'cron_expression',
          windowStartAt: null,
          windowEndAt: null,
          cronExpression: 'every tuesday-ish',
          timezone: 'Asia/Tehran',
        },
        ADMIN,
      );

      expect(result.ok).toBe(false);
      expect(botSchedule.create).not.toHaveBeenCalled();
    });

    it('says which rule the shape broke, rather than only that it failed', async () => {
      const { service } = build();

      const result = await service.setSchedule(
        'heartbeat',
        { ...window, cronExpression: '*/5 * * * *' },
        ADMIN,
      );

      expect(result.ok).toBe(false);
      expect((result as { error: { reason: string } }).error.reason).toMatch(/cron/);
    });

    it('refuses a key no worker has registered', async () => {
      const { service } = build(null);

      await expect(
        service.setSchedule('not-a-worker', window, ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('runNow — invariant #1 survives a manual trigger', () => {
    it('publishes an admin_manual tick for an active worker', async () => {
      const { service, publisher } = build();

      const result = await service.runNow('heartbeat');

      expect(result.ok).toBe(true);
      expect(publisher.publishManualTick).toHaveBeenCalledWith('heartbeat');
    });

    it('publishes nothing for a worker an admin switched off', async () => {
      const { service, publisher } = build({ ...WORKER, isActive: false });

      const result = await service.runNow('heartbeat');

      expect(result.ok).toBe(false);
      expect(publisher.publishManualTick).not.toHaveBeenCalled();
    });
  });

  describe('toggle — the switch leaves a trail', () => {
    it('writes the audit row in the same transaction as the flip', async () => {
      const { service, botWorker, adminAuditLog } = build();

      await service.toggle('heartbeat', false, ADMIN, '10.0.0.1');

      expect(botWorker.update).toHaveBeenCalled();
      const audit = adminAuditLog.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(audit.data).toMatchObject({
        adminId: ADMIN,
        action: 'bot_toggle',
        targetEntityType: 'bot_worker',
        targetEntityId: WORKER.id,
        oldValue: { isActive: true },
        newValue: { isActive: false },
        adminIpAddress: '10.0.0.1',
      });
    });
  });
});
