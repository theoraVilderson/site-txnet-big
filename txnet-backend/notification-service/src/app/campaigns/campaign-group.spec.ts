import { describe, expect, it } from 'vitest';

import { audienceFilterSchema } from './campaign-admin.schema';
import { audienceWhere } from './campaign-fan-out.service';
import { campaignGroupRefusal, groupMemberIds } from './campaign-group';

// GR-1-y (ADR-0143): a campaign may aim at one of its tenant's groups, like a
// discount or a gateway. The rule is shared-core's; these hold the campaign's
// half of it — the filter, the fan-out's members, the write's refusal.
const TENANT = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const STAFF = '33333333-3333-4333-8333-333333333333';
const STARTED = new Date('2026-10-14T08:00:00Z');

describe('a campaign aimed at a group', () => {
  it('takes a group id in its audience, and nothing that is not one', () => {
    expect(audienceFilterSchema.safeParse({ groupId: GROUP }).success).toBe(true);
    expect(audienceFilterSchema.safeParse({ groupId: 'vip' }).success).toBe(false);
  });

  it("sends only to the group's members, and to nobody when none were read", () => {
    const narrowed = audienceWhere({ tenantId: TENANT, sendStartedAt: STARTED }, { groupId: GROUP }, ['u1', 'u2']);
    expect(narrowed.AND).toContainEqual({ id: { in: ['u1', 'u2'] } });
    const unread = audienceWhere({ tenantId: TENANT, sendStartedAt: STARTED }, { groupId: GROUP }, null);
    expect(unread.AND).toContainEqual({ id: { in: [] } });
    expect(audienceWhere({ tenantId: TENANT, sendStartedAt: STARTED }, {}, null).AND.some((c) => 'id' in c)).toBe(false);
  });

  it('reads the user members whose membership was live at the send’s start', async () => {
    const seen: unknown[] = [];
    const db = {
      userGroupMember: {
        findMany: async (args: unknown) => {
          seen.push(args);
          return [{ userId: 'u1' }, { userId: 'u2' }];
        },
      },
    } as never;
    expect(await groupMemberIds(db, GROUP, STARTED)).toEqual(['u1', 'u2']);
    expect(seen[0]).toMatchObject({
      where: { groupId: GROUP, memberType: 'user', OR: [{ expiresAt: null }, { expiresAt: { gt: STARTED } }] },
    });
  });
});

/** A reader holding one keyless group and one that gives `support.agent`. */
const groups = {
  userGroup: {
    findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
      [
        { id: GROUP, name: 'VIP', allTenants: false, role: null, permissions: [] },
        { id: STAFF, name: 'Support', allTenants: false, role: null, permissions: [{ permission: { key: 'support.agent' } }] },
      ].filter((g) => where.id.in.includes(g.id)),
  },
} as never;

describe('campaignGroupRefusal', () => {
  it('lets a manager with user_group.read aim at a keyless group, and refuses one that gives keys they lack', async () => {
    const acting = ['campaign.manage', 'user_group.read'];
    expect(await campaignGroupRefusal(groups, acting, { groupId: GROUP }, { kept: null, tenantId: TENANT })).toBeNull();
    expect(await campaignGroupRefusal(groups, acting, { groupId: STAFF }, { kept: null, tenantId: TENANT })).toEqual({
      reason: 'audience_not_allowed',
      groupId: STAFF,
    });
  });

  it('names a group that is not there, and leaves a draft’s own group unweighed', async () => {
    const missing = '44444444-4444-4444-8444-444444444444';
    expect(await campaignGroupRefusal(groups, ['*'], { groupId: missing }, { kept: null, tenantId: TENANT })).toEqual({
      reason: 'group_not_found',
      groupId: missing,
    });
    expect(await campaignGroupRefusal(groups, ['campaign.manage'], { groupId: STAFF }, { kept: STAFF, tenantId: TENANT })).toBeNull();
    expect(await campaignGroupRefusal(groups, ['campaign.manage'], {}, { kept: null, tenantId: TENANT })).toBeNull();
  });
});
