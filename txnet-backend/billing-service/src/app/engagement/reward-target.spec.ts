/**
 * The user's prize service (F-707-r): which Grant a prize of GB or days goes to.
 *
 * What would break silently here: another user's Grant saved as the target (a
 * prize steered to someone else's service); a Grant that can take no prize
 * offered, so the choice never applies; a stale choice shown as still in force
 * after its Grant ended, while the issuer has quietly gone automatic.
 */
import { GrantStatus } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { RewardTargetService } from './reward-target.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const AT = new Date('2026-10-22T12:00:00Z');
const GIB = 1024 ** 3;

type G = { id: string; userId: string; status: GrantStatus; trafficUnlimited: boolean; endsAt: Date | null; startsAt: Date; userLabel: string | null; variant: null };
const g = (id: string, o: Partial<G> = {}): G => ({ id, userId: USER, status: GrantStatus.active, trafficUnlimited: false, endsAt: AT, startsAt: AT, userLabel: null, variant: null, ...o });

type Where = { id?: string; userId: string; status?: GrantStatus; OR?: unknown };
function build(o: { grants: G[]; chosen?: string }) {
  let chosen = o.chosen ?? null;
  const fits = (x: G) => !x.trafficUnlimited || x.endsAt !== null;
  const match = (x: G, w: Where) => x.userId === w.userId && (!w.id || x.id === w.id) && (!w.status || x.status === w.status) && (!w.OR || fits(x));
  const tx = {
    $executeRaw: async () => 0,
    grant: {
      findMany: async ({ where }: { where: Where }) => o.grants.filter((x) => match(x, where)),
      findFirst: async ({ where }: { where: Where }) => o.grants.find((x) => match(x, where)) ?? null,
    },
    rewardTarget: {
      findUnique: async () => (chosen ? { grantId: chosen } : null),
      upsert: async ({ create }: { create: { grantId: string } }) => {
        chosen = create.grantId;
        return create;
      },
      deleteMany: async () => {
        chosen = null;
        return { count: 1 };
      },
    },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  // My services' own view of each Grant: its cap and what it used (F-707-x).
  const grants = { listForUser: async () => ({ rows: o.grants.map((x) => ({ id: x.id, trafficCapBytes: x.trafficUnlimited ? null : String(10 * GIB), consumedBytes: String(4 * GIB) })) }) };
  return { service: new RewardTargetService(prisma as never, grants as never), chosen: () => chosen };
}

const asTenant = <T>(fn: () => Promise<T>) => runWithTenant({ id: TENANT }, fn);
const caller = { userId: USER, tenantId: TENANT };

describe('RewardTargetService.view', () => {
  it('offers the active services a prize can go to, and the choice in force', async () => {
    const { service } = build({
      grants: [g('g-a'), g('g-b', { trafficUnlimited: true, endsAt: null }), g('g-off', { status: GrantStatus.expired }), g('g-c', { trafficUnlimited: true })],
      chosen: 'g-c',
    });
    const view = await asTenant(() => service.view(caller));
    expect(view.services.map((s) => [s.id, s.takesTraffic, s.takesDays])).toEqual([['g-a', true, true], ['g-c', false, true]]);
    expect(view.chosenGrantId).toBe('g-c');
  });

  it('reads automatic when the saved service can no longer take a prize', async () => {
    const { service } = build({ grants: [g('g-a'), g('g-off', { status: GrantStatus.expired })], chosen: 'g-off' });
    await expect(asTenant(() => service.view(caller))).resolves.toMatchObject({ chosenGrantId: null });
  });
});

describe('telling services apart (F-707-x)', () => {
  it('names what is left of a capped service, nothing for an unlimited one, and each end date', async () => {
    const { service } = build({ grants: [g('g-a'), g('g-c', { trafficUnlimited: true })] });
    const view = await asTenant(() => service.view(caller));
    expect(view.services.map((s) => [s.id, s.remainingBytes, s.endsAt])).toEqual([['g-a', String(6 * GIB), AT], ['g-c', null, AT]]);
  });
});

describe('RewardTargetService.choose', () => {
  it("saves the user's own service, and null goes back to automatic", async () => {
    const { service, chosen } = build({ grants: [g('g-a'), g('g-b')] });
    await expect(asTenant(() => service.choose(caller, 'g-b'))).resolves.toMatchObject({ chosenGrantId: 'g-b' });
    expect(chosen()).toBe('g-b');
    await expect(asTenant(() => service.choose(caller, null))).resolves.toMatchObject({ chosenGrantId: null });
    expect(chosen()).toBeNull();
  });

  it("refuses another user's service as not found, and one no prize can reach as not eligible", async () => {
    const { service, chosen } = build({
      grants: [g('g-theirs', { userId: OTHER }), g('g-forever', { trafficUnlimited: true, endsAt: null }), g('g-off', { status: GrantStatus.suspended })],
    });
    await expect(asTenant(() => service.choose(caller, 'g-theirs'))).rejects.toMatchObject({ reason: 'grant_not_found' });
    await expect(asTenant(() => service.choose(caller, 'g-forever'))).rejects.toMatchObject({ reason: 'grant_not_eligible' });
    await expect(asTenant(() => service.choose(caller, 'g-off'))).rejects.toMatchObject({ reason: 'grant_not_eligible' });
    expect(chosen()).toBeNull();
  });
});
