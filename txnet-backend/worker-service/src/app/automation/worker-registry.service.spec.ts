import { Job } from './job';
import { WorkerRegistryService } from './worker-registry.service';

/**
 * F-114-a — **a job that has to run is scheduled by the code that runs it**.
 *
 * Until 2026-09-25 a schedule came only from `prisma/seed.js`, which skipped
 * any job worker-service had not registered yet and had been failing on its
 * first line since 2026-09-19; `grant_delivery` was never ticked and a paid
 * Grant stayed `pending` for ever. The registry now writes a job's
 * `defaultSchedule` on boot — once, and never over anything an admin set.
 *
 * Prisma is faked down to the calls the registry makes; the lock is recorded,
 * not taken, so what is asserted is that the check runs under it.
 */
describe('WorkerRegistryService — default schedules', () => {
  type Row = { botWorkerId: string; scheduleType: string; cronExpression: string | null; setByAdminId: null };

  const job = (key: string, defaultSchedule?: Job['defaultSchedule']): Job => ({
    key,
    name: key,
    category: 'other' as Job['category'],
    ...(defaultSchedule ? { defaultSchedule } : {}),
    run: () => Promise.resolve({}),
  });

  function fakePrisma(existing: Record<string, number> = {}) {
    const created: Row[] = [];
    const calls: string[] = [];
    const tx = {
      $executeRaw: () => {
        calls.push('lock');
        return Promise.resolve(1);
      },
      botSchedule: {
        count: ({ where }: { where: { botWorkerId: string } }) => {
          calls.push('count');
          return Promise.resolve(
            (existing[where.botWorkerId] ?? 0) + created.filter((r) => r.botWorkerId === where.botWorkerId).length,
          );
        },
        create: ({ data }: { data: Row }) => {
          created.push(data);
          return Promise.resolve(data);
        },
      },
    };
    const prisma = {
      botWorker: {
        upsert: ({ where }: { where: { key: string } }) => Promise.resolve({ id: `id-${where.key}` }),
      },
      $transaction: <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
    };
    return { prisma, created, calls };
  }

  const boot = async (jobs: Job[], existing?: Record<string, number>) => {
    const fake = fakePrisma(existing);
    await new WorkerRegistryService(fake.prisma as never, jobs).onModuleInit();
    return fake;
  };

  it('writes a job its default schedule when it has none — set by the code, not by an admin', async () => {
    const { created } = await boot([job('grant_delivery', { scheduleType: 'cron_expression', cronExpression: '* * * * *' })]);
    expect(created).toEqual([
      { botWorkerId: 'id-grant_delivery', scheduleType: 'cron_expression', cronExpression: '* * * * *', setByAdminId: null },
    ]);
  });

  it('writes an always_on default with no cron expression', async () => {
    const { created } = await boot([job('outbox_relay', { scheduleType: 'always_on' })]);
    expect(created).toEqual([
      { botWorkerId: 'id-outbox_relay', scheduleType: 'always_on', cronExpression: null, setByAdminId: null },
    ]);
  });

  it('leaves a job alone that already has any schedule, even one an admin switched off', async () => {
    const { created } = await boot(
      [job('grant_delivery', { scheduleType: 'cron_expression', cronExpression: '* * * * *' })],
      { 'id-grant_delivery': 1 },
    );
    expect(created).toEqual([]);
  });

  it('schedules nothing for a job that declares no default — a writing sweep still waits for an operator', async () => {
    const { created, calls } = await boot([job('worker_heartbeat')]);
    expect(created).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('checks under the lock, so two replicas booting together write one row', async () => {
    const { calls } = await boot([job('outbox_relay', { scheduleType: 'always_on' })]);
    expect(calls).toEqual(['lock', 'count']);
  });

  it('a second boot writes nothing new', async () => {
    const jobs = [job('outbox_relay', { scheduleType: 'always_on' })];
    const fake = fakePrisma();
    const registry = new WorkerRegistryService(fake.prisma as never, jobs);
    await registry.onModuleInit();
    await registry.onModuleInit();
    expect(fake.created).toHaveLength(1);
  });
});
