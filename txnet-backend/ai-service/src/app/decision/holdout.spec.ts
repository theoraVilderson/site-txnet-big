import type { PrismaService } from '../prisma/prisma.service';
import { holdoutBucket, Holdouts } from './holdout';

/**
 * F-1508 / ADR-0109 points 8, 10: a permanent control group per tenant that
 * hears nothing from the engine — 10% by default, 5–20%, never 0 — chosen by
 * a hash of the subject id, so the same account lands on the same side every
 * run and the uplift report (F-038-i) reads the set the pipeline used.
 *
 * The failures worth a spec: a member drawn differently on the next run, a
 * share that drifts from the setting, a member released when the tenant
 * lowers the share (its history would then poison the comparison), and a
 * member not recorded for the report.
 */

const TENANT = '00000000-0000-4000-8000-000000000001';
const ids = Array.from({ length: 4000 }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`);

function fake(recorded: unknown = null) {
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    aiHoldout: { findUnique: vi.fn(async () => recorded), createMany: vi.fn(async () => ({ count: 1 })) },
  };
  const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  return { holdouts: new Holdouts(prisma as unknown as PrismaService), tx };
}

const subjectIn = (percent: number) => ids.find((id) => holdoutBucket(id) < percent)!;
const subjectOut = (percent: number) => ids.find((id) => holdoutBucket(id) >= percent)!;

describe('holdoutBucket (F-1508)', () => {
  it('is stable: the same subject always lands in the same bucket', () => {
    expect(ids.slice(0, 50).map(holdoutBucket)).toEqual(ids.slice(0, 50).map(holdoutBucket));
  });

  it('spreads subjects evenly over 0–99, so a share of buckets is that share of accounts', () => {
    const share = ids.filter((id) => holdoutBucket(id) < 10).length / ids.length;
    expect(share).toBeGreaterThan(0.08);
    expect(share).toBeLessThan(0.12);
    expect(ids.every((id) => Number.isInteger(holdoutBucket(id)) && holdoutBucket(id) >= 0 && holdoutBucket(id) < 100)).toBe(true);
  });
});

describe('the holdout step (F-1508)', () => {
  it('passes a subject outside the share', async () => {
    const { holdouts, tx } = fake();
    const id = subjectOut(10);
    await expect(holdouts.verdict({ tenantId: TENANT, kind: 'user', id }, 10)).resolves.toEqual({ pass: true });
    expect(tx.aiHoldout.createMany).not.toHaveBeenCalled();
  });

  it('holds a subject inside the share and records it for the report', async () => {
    const { holdouts, tx } = fake();
    const id = subjectIn(10);
    await expect(holdouts.verdict({ tenantId: TENANT, kind: 'user', id }, 10)).resolves.toEqual({ pass: false, suppressedBy: 'holdout' });
    expect(tx.aiHoldout.createMany).toHaveBeenCalledWith({
      data: [{ tenantId: TENANT, subjectKind: 'user', subjectId: id }],
      skipDuplicates: true,
    });
  });

  it('keeps a recorded member when the tenant lowers the share — the group is permanent', async () => {
    const id = ids.find((x) => holdoutBucket(x) >= 5 && holdoutBucket(x) < 20)!;
    const { holdouts, tx } = fake({ assignedAt: new Date() });
    await expect(holdouts.verdict({ tenantId: TENANT, kind: 'user', id }, 5)).resolves.toEqual({ pass: false, suppressedBy: 'holdout' });
    expect(tx.aiHoldout.createMany).not.toHaveBeenCalled();
  });

  it('never runs with no holdout: a share below 5 is read as 5, above 20 as 20', async () => {
    const id = ids.find((x) => holdoutBucket(x) < 5)!;
    const { holdouts } = fake();
    await expect(holdouts.verdict({ tenantId: TENANT, kind: 'user', id }, 0)).resolves.toEqual({ pass: false, suppressedBy: 'holdout' });
    const above = ids.find((x) => holdoutBucket(x) >= 20 && holdoutBucket(x) < 30)!;
    await expect(holdouts.verdict({ tenantId: TENANT, kind: 'user', id: above }, 30)).resolves.toEqual({ pass: true });
  });

  it('reads only this tenant and this subject', async () => {
    const { holdouts, tx } = fake();
    const id = subjectOut(10);
    await holdouts.verdict({ tenantId: TENANT, kind: 'tenant', id }, 10);
    expect(tx.aiHoldout.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId_subjectKind_subjectId: { tenantId: TENANT, subjectKind: 'tenant', subjectId: id } } }),
    );
  });
});
