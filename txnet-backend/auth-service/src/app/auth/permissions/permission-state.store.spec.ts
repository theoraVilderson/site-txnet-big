import { PermissionStateStore } from './permission-state.store';
import type { RedisService } from '../../redis/redis.service';

/**
 * The rule that decides whether a token's permissions are still true
 * (ADR-0043), in this process. `auth-handler` applies the same rule at the gate
 * (`stalePermissions`), and the two must agree on the one case that is easy to
 * get backwards:
 *
 * **Knowing nothing is not a change.** An empty Redis — a fresh deploy, a flush,
 * a role Postgres has not reported yet — must refuse nobody. Read the other way,
 * shipping this row would sign out every user on the platform at once.
 *
 * Only a *known* difference refuses: the user now holds another role, or the
 * role's fingerprint moved.
 */
const CLAIMS = { sub: 'user-1', roleId: 'role-1', permHash: 'hash-then' };

function storeKnowing(currentHash: string | null, currentRole: string | null) {
  const mget = vi.fn().mockResolvedValue([currentHash, currentRole]);
  const redis = { client: { mget } } as unknown as RedisService;
  return { store: new PermissionStateStore(redis), mget };
}

describe('PermissionStateStore.isStale', () => {
  it('is not stale when Redis knows nothing about the role or the user', async () => {
    const { store } = storeKnowing(null, null);

    await expect(store.isStale(CLAIMS)).resolves.toBe(false);
  });

  it('is not stale when the fingerprint and the role both still match', async () => {
    const { store } = storeKnowing('hash-then', 'role-1');

    await expect(store.isStale(CLAIMS)).resolves.toBe(false);
  });

  it("is stale once the role's fingerprint has moved", async () => {
    const { store } = storeKnowing('hash-now', null);

    await expect(store.isStale(CLAIMS)).resolves.toBe(true);
  });

  it('is stale once the user holds another role, even if the old role is unchanged', async () => {
    // The case a per-role fingerprint alone cannot see: the user left the role.
    const { store } = storeKnowing('hash-then', 'role-2');

    await expect(store.isStale(CLAIMS)).resolves.toBe(true);
  });

  it('treats a token minted before fingerprints as stale only once one is known', async () => {
    const legacy = { sub: 'user-1', roleId: 'role-1' };

    await expect(storeKnowing(null, null).store.isStale(legacy)).resolves.toBe(false);
    await expect(storeKnowing('hash-now', null).store.isStale(legacy)).resolves.toBe(true);
  });

  it("reads the role's key and the user's key, in one round trip", async () => {
    const { store, mget } = storeKnowing(null, null);

    await store.isStale(CLAIMS);

    expect(mget).toHaveBeenCalledTimes(1);
    expect(mget).toHaveBeenCalledWith('role:role-1:permissions', 'user:user-1:role');
  });
});
