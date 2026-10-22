/**
 * Where a user may move their own config (F-410-b, D-63: "only panels the
 * product already allows"): `GET /api/billing/traffic/configs/:configId/move-targets`.
 * What would break silently:
 *
 *  - **a target the product does not allow.** Only members of the Grant's own
 *    group (never the variant's — ADR-0127 decision 4), not draining, whose
 *    panel is accepted, not retired, and shared or the Grant's tenant's;
 *  - **a target the Grant is already on.** Every panel it holds a live config
 *    on is left out, so a `mirror` Grant — on every member — is offered none;
 *  - **a panel's name reaching the user.** The id and the region only, as the
 *    config list answers (user, 2026-10-22);
 *  - **the wrong wait.** `nextMoveAt` is the Grant's last move *by its user*
 *    plus the wait in effect (product -> tenant -> platform); an admin's move,
 *    a wait already over, or a wait of 0 answer null;
 *  - **switched off reading as open.** A tenant that turned it off answers
 *    `enabled: false` and no target;
 *  - **another user's config.** It is `config_not_found`, as a missing one is.
 */
import { ActorType, ConfigStatus, PanelGroupMemberRole, PanelReviewState } from '@prisma/client';

import { selfMoveTargets } from './self-move-targets';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const TENANT = '33333333-3333-4333-8333-333333333333';
const OTHER_TENANT = '44444444-4444-4444-8444-444444444444';
const GRANT = 'g-1';
const GROUP = 'group-1';
const PRODUCT = 'product-1';
const NOW = new Date('2026-10-22T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

type Panel = { id: string; name: string; region: string; retiredAt: Date | null; reviewState: PanelReviewState; tenantId: string | null };
const panel = (id: string, region: string, extra: Partial<Panel> = {}): Panel => ({
  id,
  name: `internal-${id}`,
  region,
  retiredAt: null,
  reviewState: PanelReviewState.accepted,
  tenantId: null,
  ...extra,
});

const ON = panel('p-on', 'de'); // the config is here now
const FREE_NL = panel('p-nl', 'nl');
const FREE_DE = panel('p-de2', 'de', { reviewState: PanelReviewState.accepted_low_trust, tenantId: TENANT });
const DRAINING = panel('p-drain', 'fi');
const RETIRED = panel('p-retired', 'fi', { retiredAt: hoursAgo(1) });
const PENDING = panel('p-pending', 'fi', { reviewState: PanelReviewState.pending });
const FOREIGN = panel('p-foreign', 'fi', { tenantId: OTHER_TENANT });

type Seed = {
  panelGroupId?: string | null;
  productId?: string | null;
  status?: ConfigStatus;
  owner?: string;
  members?: { panel: Panel; role: PanelGroupMemberRole }[];
  otherLivePanels?: string[];
  logs?: { actorType: ActorType; action: string; createdAt: Date }[];
  tenantSetting?: { enabled: boolean | null; cooldownHours: number | null };
  productSetting?: { enabled: boolean | null; cooldownHours: number | null };
};

function txOf(seed: Seed = {}) {
  const members = seed.members ?? [
    { panel: ON, role: PanelGroupMemberRole.primary },
    { panel: FREE_NL, role: PanelGroupMemberRole.primary },
    { panel: FREE_DE, role: PanelGroupMemberRole.replica },
    { panel: DRAINING, role: PanelGroupMemberRole.drain },
    { panel: RETIRED, role: PanelGroupMemberRole.primary },
    { panel: PENDING, role: PanelGroupMemberRole.primary },
    { panel: FOREIGN, role: PanelGroupMemberRole.primary },
  ];
  const live = [ON.id, ...(seed.otherLivePanels ?? [])];
  type MemberWhere = {
    groupId: string;
    role: { not: PanelGroupMemberRole };
    panelId: { notIn: string[] };
    panel: { retiredAt: null; reviewState: { in: PanelReviewState[] }; OR: { tenantId: string | null }[] };
  };
  const admits = (w: MemberWhere, m: { panel: Panel; role: PanelGroupMemberRole }) =>
    m.role !== w.role.not &&
    !w.panelId.notIn.includes(m.panel.id) &&
    m.panel.retiredAt === w.panel.retiredAt &&
    w.panel.reviewState.in.includes(m.panel.reviewState) &&
    w.panel.OR.some((o) => o.tenantId === m.panel.tenantId);
  return {
    config: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === 'c-1'
          ? {
              userId: seed.owner ?? USER,
              status: seed.status ?? ConfigStatus.active,
              tenantId: TENANT,
              grantId: GRANT,
              grant: { panelGroupId: seed.panelGroupId === undefined ? GROUP : seed.panelGroupId, variant: seed.productId === null ? null : { productId: seed.productId ?? PRODUCT } },
            }
          : null,
      findMany: async ({ where }: { where: { grantId: string; status: { not: ConfigStatus }; drainedAt: null } }) =>
        where.grantId === GRANT && where.status.not === ConfigStatus.retired && where.drainedAt === null ? live.map((panelId) => ({ panelId })) : [],
    },
    configActionLog: {
      findFirst: async ({ where }: { where: { action: string; actorType: ActorType; config: { grantId: string } } }) =>
        (seed.logs ?? [])
          .filter((l) => l.action === where.action && l.actorType === where.actorType && where.config.grantId === GRANT)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null,
    },
    panelGroupMember: {
      findMany: async ({ where }: { where: MemberWhere }) =>
        members
          .filter((m) => where.groupId === GROUP && admits(where, m))
          .sort((a, b) => a.panel.region.localeCompare(b.panel.region) || a.panel.id.localeCompare(b.panel.id))
          .map((m) => ({ panel: { id: m.panel.id, region: m.panel.region } })),
    },
    configSelfMoveSetting: { findUnique: async () => seed.tenantSetting ?? null },
    configSelfMoveProductSetting: { findUnique: async ({ where }: { where: { tenantId_productId: { productId: string } } }) => (where.tenantId_productId.productId === PRODUCT ? (seed.productSetting ?? null) : null) },
  };
}

const targets = (seed: Seed = {}, userId = USER) => selfMoveTargets(txOf(seed) as never, userId, 'c-1', NOW);

describe('selfMoveTargets — which panels', () => {
  it('offers the group\'s other members that may take a config, by region, with no name', async () => {
    const answer = await targets();
    expect(answer.panels).toEqual([
      { id: FREE_DE.id, region: 'de' },
      { id: FREE_NL.id, region: 'nl' },
    ]);
    expect(JSON.stringify(answer)).not.toContain('internal-');
  });

  it('leaves out every panel the Grant already has a live line on: a mirror Grant is offered none', async () => {
    await expect(targets({ otherLivePanels: [FREE_NL.id, FREE_DE.id] })).resolves.toMatchObject({ panels: [] });
  });

  it('a Grant served by no group has no product panels to go to', async () => {
    await expect(targets({ panelGroupId: null })).resolves.toMatchObject({ enabled: true, panels: [] });
  });
});

describe('selfMoveTargets — when', () => {
  it('answers the platform\'s on and 24 h, and no wait when the Grant was never moved by its user', async () => {
    await expect(targets()).resolves.toMatchObject({ configId: 'c-1', enabled: true, cooldownHours: 24, nextMoveAt: null });
  });

  it('the next move is the user\'s last plus the wait; an admin\'s move does not count', async () => {
    const logs = [
      { actorType: ActorType.user, action: 'move_out', createdAt: hoursAgo(10) },
      { actorType: ActorType.admin, action: 'move_out', createdAt: hoursAgo(1) },
    ];
    await expect(targets({ logs })).resolves.toMatchObject({ nextMoveAt: '2026-10-23T02:00:00.000Z' });
  });

  it('a wait already over, or a wait of 0, answers null', async () => {
    const logs = [{ actorType: ActorType.user, action: 'move_out', createdAt: hoursAgo(30) }];
    await expect(targets({ logs })).resolves.toMatchObject({ nextMoveAt: null });
    const recent = [{ actorType: ActorType.user, action: 'move_out', createdAt: hoursAgo(1) }];
    await expect(targets({ logs: recent, productSetting: { enabled: null, cooldownHours: 0 } })).resolves.toMatchObject({ cooldownHours: 0, nextMoveAt: null });
  });

  it('the product\'s override beats the tenant\'s; the tenant\'s, the platform\'s', async () => {
    const logs = [{ actorType: ActorType.user, action: 'move_out', createdAt: hoursAgo(1) }];
    await expect(targets({ logs, tenantSetting: { enabled: null, cooldownHours: 48 } })).resolves.toMatchObject({ cooldownHours: 48, nextMoveAt: '2026-10-24T11:00:00.000Z' });
    await expect(targets({ logs, tenantSetting: { enabled: null, cooldownHours: 48 }, productSetting: { enabled: null, cooldownHours: 2 } })).resolves.toMatchObject({
      cooldownHours: 2,
      nextMoveAt: '2026-10-22T13:00:00.000Z',
    });
  });

  it('switched off answers off and no target', async () => {
    await expect(targets({ tenantSetting: { enabled: false, cooldownHours: null } })).resolves.toEqual({ configId: 'c-1', enabled: false, cooldownHours: 24, nextMoveAt: null, panels: [] });
  });
});

describe('selfMoveTargets — whose', () => {
  it('another user\'s config is `config_not_found`; a retired one `config_retired`', async () => {
    await expect(targets({ owner: OTHER_USER })).rejects.toMatchObject({ reason: 'config_not_found' });
    await expect(targets({}, OTHER_USER)).rejects.toMatchObject({ reason: 'config_not_found' });
    await expect(selfMoveTargets(txOf() as never, USER, 'missing', NOW)).rejects.toMatchObject({ reason: 'config_not_found' });
    await expect(targets({ status: ConfigStatus.retired })).rejects.toMatchObject({ reason: 'config_retired' });
  });
});
