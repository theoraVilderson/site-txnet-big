import { ResellerAccessRefused } from '@txnet-backend/shared-core';

import { ResellerUserGrantsRefused, ResellerUserGrantsService } from './reseller-user-grants.service';

/**
 * KS-1-a (ADR-0140): `grant.assign` split by the kind of act. What this pins
 * is the key each act asks the member door for — the one thing nothing else
 * would catch, because a wrong key still admits the owner and every `*`:
 *  - **see** (`grant.read`): the user's services, configs, usage, `/sub` link,
 *    history, and the search by a pasted line;
 *  - **repair** (`grant.repair`): rotating the link, and regenerate, disable,
 *    enable or move on a config — no value moves;
 *  - **move value** (`grant.assign`): everything else, retiring a config
 *    included, since a retired config is not given back.
 * The door is a fake that records the key and refuses, so nothing is read.
 */
describe('the key each act on a user’s services asks for', () => {
  const T = '22222222-2222-4222-8222-222222222222';
  const U = '66666666-6666-4666-8666-666666666666';
  const G = '88888888-8888-4888-8888-888888888888';
  // The door is faked, so who acts does not matter; `never` satisfies both actor shapes.
  const actor = { userId: '44444444-4444-4444-8444-444444444444', tenantId: T, permissions: [] as string[] } as never;

  function build() {
    const asked: string[] = [];
    const access = {
      for: (key: string) => {
        asked.push(key);
        return {
          runIncludingPlatform: async () => {
            throw new ResellerAccessRefused('not_allowed', T);
          },
        };
      },
    };
    const service = new ResellerUserGrantsService({} as never, access as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    return { service, asked };
  }

  async function keyOf(call: (s: ResellerUserGrantsService) => Promise<unknown>): Promise<string> {
    const { service, asked } = build();
    await expect(call(service)).rejects.toBeInstanceOf(ResellerUserGrantsRefused);
    expect(asked).toHaveLength(1);
    return asked[0];
  }

  const config = (action: string) => ({ action, configIds: ['c1'], reason: null }) as never;

  it('asks grant.read to see', async () => {
    expect(await keyOf((s) => s.grants(actor, T, U, { scope: 'all' } as never))).toBe('grant.read');
    expect(await keyOf((s) => s.configs(actor, T, U, G))).toBe('grant.read');
    expect(await keyOf((s) => s.usage(actor, T, U, G))).toBe('grant.read');
    expect(await keyOf((s) => s.subscriptionLink(actor, T, U, G))).toBe('grant.read');
    expect(await keyOf((s) => s.history(actor, T, U, G, { page: 1, pageSize: 20 }))).toBe('grant.read');
    expect(await keyOf((s) => s.findByLines(actor, T, { lines: ['vless://x'] } as never))).toBe('grant.read');
  });

  it('asks grant.repair to fix without moving value', async () => {
    expect(await keyOf((s) => s.rotateLink(actor, T, U, G, null))).toBe('grant.repair');
    expect(await keyOf((s) => s.moveTargets(actor, T, U))).toBe('grant.repair');
    for (const action of ['regenerate', 'disable', 'enable', 'move']) {
      expect(await keyOf((s) => s.act(actor, T, U, config(action))), action).toBe('grant.repair');
    }
  });

  it('asks grant.assign for everything that moves value, retiring a config included', async () => {
    expect(await keyOf((s) => s.act(actor, T, U, config('retire')))).toBe('grant.assign');
    expect(await keyOf((s) => s.catalog(actor, T))).toBe('grant.assign');
    expect(await keyOf((s) => s.freeze(actor, T, U, G, null, null))).toBe('grant.assign');
    expect(await keyOf((s) => s.unfreeze(actor, T, U, G, null))).toBe('grant.assign');
    expect(await keyOf((s) => s.changeDuration(actor, T, U, G, { days: 1 } as never, 'r'))).toBe('grant.assign');
    expect(await keyOf((s) => s.changeTraffic(actor, T, U, G, BigInt(1), 'r'))).toBe('grant.assign');
    expect(await keyOf((s) => s.resetTraffic(actor, T, U, G, 'r'))).toBe('grant.assign');
    expect(await keyOf((s) => s.giftTraffic(actor, T, U, G, BigInt(1), 'r'))).toBe('grant.assign');
    expect(await keyOf((s) => s.setSpeed(actor, T, U, G, 10, 'r'))).toBe('grant.assign');
    expect(await keyOf((s) => s.setDevices(actor, T, U, G, 2, 'r'))).toBe('grant.assign');
    expect(await keyOf((s) => s.deleteGrant(actor, T, U, G, false, 'r'))).toBe('grant.assign');
  });
});
