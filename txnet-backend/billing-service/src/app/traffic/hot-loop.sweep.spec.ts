/**
 * The hot loop's sweep (F-027-cn, ADR-0092 amendment).
 *
 * What breaks without anyone seeing it:
 *  - **a cut-off config nobody calls for.** The delta stream is the hot loop's
 *    only caller, and a config the panel cut off at its share sends no deltas.
 *    With its Grant's other configs idle, nothing moves the bag: grant
 *    0c8034ad sat at 780/512 MiB with 255 MiB unspent (dev, 2026-09-26);
 *  - **a sweep outside the Grant's tenant.** Every table `topUp` writes has
 *    an RLS policy, so on the application pool it would find no Grant;
 *  - **one Grant stopping the sweep.** A failure is that Grant's; the next
 *    tick names it again;
 *  - **a scan that names every Grant.** It must name only the ones with bytes
 *    left and a config served up to its own share, so a second call is empty.
 */
import { TenantContext, WalletVersionConflict } from '@txnet-backend/shared-core';

import { HotLoopSweepService } from './hot-loop.sweep';

type Due = { id: string; tenantId: string };

function sweep(due: Due[], outcome: (grantId: string) => { rebalanced: object | null; bought: object | null } | Error = () => ({ rebalanced: {}, bought: null })) {
  const calls: { grantId: string; tenant: string | undefined }[] = [];
  const queries: string[] = [];
  const crossTenant = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      queries.push(strings.join('?'));
      return due;
    },
  };
  const hot = {
    topUp: async ({ grantId }: { grantId: string }) => {
      calls.push({ grantId, tenant: TenantContext.currentOrNull()?.id });
      const result = outcome(grantId);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  const service = new HotLoopSweepService(crossTenant as never, hot as never);
  return { service, calls, queries };
}

describe('HotLoopSweepService.sweepDue', () => {
  it('tops up each due Grant once, under its own tenant', async () => {
    const { service, calls } = sweep([
      { id: 'grant-a', tenantId: 'tenant-a' },
      { id: 'grant-b', tenantId: 'tenant-b' },
    ]);

    const result = await service.sweepDue();

    expect(calls).toEqual([
      { grantId: 'grant-a', tenant: 'tenant-a' },
      { grantId: 'grant-b', tenant: 'tenant-b' },
    ]);
    expect(result).toEqual({ scanned: 2, rebalanced: 2, bought: 0, raced: 0, failed: 0 });
  });

  it('counts a split and a purchase apart, and a pass that moved nothing as neither', async () => {
    const outcomes: Record<string, { rebalanced: object | null; bought: object | null }> = {
      split: { rebalanced: {}, bought: null },
      buy: { rebalanced: {}, bought: {} },
      none: { rebalanced: null, bought: null },
    };
    const { service } = sweep(
      Object.keys(outcomes).map((id) => ({ id, tenantId: 't' })),
      (grantId) => outcomes[grantId],
    );

    expect(await service.sweepDue()).toEqual({ scanned: 3, rebalanced: 2, bought: 1, raced: 0, failed: 0 });
  });

  it('keeps going past a failed Grant, and a lost purchase race is not a failure', async () => {
    const { service, calls } = sweep(
      [
        { id: 'boom', tenantId: 't' },
        { id: 'raced', tenantId: 't' },
        { id: 'fine', tenantId: 't' },
      ],
      (grantId) =>
        grantId === 'boom' ? new Error('db down') : grantId === 'raced' ? new WalletVersionConflict('w') : { rebalanced: {}, bought: null },
    );

    const result = await service.sweepDue();

    expect(calls.map((c) => c.grantId)).toEqual(['boom', 'raced', 'fine']);
    expect(result).toEqual({ scanned: 3, rebalanced: 1, bought: 0, raced: 1, failed: 1 });
  });

  it('an idle sweep is one query and no top-up', async () => {
    const { service, calls, queries } = sweep([]);

    expect(await service.sweepDue()).toEqual({ scanned: 0, rebalanced: 0, bought: 0, raced: 0, failed: 0 });
    expect(calls).toEqual([]);
    expect(queries).toHaveLength(1);
  });

  it('names only active Grants with bytes left and a config served up to its own share', async () => {
    const { service, queries } = sweep([]);
    await service.sweepDue();
    const sql = queries[0].replace(/\s+/g, ' ');

    expect(sql).toContain(`g."status" = 'active'`);
    expect(sql).toContain(`NOT g."trafficUnlimited"`);
    expect(sql).toContain(`g."purchasedBytes" > g."consumedBytes"`);
    // served (the cursor's lifetime, up and down) at or past the config's share
    expect(sql).toContain(`s."lifetimeUpBytes" + s."lifetimeDownBytes" >= c."allocatedCeilingBytes"`);
    expect(sql).toContain(`c."status" = 'active'`);
    expect(sql).toContain(`c."desiredEnabled"`);
  });
});
