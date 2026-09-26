/**
 * The hot loop's caller (F-027-cl, ADR-0092).
 *
 * What breaks without anyone seeing it:
 *  - **nothing calls `topUpIn`.** The money half of the hot loop was built and
 *    never run: a busy config reached its share and the panel cut it off with
 *    half the bag untouched on an idle one (panel 5922ac13, 2026-09-26);
 *  - **one top-up per delta.** A pass carries a delta per config, and two
 *    configs of one Grant would buy two blocks for one horizon;
 *  - **a top-up outside the Grant's tenant.** Every table it writes carries an
 *    RLS policy, so on the application pool it would find no Grant at all;
 *  - **a lost race dead-lettered.** Two passes buying for one Grant is routine
 *    — the loser's `WalletVersionConflict` means the other one bought.
 */
import { WalletVersionConflict, TenantContext, USAGE_DELTA_MESSAGE_VERSION, type UsageDeltaMessage } from '@txnet-backend/shared-core';

import { HotLoopConsumer } from './hot-loop.consumer';

const PANEL = '11111111-1111-4111-8111-111111111111';
const at = '2026-09-26T10:00:00Z';

const delta = (configId: string) => ({
  deltaId: `d-${configId}`,
  configId,
  remoteId: `r-${configId}`,
  protocol: 'vless',
  upBytes: '10',
  downBytes: '20',
  observedAt: at,
  sessionId: '',
  afterReset: false,
});

const pass = (configIds: string[], extra: Partial<UsageDeltaMessage> = {}): UsageDeltaMessage =>
  ({
    version: USAGE_DELTA_MESSAGE_VERSION,
    panelId: PANEL,
    ownershipType: 'platform',
    tenantId: null,
    observedAt: at,
    chunk: 1,
    chunks: 1,
    deltas: configIds.map(delta),
    quarantines: [],
    unattributed: [],
    ...extra,
  }) as UsageDeltaMessage;

/** Config id -> its Grant and tenant, as the cross-tenant read answers it. */
const CONFIGS: Record<string, { grantId: string; tenantId: string }> = {
  a1: { grantId: 'grant-a', tenantId: 'tenant-a' },
  a2: { grantId: 'grant-a', tenantId: 'tenant-a' },
  b1: { grantId: 'grant-b', tenantId: 'tenant-b' },
};

function consumer(fail: Record<string, Error> = {}) {
  const calls: { grantId: string; tenant: string | undefined }[] = [];
  const lookups: string[][] = [];
  const crossTenant = {
    config: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        lookups.push(where.id.in);
        return where.id.in.filter((id) => CONFIGS[id]).map((id) => ({ id, ...CONFIGS[id] }));
      },
    },
  };
  const hot = {
    topUp: async ({ grantId }: { grantId: string }) => {
      calls.push({ grantId, tenant: TenantContext.currentOrNull()?.id });
      const error = fail[grantId];
      if (error) throw error;
      return { grantId, hot: false, bought: null, rebalanced: null };
    },
  };
  return { consumer: new HotLoopConsumer(crossTenant as never, hot as never), calls, lookups };
}

describe('HotLoopConsumer.handle', () => {
  it('tops up each Grant a pass touched once, however many of its configs it carried', async () => {
    const { consumer: c, calls } = consumer();

    const outcome = await c.handle(pass(['a1', 'a2', 'b1']));

    expect(calls.map((call) => call.grantId).sort()).toEqual(['grant-a', 'grant-b']);
    expect(outcome).toEqual({ grants: 2, failed: 0, raced: 0 });
  });

  it("runs each top-up under its Grant's own tenant, not the panel's", async () => {
    const { consumer: c, calls } = consumer();

    await c.handle(pass(['a1', 'b1'], { ownershipType: 'tenant', tenantId: '99999999-9999-4999-8999-999999999999' } as Partial<UsageDeltaMessage>));

    expect(calls).toEqual(
      expect.arrayContaining([
        { grantId: 'grant-a', tenant: 'tenant-a' },
        { grantId: 'grant-b', tenant: 'tenant-b' },
      ]),
    );
  });

  it('asks nothing for a pass with no deltas, and skips a config this platform does not hold', async () => {
    const { consumer: c, calls, lookups } = consumer();

    await c.handle(pass([]));
    expect(lookups).toHaveLength(0);

    await c.handle(pass(['gone', 'b1']));
    expect(calls.map((call) => call.grantId)).toEqual(['grant-b']);
  });

  it('reads a lost purchase race as the other pass having bought, not as a failure', async () => {
    const { consumer: c } = consumer({ 'grant-a': new WalletVersionConflict('u') });

    await expect(c.handle(pass(['a1', 'b1']))).resolves.toEqual({ grants: 2, failed: 0, raced: 1 });
  });

  it('tops up the other Grants when one fails, then fails the pass so it dead-letters as evidence', async () => {
    const { consumer: c, calls } = consumer({ 'grant-a': new Error('boom') });

    await expect(c.handle(pass(['a1', 'b1']))).rejects.toThrow(/grant-a/);
    expect(calls.map((call) => call.grantId).sort()).toEqual(['grant-a', 'grant-b']);
  });

  it('refuses a message version it was not written against', async () => {
    const { consumer: c, calls } = consumer();

    await expect(c.handle(pass(['a1'], { version: USAGE_DELTA_MESSAGE_VERSION + 1 }))).rejects.toThrow(/version/);
    expect(calls).toHaveLength(0);
  });
});
