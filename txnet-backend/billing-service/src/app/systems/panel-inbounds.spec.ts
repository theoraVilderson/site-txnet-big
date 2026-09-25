/**
 * A panel's inbounds on the systems surface (F-114-b, network
 * `contract.inbounds.md`). What would break silently:
 *
 *  - **a pick on an inbound nobody can be placed on** — gone from the panel,
 *    or of a protocol we do not sell — would read as sold and place nobody;
 *  - **a pick is the admin's, the read is the panel's**: the body cannot write
 *    `protocol`, `enabled` or `goneAt`, and a field left out keeps its value;
 *  - **the scope**: a reseller's own panel is not reachable, and neither is
 *    the surface for anyone but the platform owner;
 *  - **the figures an admin picks by are fulfilment's**: live configs per
 *    inbound, and distinct Grants on the panel.
 */
import { ConfigProtocol, InboundPlacement, TenantType } from '@prisma/client';

import { PanelInboundsService } from './panel-inbounds';
import { updatePanelInboundsSchema } from './panel-registration.schema';
import { PanelScopeRefused } from './panel-scope';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const PANEL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RESELLER_PANEL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type Row = Record<string, unknown>;

function harness() {
  const panels: Row[] = [
    { id: PANEL, tenantId: null, ownershipType: 'platform', inboundPlacement: InboundPlacement.all, maxClients: null, inboundsReadAt: new Date('2026-09-25T10:00:00Z') },
    { id: RESELLER_PANEL, tenantId: RESELLER, ownershipType: 'tenant', inboundPlacement: InboundPlacement.all, maxClients: null, inboundsReadAt: null },
  ];
  const inbound = (remoteId: string, extra: Row = {}): Row => ({
    panelId: PANEL, remoteId, tag: `in-${remoteId}`, protocol: ConfigProtocol.vless, port: 443, host: '', enabled: true, goneAt: null, seenAt: new Date(), sold: false, maxClients: null, ...extra,
  });
  const inbounds: Row[] = [
    inbound('10'),
    inbound('2', { protocol: ConfigProtocol.trojan, sold: true }),
    inbound('3', { protocol: null }),
    inbound('4', { goneAt: new Date() }),
  ];
  const panelMatch = (p: Row, where: Row) => Object.entries(where).every(([k, v]) => (p[k] ?? null) === v);

  const prisma = {
    tenant: { findUnique: async ({ where }: { where: { id: string } }) => ({ tenantType: where.id === OWNER ? TenantType.platform_owner : TenantType.reseller }) },
  };
  const db = {
    panel: {
      findFirst: async ({ where }: { where: Row }) => panels.find((p) => panelMatch(p, where)) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(panels.find((p) => p.id === where.id)!, data),
    },
    panelInbound: {
      findMany: async ({ where }: { where: { panelId: string; remoteId?: { in: string[] } } }) =>
        inbounds.filter((i) => i.panelId === where.panelId && (!where.remoteId || where.remoteId.in.includes(i.remoteId as string))),
      update: async ({ where, data }: { where: { panelId_remoteId: { panelId: string; remoteId: string } }; data: Row }) =>
        Object.assign(inbounds.find((i) => i.panelId === where.panelId_remoteId.panelId && i.remoteId === where.panelId_remoteId.remoteId)!, data),
    },
    // Two buyers on 10 (one of them also on 2), one on 2: three users.
    $queryRaw: async () => [
      { inboundRemoteId: '10', total: 0, clients: BigInt(2), users: BigInt(2) },
      { inboundRemoteId: '2', total: 0, clients: BigInt(2), users: BigInt(2) },
      { inboundRemoteId: null, total: 1, clients: BigInt(4), users: BigInt(3) },
    ],
  };
  const crossTenant = { ...db, $transaction: async (work: (tx: typeof db) => Promise<unknown>) => work(db) };
  return { service: new PanelInboundsService(prisma as never, crossTenant as never), panels, inbounds };
}

const owner = { adminId: ADMIN, tenantId: OWNER };

describe('PanelInboundsService', () => {
  it('lists the inbounds in the panel\'s id order, each with how full it is, and the panel\'s users', async () => {
    const { service } = harness();
    const view = await service.inbounds(owner, PANEL);

    expect(view.inbounds.map((i) => [i.remoteId, i.sold, i.clients])).toEqual([['2', true, 2], ['3', false, 0], ['4', false, 0], ['10', false, 2]]);
    expect(view).toMatchObject({ panelId: PANEL, inboundPlacement: 'all', maxClients: null, users: 3 });
  });

  it('writes the picks and the placement together, and a field left out keeps its value', async () => {
    const { service, panels, inbounds } = harness();
    await service.update(owner, PANEL, { inboundPlacement: InboundPlacement.spread, maxClients: 40, inbounds: [{ remoteId: '10', sold: true, maxClients: 20 }, { remoteId: '2', sold: false }] });

    expect(panels[0]).toMatchObject({ inboundPlacement: 'spread', maxClients: 40 });
    expect(inbounds.find((i) => i.remoteId === '10')).toMatchObject({ sold: true, maxClients: 20 });
    expect(inbounds.find((i) => i.remoteId === '2')).toMatchObject({ sold: false, maxClients: null });

    await service.update(owner, PANEL, { maxClients: null });
    expect(panels[0]).toMatchObject({ inboundPlacement: 'spread', maxClients: null });
  });

  it('refuses to sell an inbound it does not know, one that is gone, or one of a protocol we do not sell — and writes nothing', async () => {
    const { service, inbounds } = harness();
    await expect(service.update(owner, PANEL, { inbounds: [{ remoteId: '99', sold: true }] })).rejects.toMatchObject({ reason: 'inbound_not_found' });
    for (const remoteId of ['3', '4']) {
      await expect(service.update(owner, PANEL, { inbounds: [{ remoteId: '10', sold: true }, { remoteId, sold: true }] })).rejects.toMatchObject({ reason: 'inbound_not_sellable' });
    }
    expect(inbounds.find((i) => i.remoteId === '10')!.sold).toBe(false);
    // Unselling one is always allowed.
    await service.update(owner, PANEL, { inbounds: [{ remoteId: '4', sold: false }] });
  });

  it('asks for a fresh read by clearing inboundsReadAt', async () => {
    const { service, panels } = harness();
    expect(await service.refresh(owner, PANEL)).toEqual({ panelId: PANEL, refreshRequested: true });
    expect(panels[0].inboundsReadAt).toBeNull();
  });

  it("is the platform owner's, over the platform's panels only", async () => {
    const { service } = harness();
    await expect(service.inbounds({ adminId: ADMIN, tenantId: RESELLER }, PANEL)).rejects.toBeInstanceOf(PanelScopeRefused);
    await expect(service.inbounds(owner, RESELLER_PANEL)).rejects.toMatchObject({ reason: 'panel_not_found' });
  });
});

describe('updatePanelInboundsSchema', () => {
  it('takes a pick, a cap or none, and a placement; refuses the read\'s columns, a zero cap and a twice-named inbound', () => {
    expect(updatePanelInboundsSchema.safeParse({ inboundPlacement: 'spread', maxClients: null, inbounds: [{ remoteId: '1', sold: true, maxClients: 5 }] }).success).toBe(true);
    for (const body of [
      {},
      { inbounds: [{ remoteId: '1', sold: true, protocol: 'vless' }] },
      { maxClients: 0 },
      { inboundPlacement: 'first' },
      { inbounds: [{ remoteId: '1', sold: true }, { remoteId: '1', sold: false }] },
    ]) {
      expect(updatePanelInboundsSchema.safeParse(body).success).toBe(false);
    }
  });
});
