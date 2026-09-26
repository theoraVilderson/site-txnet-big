/**
 * Editing a panel's settings (F-027-by). What would break silently:
 *
 *  - **an address changed under an old verdict.** The connection test answered
 *    for the server it reached; a new API or link address may be another
 *    server, so the panel goes back to `pending` with its last test cleared,
 *    and collection (which reads only an accepted panel) waits for the new one;
 *  - **a harmless edit that stops billing.** A name, region, IP or budget
 *    change touches no verdict — an accepted panel stays accepted;
 *  - **a field the transport has no use for.** A push panel has no API and
 *    no link address, and it cannot lose the IP its NAS is allowlisted by;
 *  - **whose panel.** The scope is the owner's, as on every systems route;
 *  - **a `.ovpn` every buyer downloads** (F-307-d). Only a User Manager router
 *    has one, it changes no verdict, and it may carry no private key: the
 *    same file goes to every buyer on that router.
 */
import { DriverType, PanelReviewState, PanelTransport, TenantType } from '@prisma/client';

import { PanelLifecycleService } from './panel-lifecycle';
import { updatePanelSchema } from './panel-registration.schema';
import { PanelScopeRefused } from './panel-scope';
import { SystemsRefused } from './systems-read';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const PANEL = '55555555-5555-4555-8555-555555555555';
const TESTED = new Date('2026-09-24T09:00:00.000Z');
const PROFILE = 'client\ndev tun\nproto tcp-client\nremote vpn.arianet.example 1194\nauth-user-pass\n<ca>\n-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----\n</ca>\n';

type Row = Record<string, unknown>;

function harness(row: Row = {}) {
  const panel: Row = {
    id: PANEL,
    ownershipType: 'platform',
    tenantId: null,
    transport: PanelTransport.pull,
    driverType: DriverType.sanaee,
    name: 'de-fra-1',
    region: 'de',
    apiBaseUrl: 'https://fra.example.com:2053/panel',
    clientBaseUrl: null,
    ipAddress: null,
    maxRequestsPerMinute: 60,
    reviewState: PanelReviewState.accepted,
    connectionTestedAt: TESTED,
    connectionTestFault: null,
    connectionTestDetail: null,
    retiredAt: null,
    ...row,
  };
  const inScope = (where: Row) => panel['id'] === where['id'] && panel['ownershipType'] === where['ownershipType'] && panel['tenantId'] === where['tenantId'];
  const prisma = {
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === OWNER ? { tenantType: TenantType.platform_owner } : { tenantType: TenantType.reseller },
    },
    panel: {
      findFirst: async ({ where }: { where: Row }) => (inScope(where) ? { ...panel } : null),
    },
  };
  const all = {
    // No other panel holds the address (F-027-cd).
    $queryRaw: async () => [],
    panel: {
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        if (!inScope(where) || (where['retiredAt'] === null && panel['retiredAt'] !== null)) return { count: 0 };
        Object.assign(panel, data);
        return { count: 1 };
      },
    },
  };
  const service = new PanelLifecycleService(prisma as never, all as never);
  return { service, panel, actor: { adminId: ADMIN, tenantId: OWNER } };
}

describe('PanelLifecycleService.update (F-027-by)', () => {
  it('a changed API address sends an accepted panel back to pending, its last test cleared', async () => {
    const { service, panel, actor } = harness();
    const answer = await service.update(actor, PANEL, { apiBaseUrl: 'https://fra2.example.com:2053/panel' });
    expect(answer).toEqual({ id: PANEL, reviewState: PanelReviewState.pending, retest: true });
    expect(panel).toMatchObject({
      apiBaseUrl: 'https://fra2.example.com:2053/panel',
      reviewState: PanelReviewState.pending,
      connectionTestedAt: null,
      connectionTestFault: null,
      connectionTestDetail: null,
    });
  });

  it('a changed link address is re-tested too; a refused panel gets its new server tested', async () => {
    const { service, panel, actor } = harness({ reviewState: PanelReviewState.refused });
    const answer = await service.update(actor, PANEL, { clientBaseUrl: 'https://sub.example.com/proxy' });
    expect(answer.retest).toBe(true);
    expect(panel['reviewState']).toBe(PanelReviewState.pending);
  });

  it('a name, region or budget change leaves the verdict alone', async () => {
    const { service, panel, actor } = harness();
    const answer = await service.update(actor, PANEL, { name: 'de-fra-main', region: 'eu', maxRequestsPerMinute: 30 });
    expect(answer).toEqual({ id: PANEL, reviewState: PanelReviewState.accepted, retest: false });
    expect(panel).toMatchObject({ name: 'de-fra-main', region: 'eu', maxRequestsPerMinute: 30, connectionTestedAt: TESTED });
  });

  it('the same address sent again is not a change', async () => {
    const { service, panel, actor } = harness();
    const answer = await service.update(actor, PANEL, { apiBaseUrl: 'https://fra.example.com:2053/panel', name: 'x' });
    expect(answer.retest).toBe(false);
    expect(panel['reviewState']).toBe(PanelReviewState.accepted);
  });

  it('a push panel takes a new IP without a re-test, and refuses an API or link address or losing its IP', async () => {
    const { service, panel, actor } = harness({ transport: PanelTransport.push, apiBaseUrl: null, ipAddress: '10.0.0.1' });
    expect(await service.update(actor, PANEL, { ipAddress: '10.0.0.2' })).toEqual({ id: PANEL, reviewState: PanelReviewState.accepted, retest: false });
    expect(panel['ipAddress']).toBe('10.0.0.2');
    await expect(service.update(actor, PANEL, { apiBaseUrl: 'https://x.example.com' })).rejects.toEqual(new SystemsRefused('not_for_transport'));
    await expect(service.update(actor, PANEL, { clientBaseUrl: 'https://x.example.com' })).rejects.toEqual(new SystemsRefused('not_for_transport'));
    await expect(service.update(actor, PANEL, { ipAddress: null })).rejects.toEqual(new SystemsRefused('not_for_transport'));
  });

  it('a User Manager router takes its .ovpn without a re-test, and null clears it', async () => {
    const { service, panel, actor } = harness({ transport: PanelTransport.push, driverType: DriverType.mikrotik_user_manager, apiBaseUrl: null, ipAddress: '10.0.0.1' });
    expect(await service.update(actor, PANEL, { ovpnProfile: PROFILE })).toEqual({ id: PANEL, reviewState: PanelReviewState.accepted, retest: false });
    expect(panel['ovpnProfile']).toBe(PROFILE);
    await service.update(actor, PANEL, { ovpnProfile: null });
    expect(panel['ovpnProfile']).toBeNull();
  });

  it('refuses a .ovpn on any other family: none of them logs a user in with it', async () => {
    const { service, panel, actor } = harness();
    await expect(service.update(actor, PANEL, { ovpnProfile: PROFILE })).rejects.toEqual(new SystemsRefused('not_for_driver'));
    expect(panel['ovpnProfile']).toBeUndefined();
  });

  it('refuses a reseller before reading, and a panel outside the scope is not found', async () => {
    const { service } = harness({ tenantId: RESELLER, ownershipType: 'tenant' });
    await expect(service.update({ adminId: ADMIN, tenantId: RESELLER }, PANEL, { name: 'x' })).rejects.toBeInstanceOf(PanelScopeRefused);
    await expect(service.update({ adminId: ADMIN, tenantId: OWNER }, PANEL, { name: 'x' })).rejects.toEqual(new SystemsRefused('not_found'));
  });
});

describe('updatePanelSchema', () => {
  it('takes any settings field, at least one, and refuses what is someone else to write', () => {
    expect(updatePanelSchema.safeParse({ name: 'a' }).success).toBe(true);
    expect(updatePanelSchema.safeParse({ clientBaseUrl: null }).success).toBe(true);
    expect(updatePanelSchema.safeParse({}).success).toBe(false);
    expect(updatePanelSchema.safeParse({ reviewState: 'accepted' }).success).toBe(false);
    expect(updatePanelSchema.safeParse({ transport: 'push' }).success).toBe(false);
    expect(updatePanelSchema.safeParse({ apiBaseUrl: null }).success).toBe(false);
    expect(updatePanelSchema.safeParse({ maxRequestsPerMinute: 0 }).success).toBe(false);
  });

  it('takes a .ovpn that names a server and asks for a login, and refuses one carrying a private key', () => {
    expect(updatePanelSchema.safeParse({ ovpnProfile: PROFILE }).success).toBe(true);
    expect(updatePanelSchema.safeParse({ ovpnProfile: null }).success).toBe(true);
    expect(updatePanelSchema.safeParse({ ovpnProfile: 'client\nauth-user-pass\n' }).success).toBe(false);
    expect(updatePanelSchema.safeParse({ ovpnProfile: 'client\nremote vpn.example 1194\n' }).success).toBe(false);
    const withKey = `${PROFILE}<key>\n-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n</key>\n`;
    expect(updatePanelSchema.safeParse({ ovpnProfile: withKey }).success).toBe(false);
    expect(updatePanelSchema.safeParse({ ovpnProfile: 'x'.repeat(65537) }).success).toBe(false);
  });
});
