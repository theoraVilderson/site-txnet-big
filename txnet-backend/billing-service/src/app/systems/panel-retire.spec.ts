/**
 * Deleting a panel (F-027-bz): deleted if it has no history, archived if it
 * has. What would break silently:
 *
 *  - **history lost.** Configs, usage, holds and drift events name the panel;
 *    deleting one that has any would fail on a key or orphan the unkeyed rows
 *    (`usage_hold`, `config_counter_state`). It is archived instead;
 *  - **users cut off.** A panel a group still holds, or with a config still
 *    live, is refused — draining is how configs leave a panel;
 *  - **an archived panel back in service by the side door.** Editing it is
 *    refused; only restoring brings it back, and a restore is re-tested;
 *  - **whose panel.** The owner's scope, as on every systems route;
 *  - **a panel still in a group, deleted in one step** (F-027-eg): with the
 *    owner's choice for its users (`orphans`), every membership is evicted
 *    with it and the panel is marked; the drain sweep archives it once it is
 *    out of every group. Without the choice it is still `panel_in_group`, and
 *    a panel being removed takes no new group.
 */
import { EvictOrphans, Prisma, PanelReviewState, TenantType } from '@prisma/client';

import { PanelLifecycleService } from './panel-lifecycle';
import { SystemsRefused } from './systems-read';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const PANEL = '55555555-5555-4555-8555-555555555555';
const RETIRED = new Date('2026-09-20T09:00:00.000Z');

type Row = Record<string, unknown>;
type State = { inGroup?: boolean; liveConfig?: boolean; history?: boolean; keyedByDelete?: boolean };

function harness(row: Row = {}, state: State = {}) {
  const evicted: Array<{ where: Row; data: Row }> = [];
  let panel: Row | null = {
    id: PANEL,
    ownershipType: 'platform',
    tenantId: null,
    reviewState: PanelReviewState.accepted,
    connectionTestedAt: RETIRED,
    retiredAt: null,
    ...row,
  };
  const inScope = (where: Row) =>
    !!panel && panel['id'] === where['id'] && panel['ownershipType'] === where['ownershipType'] && panel['tenantId'] === where['tenantId'];
  const prisma = {
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === OWNER ? { tenantType: TenantType.platform_owner } : { tenantType: TenantType.reseller },
    },
  };
  const all = {
    panelGroupMember: {
      findFirst: async () => (state.inGroup ? { panelId: PANEL } : null),
      findMany: async () => (state.inGroup ? [{ groupId: 'g-1' }, { groupId: 'g-2' }] : []),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        evicted.push({ where, data });
        return { count: state.inGroup ? 2 : 0 };
      },
    },
    config: { findFirst: async () => (state.liveConfig ? { id: 'c1' } : null) },
    // hasHistory's one EXISTS query.
    $queryRaw: async () => [{ history: !!state.history }],
    // The archive: conditional on in scope, not archived, no member, no live config.
    $executeRaw: async () => {
      if (!panel || panel['retiredAt'] !== null || state.inGroup || state.liveConfig) return 0;
      panel['retiredAt'] = new Date();
      return 1;
    },
    // Panels are read on the cross-tenant pool, the scope in the where (BYO-1-b).
    panel: {
      findFirst: async ({ where }: { where: Row }) => (inScope(where) ? { ...panel } : null),
      deleteMany: async ({ where }: { where: Row }) => {
        if (state.keyedByDelete) throw new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: 'test' });
        if (!inScope(where)) return { count: 0 };
        panel = null;
        return { count: 1 };
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        if (!inScope(where)) return { count: 0 };
        const retired = panel!['retiredAt'] !== null;
        if (where['retiredAt'] === null && retired) return { count: 0 };
        if (where['retiredAt'] && !retired) return { count: 0 };
        Object.assign(panel!, data);
        return { count: 1 };
      },
    },
  };
  const service = new PanelLifecycleService(prisma as never, all as never);
  return { service, evicted, get panel() { return panel; }, actor: { adminId: ADMIN, tenantId: OWNER } };
}

describe('PanelLifecycleService.remove (F-027-bz)', () => {
  it('a panel with no history is deleted', async () => {
    const h = harness();
    expect(await h.service.remove(h.actor, PANEL)).toEqual({ id: PANEL, outcome: 'deleted' });
    expect(h.panel).toBeNull();
  });

  it('a panel with history is archived, and stays for its records', async () => {
    const h = harness({}, { history: true });
    expect(await h.service.remove(h.actor, PANEL)).toEqual({ id: PANEL, outcome: 'archived' });
    expect(h.panel?.['retiredAt']).toBeInstanceOf(Date);
  });

  it('a key the history check did not see still archives instead of failing', async () => {
    const h = harness({}, { keyedByDelete: true });
    expect(await h.service.remove(h.actor, PANEL)).toEqual({ id: PANEL, outcome: 'archived' });
  });

  it('refuses while a group holds it or a config on it is live', async () => {
    const grouped = harness({}, { inGroup: true, history: true });
    await expect(grouped.service.remove(grouped.actor, PANEL)).rejects.toEqual(new SystemsRefused('panel_in_group'));
    const live = harness({}, { liveConfig: true, history: true });
    await expect(live.service.remove(live.actor, PANEL)).rejects.toEqual(new SystemsRefused('panel_has_configs'));
    expect(live.panel?.['retiredAt']).toBeNull();
  });

  it('an archived panel is archived once', async () => {
    const h = harness({ retiredAt: RETIRED });
    await expect(h.service.remove(h.actor, PANEL)).rejects.toEqual(new SystemsRefused('panel_retired'));
  });

  it("removes a reseller's own panel for the reseller (ADR-0166), and is not_found to the owner", async () => {
    const h = harness({ tenantId: RESELLER, ownershipType: 'tenant' });
    await expect(h.service.remove(h.actor, PANEL)).rejects.toEqual(new SystemsRefused('not_found'));
    await expect(h.service.remove({ adminId: ADMIN, tenantId: RESELLER }, PANEL)).resolves.toMatchObject({ id: PANEL });
  });
});

describe('PanelLifecycleService.remove with the users\' fate chosen (F-027-eg)', () => {
  it('a panel in groups is evicted from every one, with the choice, and marked for archiving', async () => {
    const h = harness({}, { inGroup: true, liveConfig: true, history: true });
    expect(await h.service.remove(h.actor, PANEL, EvictOrphans.refund)).toEqual({ id: PANEL, outcome: 'removing', groups: 2 });
    expect(h.evicted).toEqual([
      {
        where: { panelId: PANEL, evictedAt: null },
        data: expect.objectContaining({ role: 'drain', evictOrphans: EvictOrphans.refund, evictedBy: ADMIN, evictedAt: expect.any(Date) }),
      },
    ]);
    expect(h.panel?.['removeRequestedAt']).toBeInstanceOf(Date);
    expect(h.panel?.['retiredAt']).toBeNull();
  });

  it('without the choice a panel in a group is still refused, and nothing is evicted', async () => {
    const h = harness({}, { inGroup: true, history: true });
    await expect(h.service.remove(h.actor, PANEL)).rejects.toEqual(new SystemsRefused('panel_in_group'));
    expect(h.evicted).toEqual([]);
  });

  it('a panel in no group goes as before, whatever was chosen', async () => {
    const h = harness({}, { history: true });
    expect(await h.service.remove(h.actor, PANEL, EvictOrphans.pause)).toEqual({ id: PANEL, outcome: 'archived' });
  });
});

describe('an archived panel', () => {
  it('is not edited', async () => {
    const h = harness({ retiredAt: RETIRED });
    await expect(h.service.update(h.actor, PANEL, { name: 'x' })).rejects.toEqual(new SystemsRefused('panel_retired'));
  });

  it('is restored to pending, re-tested before it serves again', async () => {
    const h = harness({ retiredAt: RETIRED });
    expect(await h.service.restore(h.actor, PANEL)).toEqual({ id: PANEL, reviewState: PanelReviewState.pending });
    expect(h.panel).toMatchObject({ retiredAt: null, reviewState: PanelReviewState.pending, connectionTestedAt: null });
  });

  it('a panel in service is not restored', async () => {
    const h = harness();
    await expect(h.service.restore(h.actor, PANEL)).rejects.toEqual(new SystemsRefused('panel_not_retired'));
  });
});
