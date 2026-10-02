import type { PrismaService } from '../prisma/prisma.service';
import { budgetVerdict, chargedTimes } from './attention-budget';
import { AttentionBudget } from './attention-budget.service';

/**
 * F-1501 / ADR-0109 point 10: a subject hears from the engine at most 3 times
 * in any rolling 7 days and once in any 24 h. The budget is the last line
 * before a message; everything before it (threshold, cooldown, holdout) may be
 * wrong and this still caps the noise.
 *
 * The failures worth a spec: a window counted by calendar day (two messages
 * at 23:59 and 00:01), a refused message that is charged anyway (the budget
 * drains without anyone hearing a thing), and a charged list that grows
 * forever.
 */

const T0 = new Date('2026-10-02T12:00:00Z');
const at = (hours: number) => new Date(T0.getTime() + hours * 3_600_000);

describe('the attention budget rule (F-1501)', () => {
  it('allows the first message to a subject never charged', () => {
    expect(budgetVerdict([], T0)).toEqual({ allowed: true });
  });

  it('refuses a second message inside 24 h, rolling — not by calendar day', () => {
    const last = new Date('2026-10-02T23:59:00Z');
    const verdict = budgetVerdict([last], new Date('2026-10-03T00:01:00Z'));
    expect(verdict).toEqual({ allowed: false, limit: 'per_day', retryAt: new Date('2026-10-03T23:59:00Z') });
  });

  it('allows the next one once 24 h have passed', () => {
    expect(budgetVerdict([T0], at(24))).toEqual({ allowed: true });
  });

  it('refuses a fourth message inside 7 days and says when the oldest drops out', () => {
    const verdict = budgetVerdict([at(-140), at(-100), at(-30)], T0);
    expect(verdict).toEqual({ allowed: false, limit: 'per_week', retryAt: at(-140 + 168) });
  });

  it('forgets a charge exactly 7 days old', () => {
    expect(budgetVerdict([at(-168), at(-100), at(-30)], T0)).toEqual({ allowed: true });
  });

  it('keeps only the last 7 days of charges, plus the new one, oldest first', () => {
    expect(chargedTimes([at(-30), at(-200), at(-100)], T0)).toEqual([at(-100), at(-30), T0]);
  });
});

/** A writer whose one transaction holds `row` as the stored `chargedAt`. */
function fakeWriter(row: Date[] | null) {
  const writes: Date[][] = [];
  const tx = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('UPDATE engagement.attention_budget')) writes.push(values.find(Array.isArray) as Date[]);
      return 1;
    }),
    $queryRaw: vi.fn(async (_sql: TemplateStringsArray, ..._values: unknown[]) => [{ chargedAt: row ?? [] }]),
  };
  const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  return { budget: new AttentionBudget(prisma as unknown as PrismaService), writes, tx };
}

const subject = { tenantId: '00000000-0000-4000-8000-000000000001', kind: 'user' as const, id: '00000000-0000-4000-8000-000000000002' };

describe('AttentionBudget.spend (F-1501)', () => {
  it('charges the subject when the budget allows, and says so', async () => {
    const { budget, writes } = fakeWriter([at(-30)]);
    await expect(budget.spend(subject, T0)).resolves.toEqual({ allowed: true, charged: true });
    expect(writes).toEqual([[at(-30), T0]]);
  });

  it('writes nothing when it refuses — a refused message costs nothing', async () => {
    const { budget, writes } = fakeWriter([at(-2)]);
    await expect(budget.spend(subject, T0)).resolves.toMatchObject({ allowed: false, charged: false, limit: 'per_day' });
    expect(writes).toEqual([]);
  });

  it('locks the subject row before reading it, so two decisions cannot spend the same slot', async () => {
    const { budget, tx } = fakeWriter(null);
    await budget.spend(subject, T0);
    const read = (tx.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(read).toMatch(/FOR UPDATE/);
  });
});
