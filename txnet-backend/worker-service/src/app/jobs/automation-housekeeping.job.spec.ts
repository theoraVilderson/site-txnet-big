import { ConfigService } from '@nestjs/config';
import { AutomationHousekeepingJob } from './automation-housekeeping.job';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Hosting H14: what this job may delete is the whole of its risk. A published
 * outbox row and a run log past its window are history; an **unpublished**
 * outbox row is an event nobody has heard yet, and deleting it is a silent loss
 * of a payment or a Grant notice. So the SQL it sends is asserted, not just
 * the counts — and the loop is held to its batch size and its deadline, the
 * two things that make the first run on a 400k-row table safe.
 */
describe('AutomationHousekeepingJob', () => {
  const DAY = 86_400_000;
  const NOW = new Date('2026-10-14T02:30:00Z');

  const config = (over: Record<string, unknown> = {}) =>
    ({
      get: <T>(key: string, fallback: T): T => (key in over ? (over[key] as T) : fallback),
      getOrThrow: <T>(key: string): T => (key in over ? over[key] : 10 * 60_000) as T,
    }) as unknown as ConfigService;

  /** A `Prisma.join` list (`{ strings, values }`) flattened, so a status reads as the value it binds. */
  const flat = (v: unknown): unknown[] =>
    typeof v === 'object' && v !== null && 'values' in v && Array.isArray(v.values) ? v.values : [v];

  /** `$executeRaw` answers from `batches` per statement kind; every call is recorded with its values. */
  const prismaWith = (batches: { log?: number[]; outbox?: number[] }, onDelete: () => void = () => undefined) => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const left = { log: [...(batches.log ?? [])], outbox: [...(batches.outbox ?? [])] };
    const $executeRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?').replace(/\s+/g, ' ');
      calls.push({ sql, values: values.flatMap(flat) });
      onDelete();
      return (sql.includes('outbox_event') ? left.outbox : left.log).shift() ?? 0;
    });
    const $queryRaw = vi.fn(async () => [{ left: BigInt(7) }]);
    const botWorker = { findMany: vi.fn(async () => [{ id: 'w1' }]) };
    return { prisma: { $executeRaw, $queryRaw, botWorker } as unknown as PrismaService, calls };
  };

  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());

  it('deletes a published outbox row past its window, and never an unpublished one', async () => {
    const { prisma, calls } = prismaWith({ outbox: [3] });
    await new AutomationHousekeepingJob(prisma, config()).run();

    const outbox = calls.filter((c) => c.sql.includes('outbox_event'));
    expect(outbox).toHaveLength(1);
    expect(outbox[0].sql).toContain('"publishedAt" IS NOT NULL');
    expect(outbox[0].values).toContain(5_000);
    expect(outbox[0].values).toContainEqual(new Date(NOW.getTime() - 7 * DAY));
  });

  it('keeps a success 30 days and a failed or partial run 90, per worker', async () => {
    const { prisma, calls } = prismaWith({});
    await new AutomationHousekeepingJob(prisma, config()).run();

    const log = calls.filter((c) => c.sql.includes('bot_execution_log'));
    expect(log).toHaveLength(2);
    expect(log.every((c) => c.values.includes('w1'))).toBe(true);
    expect(log[0].values).toEqual(expect.arrayContaining(['success', new Date(NOW.getTime() - 30 * DAY)]));
    expect(log[1].values).toEqual(expect.arrayContaining(['failed', 'partial', new Date(NOW.getTime() - 90 * DAY)]));
  });

  it('repeats a batch until one removes fewer than 5,000, and counts every row it removed', async () => {
    const { prisma, calls } = prismaWith({ log: [5_000, 5_000, 1_200, 0], outbox: [5_000, 40] });
    const result = await new AutomationHousekeepingJob(prisma, config()).run();

    expect(calls.filter((c) => c.sql.includes('bot_execution_log'))).toHaveLength(4);
    expect(calls.filter((c) => c.sql.includes('outbox_event'))).toHaveLength(2);
    expect(result.itemsProcessed).toBe(11_200 + 5_040);
    expect(result.errorsCount).toBe(0);
  });

  it('stops before the run timeout closes it and reports what is left', async () => {
    // Every batch is full and takes four minutes: the third would cross the
    // deadline a minute before AUTOMATION_RUN_TIMEOUT_MS (10 min).
    const { prisma, calls } = prismaWith({ log: Array(10).fill(5_000) }, () => vi.advanceTimersByTime(4 * 60_000));
    const result = await new AutomationHousekeepingJob(prisma, config()).run();

    expect(calls).toHaveLength(3);
    expect(result.itemsProcessed).toBe(15_000);
    expect(result.metrics).toMatchObject({ finished: false, left: { executionLog: 7, outbox: 7 } });
  });
});
