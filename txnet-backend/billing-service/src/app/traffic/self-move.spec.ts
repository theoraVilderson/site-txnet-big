/**
 * A user moves their own config (F-410-c, D-63: "at once, free, no approval"):
 * `POST /api/billing/traffic/configs/:configId/move`. What would break silently:
 *
 *  - **a target F-410-b did not offer.** The move takes only a panel the
 *    targets answer — never the one it is on, a draining member, or a panel of
 *    another group — so the action cannot reach where the list does not;
 *  - **a second move inside the wait.** The Grant's last move by its user plus
 *    the wait refuses `move_cooldown` with the time it ends; an admin's move
 *    does not count;
 *  - **a Grant fulfilment placed on its whole group.** A `mirror` Grant is on
 *    every member by rule: moving one line off would be undone by the next
 *    fulfilment, so it is `placed_by_group`;
 *  - **switched off reading as open** (`move_disabled`);
 *  - **the wrong actor.** `ConfigActions.move` runs as the user, so its
 *    `move_out` row is the one the next wait counts from;
 *  - **two moves racing.** The Grant is locked before anything is read, so the
 *    second sees the first's move and its wait.
 */
import { ActorType, ConfigStatus, PanelGroupMemberRole, PanelGroupStrategy } from '@prisma/client';

import { selfMove } from './self-move';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const TENANT = '33333333-3333-4333-8333-333333333333';
const GRANT = 'g-1';
const GROUP = 'group-1';
const NOW = new Date('2026-10-22T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

/** The config is on `p-on`; `p-nl` is the one target; `p-drain` is a draining member the targets leave out. */
const PANELS = [
  { id: 'p-on', region: 'de', role: PanelGroupMemberRole.primary },
  { id: 'p-nl', region: 'nl', role: PanelGroupMemberRole.primary },
  { id: 'p-drain', region: 'fi', role: PanelGroupMemberRole.drain },
];

type Seed = {
  owner?: string;
  strategy?: PanelGroupStrategy;
  logs?: { actorType: ActorType; createdAt: Date }[];
  tenantSetting?: { enabled: boolean | null; cooldownHours: number | null };
};

function world(seed: Seed = {}) {
  const calls: string[] = [];
  const tx = {
    $queryRaw: async () => {
      calls.push('lock');
      return [{ id: GRANT }];
    },
    config: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        calls.push('read');
        if (where.id !== 'c-1') return null;
        return {
          userId: seed.owner ?? USER,
          status: ConfigStatus.active,
          tenantId: TENANT,
          grantId: GRANT,
          grant: { panelGroupId: GROUP, panelGroup: { strategy: seed.strategy ?? PanelGroupStrategy.priority }, variant: null },
        };
      },
      findMany: async () => [{ panelId: 'p-on' }],
    },
    configActionLog: {
      findFirst: async ({ where }: { where: { actorType: ActorType } }) =>
        (seed.logs ?? []).filter((l) => l.actorType === where.actorType).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null,
    },
    panelGroupMember: {
      findMany: async ({ where }: { where: { role: { not: PanelGroupMemberRole }; panelId: { notIn: string[] } } }) =>
        PANELS.filter((p) => p.role !== where.role.not && !where.panelId.notIn.includes(p.id)).map((p) => ({ panel: { id: p.id, region: p.region } })),
    },
    configSelfMoveSetting: { findUnique: async () => seed.tenantSetting ?? null },
    configSelfMoveProductSetting: { findUnique: async () => null },
  };
  const moves: unknown[] = [];
  const actions = {
    move: async (_tx: unknown, input: unknown) => {
      moves.push(input);
      return { configId: 'c-new', uuid: 'u-new', retiredConfigId: 'c-1' };
    },
  };
  return { tx, actions, calls, moves };
}

const run = (w: ReturnType<typeof world>, toPanelId = 'p-nl', userId = USER) =>
  selfMove(w.tx as never, w.actions as never, { userId, configId: 'c-1', toPanelId, now: NOW });

describe('selfMove — the move', () => {
  it('moves to an offered panel as the user, and answers the new config, its region and the next wait', async () => {
    const w = world();
    await expect(run(w)).resolves.toEqual({
      retiredConfigId: 'c-1',
      configId: 'c-new',
      panel: { id: 'p-nl', region: 'nl' },
      nextMoveAt: '2026-10-23T12:00:00.000Z',
    });
    expect(w.moves).toEqual([{ configId: 'c-1', toPanelId: 'p-nl', actor: { actorType: ActorType.user, actorId: USER } }]);
  });

  it('locks the Grant before it reads anything', async () => {
    const w = world();
    await run(w);
    expect(w.calls[0]).toBe('lock');
  });

  it('a wait of 0 answers no next wait', async () => {
    const w = world({ tenantSetting: { enabled: null, cooldownHours: 0 } });
    await expect(run(w)).resolves.toMatchObject({ nextMoveAt: null });
  });
});

describe('selfMove — refused, and nothing moved', () => {
  it('a panel the targets did not offer is `not_a_target`: the one it is on, a draining member, an unknown one', async () => {
    for (const panelId of ['p-on', 'p-drain', 'p-elsewhere']) {
      const w = world();
      await expect(run(w, panelId)).rejects.toMatchObject({ reason: 'not_a_target' });
      expect(w.moves).toEqual([]);
    }
  });

  it('inside the wait is `move_cooldown` with the time it ends; an admin\'s move does not count', async () => {
    const w = world({ logs: [{ actorType: ActorType.user, createdAt: hoursAgo(10) }] });
    await expect(run(w)).rejects.toMatchObject({ reason: 'move_cooldown', nextMoveAt: '2026-10-23T02:00:00.000Z' });
    expect(w.moves).toEqual([]);
    await expect(run(world({ logs: [{ actorType: ActorType.admin, createdAt: hoursAgo(1) }] }))).resolves.toMatchObject({ configId: 'c-new' });
  });

  it('a Grant placed on its whole group (`mirror`) is `placed_by_group`', async () => {
    const w = world({ strategy: PanelGroupStrategy.mirror });
    await expect(run(w)).rejects.toMatchObject({ reason: 'placed_by_group' });
    expect(w.moves).toEqual([]);
  });

  it('switched off is `move_disabled`', async () => {
    const w = world({ tenantSetting: { enabled: false, cooldownHours: null } });
    await expect(run(w)).rejects.toMatchObject({ reason: 'move_disabled' });
    expect(w.moves).toEqual([]);
  });

  it('another user\'s config is `config_not_found`, as a missing one', async () => {
    const w = world({ owner: OTHER_USER });
    await expect(run(w)).rejects.toMatchObject({ reason: 'config_not_found' });
    await expect(run(world(), 'p-nl', OTHER_USER)).rejects.toMatchObject({ reason: 'config_not_found' });
    expect(w.moves).toEqual([]);
  });
});
