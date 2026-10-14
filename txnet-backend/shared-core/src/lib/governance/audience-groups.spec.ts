import { describe, expect, it } from 'vitest';

import {
  type AudienceGroupReader,
  USER_GROUP_READ_KEY,
  keysActingIn,
  mayPickAudienceGroup,
  pickableAudienceGroups,
  refusedAudienceGroup,
} from './audience-groups';

// ADR-0143: who may pick a group as an audience. Every user is not a group and
// never reaches this rule; a keyless group needs `user_group.read`; a group
// that gives keys needs every one of them.
describe('mayPickAudienceGroup', () => {
  it('lets a keyless group be picked only with user_group.read', () => {
    expect(mayPickAudienceGroup(['catalog.manage'], [])).toBe(false);
    expect(mayPickAudienceGroup(['catalog.manage', USER_GROUP_READ_KEY], [])).toBe(true);
  });

  it('lets a group that gives keys be picked only by a holder of all of them, user_group.read or not', () => {
    expect(mayPickAudienceGroup(['catalog.manage', USER_GROUP_READ_KEY, 'user.read'], ['user.read', 'support.agent'])).toBe(false);
    expect(mayPickAudienceGroup(['catalog.manage', 'user.read', 'support.agent'], ['user.read', 'support.agent'])).toBe(true);
  });

  it('lets the holder of * pick anything', () => {
    expect(mayPickAudienceGroup(['*'], [])).toBe(true);
    expect(mayPickAudienceGroup(['*'], ['platform.support'])).toBe(true);
  });
});

describe('keysActingIn', () => {
  it("gives a reseller's owner the whole tenant ceiling, so any reseller group is theirs to pick", () => {
    const acting = keysActingIn('owner', ['self.read']);
    expect(mayPickAudienceGroup(acting, [])).toBe(true);
    expect(mayPickAudienceGroup(acting, ['user.read', 'support.agent', 'user_group.manage'])).toBe(true);
    expect(acting).not.toContain('*');
  });

  it("gives the platform's staff the part of the ceiling they hold, and a member their own keys", () => {
    expect(keysActingIn('staff', ['platform.tenant.manage', 'user.read'])).toEqual(['user.read']);
    expect(keysActingIn('member', ['user.read', 'self.read'])).toEqual(['user.read', 'self.read']);
  });
});

type Row = { id: string; name: string; allTenants: boolean; keys: string[] };

/** A reader over `rows`, answering the two shapes the module asks for. */
function readerOf(rows: Row[]): AudienceGroupReader {
  const shaped = (r: Row) => ({
    id: r.id,
    name: r.name,
    allTenants: r.allTenants,
    role: null,
    permissions: r.keys.map((key) => ({ permission: { key } })),
    _count: { members: 3 },
  });
  const userGroup = {
    findMany: async (args: { where?: { id?: { in: string[] } } }) => {
      const ids = args.where?.id?.in;
      return rows.filter((r) => !ids || ids.includes(r.id)).map(shaped);
    },
  };
  return { userGroup } as never;
}

const VIP: Row = { id: 'g-vip', name: 'VIP', allTenants: false, keys: [] };
const SUPPORT: Row = { id: 'g-support', name: 'Support', allTenants: false, keys: ['user.read', 'support.agent'] };
const EVERY_RESELLER: Row = { id: 'g-all', name: 'Every reseller', allTenants: true, keys: [] };

describe('refusedAudienceGroup', () => {
  const db = readerOf([VIP, SUPPORT]);

  it('names a group that is not there', async () => {
    expect(await refusedAudienceGroup(db, [USER_GROUP_READ_KEY], ['g-gone'])).toEqual({ reason: 'group_not_found', groupId: 'g-gone' });
  });

  it('names a group the caller may not pick', async () => {
    expect(await refusedAudienceGroup(db, [USER_GROUP_READ_KEY], ['g-vip', 'g-support'])).toEqual({ reason: 'audience_not_allowed', groupId: 'g-support' });
    expect(await refusedAudienceGroup(db, ['catalog.manage'], ['g-vip'])).toEqual({ reason: 'audience_not_allowed', groupId: 'g-vip' });
  });

  it('does not weigh a group the record already has, so a smaller manager can still edit it', async () => {
    expect(await refusedAudienceGroup(db, [USER_GROUP_READ_KEY], ['g-vip', 'g-support'], { kept: ['g-support'] })).toBeNull();
  });

  it('answers nothing for no groups', async () => {
    expect(await refusedAudienceGroup(db, [], [])).toBeNull();
  });
});

describe('pickableAudienceGroups', () => {
  it("lists only what the caller may pick, by name, never 'every reseller'", async () => {
    const db = readerOf([SUPPORT, VIP, EVERY_RESELLER]);
    expect(await pickableAudienceGroups(db, [USER_GROUP_READ_KEY])).toEqual([{ id: 'g-vip', name: 'VIP', givesKeys: false, userCount: 3 }]);
    expect(await pickableAudienceGroups(db, ['*'])).toEqual([
      { id: 'g-support', name: 'Support', givesKeys: true, userCount: 3 },
      { id: 'g-vip', name: 'VIP', givesKeys: false, userCount: 3 },
    ]);
  });
});
