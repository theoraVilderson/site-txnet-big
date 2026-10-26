/**
 * Acknowledging an event that needs a decision, not only a resume (F-027-fa,
 * ADR-0130 decisions 2 and 4). What would break silently here:
 *
 *  - **an `identity_lost` resumed without saying what the server is.** `rebuilt`
 *    clears the anchor, so the next pass plants a new one and the convergence
 *    recreates every config; `address_fixed` keeps it, so the next pass checks
 *    it again. Neither is a guess this service makes;
 *  - **a moved address trusted silently.** Acknowledging `address_moved` writes
 *    the addresses the collector saw as the known ones and sends the panel back
 *    to the connection test, in the same transaction as the acknowledgement;
 *  - **a choice on an event it means nothing for** — refused, never ignored.
 */
import { PanelOwnershipType, PanelReviewState, TenantType } from '@prisma/client';

import { SystemsReadService } from './systems-read';

const OWNER = '11111111-1111-4111-8111-111111111111';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const PANEL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOST = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MOVED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const RESET = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

type Row = Record<string, unknown>;

function harness() {
  const panel: Row = {
    id: PANEL, ownershipType: PanelOwnershipType.platform, tenantId: null, retiredAt: null,
    reviewState: PanelReviewState.accepted, connectionTestedAt: new Date('2026-10-01T00:00:00Z'),
    anchorTag: 'anchor-1', anchorUuid: 'u-1', anchorRemoteId: '7', knownAddresses: ['203.0.113.1'],
  };
  const event = (id: string, eventType: string, extra: Row = {}): Row => ({
    id, panelId: PANEL, eventType, affectedConfigCount: 0, observedConfigCount: 0, detectedAt: new Date('2026-10-15T00:00:00Z'),
    collectionHalted: true, acknowledgedAt: null, acknowledgedByAdminId: null, note: null,
    knownAddresses: null, seenAddresses: null, ...extra,
  });
  const events = [
    event(LOST, 'identity_lost'),
    event(MOVED, 'address_moved', { knownAddresses: ['203.0.113.1'], seenAddresses: ['198.51.100.7'] }),
    event(RESET, 'mass_reset'),
  ];
  const byId = (where: Row) => events.filter((e) => e['id'] === where['id'] && (!('acknowledgedAt' in where) || e['acknowledgedAt'] === null));
  const prisma = {
    tenant: { findUnique: async () => ({ tenantType: TenantType.platform_owner }) },
    panelDriftEvent: { findFirst: async ({ where }: { where: Row }) => byId(where)[0] ?? null },
  };
  const tx = {
    panelDriftEvent: {
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = byId(where);
        hit.forEach((e) => Object.assign(e, data));
        return { count: hit.length };
      },
    },
    panel: {
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        if (where['id'] !== PANEL) return { count: 0 };
        Object.assign(panel, data);
        return { count: 1 };
      },
    },
  };
  // The event is read on the cross-tenant pool, the panel's scope in its where (BYO-1-b).
  const all = { panelDriftEvent: prisma.panelDriftEvent, $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx) };
  return { service: new SystemsReadService(prisma as never, all as never), panel, events };
}

const owner = { adminId: ADMIN, tenantId: OWNER };

describe('acknowledging a drift event with a decision (F-027-fa)', () => {
  it('rebuilt: clears the anchor so the next pass plants a new one', async () => {
    const { service, panel } = harness();
    await service.acknowledge(owner, LOST, { resolution: 'rebuilt' });

    expect(panel).toMatchObject({ anchorTag: null, anchorUuid: null, anchorRemoteId: null, reviewState: PanelReviewState.accepted });
  });

  it('address_fixed: keeps the anchor, to be checked again', async () => {
    const { service, panel, events } = harness();
    await service.acknowledge(owner, LOST, { resolution: 'address_fixed' });

    expect(panel).toMatchObject({ anchorTag: 'anchor-1', anchorUuid: 'u-1' });
    expect(events[0]).toMatchObject({ acknowledgedByAdminId: ADMIN });
  });

  it('identity_lost without a choice is refused, and nothing is written', async () => {
    const { service, events } = harness();
    await expect(service.acknowledge(owner, LOST, {})).rejects.toMatchObject({ reason: 'resolution_required' });
    expect(events[0]).toMatchObject({ acknowledgedAt: null });
  });

  it('address_moved: trusts the addresses it saw and sends the panel back to the test', async () => {
    const { service, panel } = harness();
    await service.acknowledge(owner, MOVED, {});

    expect(panel).toMatchObject({
      knownAddresses: ['198.51.100.7'], reviewState: PanelReviewState.pending,
      connectionTestedAt: null, connectionTestFault: null, duplicateOfPanelId: null,
    });
  });

  it('a choice on an event it means nothing for is refused', async () => {
    const { service, events } = harness();
    await expect(service.acknowledge(owner, RESET, { resolution: 'rebuilt' })).rejects.toMatchObject({ reason: 'resolution_not_for_event' });
    await expect(service.acknowledge(owner, MOVED, { resolution: 'address_fixed' })).rejects.toMatchObject({ reason: 'resolution_not_for_event' });
    expect(events.every((e) => e['acknowledgedAt'] === null)).toBe(true);
  });

  it('a decided event is not decided again, and its panel is not written twice', async () => {
    const { service, panel } = harness();
    await service.acknowledge(owner, MOVED, {});
    panel['reviewState'] = PanelReviewState.accepted; // the re-test answered

    await expect(service.acknowledge(owner, MOVED, {})).rejects.toMatchObject({ reason: 'already_acknowledged' });
    expect(panel['reviewState']).toBe(PanelReviewState.accepted);
  });
});
