import { authorityOver, permissionsOf } from './authority';

/**
 * Identity invariant 18 (ADR-0103, F-311-ac): every act on another person's
 * account asks one rule, first match wins — never yourself, never the tenant's
 * owner, the owner and platform staff over a reseller allowed, and among peers
 * only a strict superset of the target's permissions.
 */
describe('authorityOver', () => {
  const reseller = { ownerUserId: 'u-owner', platform: false };
  const platform = { ownerUserId: 'u-root', platform: true };
  const me = (permissions: string[], as: 'owner' | 'member' | 'staff' = 'member') => ({
    userId: 'u-me',
    permissions,
    as,
  });
  const them = (permissions: string[], userId = 'u-them') => ({ userId, permissions });

  it('refuses acting on yourself, before anything else', () => {
    expect(authorityOver(me(['*'], 'staff'), them(['*'], 'u-me'), reseller)).toBe('self');
  });

  it("refuses the tenant's owner — to everyone, platform staff included", () => {
    expect(authorityOver(me(['*'], 'staff'), them([], 'u-owner'), reseller)).toBe('owner');
    expect(authorityOver(me(['*'], 'staff'), them([], 'u-root'), platform)).toBe('owner');
  });

  it("allows the tenant's owner over anyone else in it", () => {
    expect(authorityOver({ ...me([], 'owner'), userId: 'u-owner' }, them(['*']), reseller)).toBeNull();
    expect(authorityOver({ ...me(['*'], 'staff'), userId: 'u-root' }, them(['*']), platform)).toBeNull();
  });

  it("allows platform staff over a reseller's people, whatever those hold", () => {
    expect(authorityOver(me(['tenant.manage'], 'staff'), them(['*']), reseller)).toBeNull();
  });

  it("treats platform staff on the platform's own tenant as peers, not as authority", () => {
    expect(authorityOver(me(['tenant.manage'], 'staff'), them(['tenant.manage']), platform)).toBe('not_above');
  });

  it('allows a peer holding every key of the target and one more', () => {
    expect(authorityOver(me(['tenant.manage', 'user.block']), them(['user.block']), reseller)).toBeNull();
  });

  it('refuses a peer with exactly the same keys — two admins cannot lock each other out', () => {
    expect(authorityOver(me(['tenant.manage']), them(['tenant.manage']), reseller)).toBe('not_above');
    expect(authorityOver(me(['*']), them(['*']), platform)).toBe('not_above');
  });

  it('refuses a peer missing one of the target’s keys, even holding more of others', () => {
    expect(authorityOver(me(['tenant.manage', 'a', 'b']), them(['tenant.manage', 'c']), reseller)).toBe('not_above');
  });

  it('reads `*` through holdsPermission: it covers every key and outranks any finite set', () => {
    expect(authorityOver(me(['*']), them(['tenant.manage', 'user.impersonate']), reseller)).toBeNull();
    expect(authorityOver(me(['tenant.manage', 'x']), them(['*']), reseller)).toBe('not_above');
  });

  it('lets any admitted admin act on a customer, who holds no keys', () => {
    expect(authorityOver(me(['tenant.manage']), them([]), reseller)).toBeNull();
  });
});

describe('permissionsOf', () => {
  it("reads the target's keys from their role, and none when they have no role row", () => {
    expect(permissionsOf({ role: { rolePermissions: [{ permission: { key: 'a' } }, { permission: { key: 'b' } }] } })).toEqual([
      'a',
      'b',
    ]);
    expect(permissionsOf({ role: null })).toEqual([]);
  });
});
