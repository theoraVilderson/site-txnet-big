import { PERMISSION_REGISTRY } from '../http/permission-registry.generated';
import { ResellerAccess } from './reseller-access';
import { RESELLER_KEYS } from './reseller-keys';

/**
 * The invariant AC-1-e turns on (catalog §3.2): a reseller's own staff member
 * is admitted to a route by **that route's key**, never by one broad key.
 *
 * Before it, the member door asked every route for `tenant.manage`, a key no
 * tenant-made role may hold, so a reseller's role was "everything" (the owner)
 * or "nothing" (everyone else). Now:
 *
 * - a door names its keys (`for(...)`), and a member holding one of them is
 *   admitted, holding another is not;
 * - the bare door names none, so it admits no member at all, `*` included —
 *   an owner-only route says so by not naming a key;
 * - the owner and the platform's staff are unaffected: the key is the member's
 *   door only;
 * - every member-door key is in the registry and grantable by a tenant
 *   (`platformOnly: false`), or a reseller could never give it to anyone.
 */
describe('ResellerAccess keys (AC-1-e)', () => {
  const PLATFORM = '11111111-1111-1111-1111-111111111111';
  const RESELLER = '22222222-2222-2222-2222-222222222222';
  const OWNER = '44444444-4444-4444-4444-444444444444';
  const STAFF = '55555555-5555-5555-5555-555555555555';
  const MEMBER = '66666666-6666-6666-6666-666666666666';
  const T0 = new Date('2026-10-09T10:00:00Z');

  const owner = { userId: OWNER, tenantId: PLATFORM, permissions: [] as string[] };
  const staff = { userId: STAFF, tenantId: PLATFORM, permissions: ['platform.tenant.manage'] };
  const member = (...permissions: string[]) => ({ userId: MEMBER, tenantId: RESELLER, permissions });

  const access = () => {
    const tenants: Record<string, Record<string, unknown>> = {
      [PLATFORM]: { id: PLATFORM, tenantType: 'platform_owner', slug: 'platform_owner', ownerUserId: STAFF, status: 'active' },
      [RESELLER]: { id: RESELLER, tenantType: 'reseller', slug: 'ali', ownerUserId: OWNER, status: 'active', graceEndsAt: null },
    };
    const prisma = {
      tenant: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null),
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null),
      },
      tenantStaffMember: {
        findFirst: vi.fn(async ({ where }: { where: { tenantId: string; userId: string } }) =>
          where.tenantId === RESELLER && where.userId === MEMBER ? { accessExpiresAt: null } : null,
        ),
      },
      $transaction: vi.fn(),
    };
    return new ResellerAccess(prisma as never);
  };

  it("admits a member by the door's own key, and refuses them on another's", async () => {
    const domains = member('domain.manage');
    await expect(access().for('domain.manage').admit(domains, RESELLER, 'staffWrite', T0)).resolves.toMatchObject({ as: 'member' });
    await expect(access().for('theme.manage').admit(domains, RESELLER, 'read', T0)).rejects.toMatchObject({ reason: 'not_allowed' });
  });

  it('admits a member holding any one of the keys a door names', async () => {
    const door = access().for('user.read', 'user.write');
    await expect(door.admit(member('user.write'), RESELLER, 'read', T0)).resolves.toMatchObject({ as: 'member' });
    await expect(door.admit(member('bot.manage'), RESELLER, 'read', T0)).rejects.toMatchObject({ reason: 'not_allowed' });
  });

  it('no longer admits a member on `tenant.manage`', async () => {
    await expect(access().for('domain.manage').admit(member('tenant.manage'), RESELLER, 'read', T0)).rejects.toMatchObject({
      reason: 'not_allowed',
    });
  });

  it('the bare door is owner-only: it admits no member, `*` included', async () => {
    await expect(access().admit(member('*'), RESELLER, 'read', T0)).rejects.toMatchObject({ reason: 'not_allowed' });
    await expect(access().admit(owner, RESELLER, 'read', T0)).resolves.toMatchObject({ as: 'owner' });
  });

  it("leaves the owner and the platform's staff as they were, whatever key the door names", async () => {
    await expect(access().for('domain.manage').admit(owner, RESELLER, 'staffWrite', T0)).resolves.toMatchObject({ as: 'owner' });
    await expect(access().for('domain.manage').admit(staff, RESELLER, 'staffWrite', T0)).resolves.toMatchObject({ as: 'staff' });
  });

  it('every member-door key is registered and grantable by a tenant', () => {
    const registry = new Map<string, { platformOnly: boolean }>(PERMISSION_REGISTRY.map((row) => [row.permission, row]));
    for (const key of RESELLER_KEYS) {
      expect(registry.get(key), key).toMatchObject({ platformOnly: false });
    }
  });

  it("names every key the catalog's §3.2 split asks for", () => {
    for (const key of [
      'wallet.manual_adjust',
      'grant.assign',
      'domain.manage',
      'theme.manage',
      'credential.manage',
      'bot.manage',
      'audit.read',
      'export.request',
      'restriction.assign',
      'staff.manage',
      'role.manage',
      'settings.manage',
      'report.read',
    ]) {
      expect(RESELLER_KEYS, key).toContain(key);
    }
  });
});
