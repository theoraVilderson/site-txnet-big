import { accessOf } from './access';
import { permissionFingerprint } from './permission-fingerprint';
import { PermissionStateStore } from './permission-state.store';
import { TokenService } from '../token.service';
import type { RedisService } from '../../redis/redis.service';

/**
 * One answer for what a person may do (AC-1-k, ADR-0138): their role's keys,
 * plus each group's, plus the keys given to them, minus the keys taken from
 * them — and a removal wins over every source. The token is minted from it,
 * and the gate's rule (mirrored here by `PermissionStateStore`) compares the
 * person's own fingerprint when they have one, the role's when they do not.
 */
describe('accessOf', () => {
  it("is exactly the role's keys for someone nothing else applies to", () => {
    const access = accessOf({ roleKeys: ['user.read', 'user.write'] });

    expect(access).toEqual({ keys: ['user.read', 'user.write'], personal: false });
  });

  it('adds a key given to the person and the keys of every group they are in', () => {
    const access = accessOf({
      roleKeys: ['user.read'],
      groups: [{ roleKeys: ['ticket.read'], keys: ['coupon.manage'] }],
      given: ['report.read'],
    });

    expect(new Set(access.keys)).toEqual(new Set(['user.read', 'ticket.read', 'coupon.manage', 'report.read']));
    expect(access.personal).toBe(true);
  });

  it('lets a removal win over the role, a group and a gift alike', () => {
    const access = accessOf({
      roleKeys: ['user.read', 'user.write'],
      groups: [{ roleKeys: ['coupon.manage'], keys: [] }],
      given: ['report.read'],
      taken: ['user.write', 'coupon.manage', 'report.read'],
    });

    expect(access.keys).toEqual(['user.read']);
  });

  it('is personal when a source applies even if the answer equals the role', () => {
    // Its fingerprint must still be written, or a token minted before the
    // gift was lifted would keep matching nothing and be refused forever.
    expect(accessOf({ roleKeys: ['user.read'], given: ['user.read'] }).personal).toBe(true);
  });

  it('never takes `*` from anywhere but the role, and never narrows a `*` role', () => {
    expect(accessOf({ roleKeys: ['user.read'], given: ['*'], groups: [{ roleKeys: ['*'], keys: ['*'] }] }).keys).toEqual(['user.read']);
    expect(accessOf({ roleKeys: ['*'], taken: ['user.write'], given: ['x.y'] })).toEqual({ keys: ['*'], personal: false });
  });
});

describe('the gate rule with a person key (PermissionStateStore.isStale)', () => {
  const claims = { sub: 'user-1', roleId: 'role-1', permHash: 'mine' };
  const storeKnowing = (role: string | null, userRole: string | null, person: string | null) => {
    const mget = vi.fn().mockResolvedValue([role, userRole, person]);
    return { store: new PermissionStateStore({ client: { mget } } as unknown as RedisService), mget };
  };

  it("lets the person's key decide alone when it is present", async () => {
    await expect(storeKnowing('the-role', null, 'mine').store.isStale(claims)).resolves.toBe(false);
    await expect(storeKnowing('mine', null, 'other').store.isStale(claims)).resolves.toBe(true);
  });

  it("falls back to the role's key when the person has none", async () => {
    await expect(storeKnowing('mine', null, null).store.isStale(claims)).resolves.toBe(false);
    await expect(storeKnowing('the-role', null, null).store.isStale(claims)).resolves.toBe(true);
  });

  it('reads the three keys in one round trip', async () => {
    const { store, mget } = storeKnowing(null, null, null);
    await store.isStale(claims);
    expect(mget).toHaveBeenCalledWith('role:role-1:permissions', 'user:user-1:role', 'user:user-1:permissions');
  });
});

describe('TokenService mints the answer', () => {
  const tokens = new TokenService({ get: (k: string) => (k === 'JWT_ACCESS_SECRET' ? 's'.repeat(32) : 900) } as never);
  const user = {
    id: 'user-1',
    tenantId: 't',
    roleId: 'role-1',
    status: 'active',
    role: { name: 'Support', rolePermissions: [{ permission: { key: 'user.read' } }, { permission: { key: 'user.write' } }] },
  };

  it('carries the keys, their fingerprint and `personal` for a personal holder', () => {
    const access = accessOf({ roleKeys: ['user.read', 'user.write'], given: ['coupon.manage'], taken: ['user.write'] });
    const claims = tokens.verify(tokens.signAccessToken(user, 's-1', access));

    expect(claims.permissions).toEqual(access.keys);
    expect(claims.permHash).toBe(permissionFingerprint(access.keys));
    expect(claims.personal).toBe(true);
  });

  it("is the role's own token, unchanged, for everyone else", () => {
    const claims = tokens.verify(tokens.signAccessToken(user, 's-1', accessOf({ roleKeys: ['user.read', 'user.write'] })));

    expect(claims.permHash).toBe(permissionFingerprint(['user.read', 'user.write']));
    expect(claims.personal).toBeUndefined();
  });
});
