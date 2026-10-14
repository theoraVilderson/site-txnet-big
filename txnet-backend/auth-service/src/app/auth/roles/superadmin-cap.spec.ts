import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { WildcardHoldersWatch, wildcardRefusal } from './superadmin-cap';

// SA-1-a (user 2026-10-14): `*` stays, but rare — at most SUPERADMIN_MAX
// people hold it (default 2). Giving the SuperAdmin template past it is
// refused; holders over it are named in the log at boot.
type Holder = { id: string; username: string; deletedAt: Date | null };

/**
 * A transaction answering `findKeyHolders`' two reads (no group gives `*`, so
 * no member rows) and the boot check's name lookup.
 */
function txWith(holders: Holder[]) {
  type Where = { AND?: { id?: { not: string } }[]; id?: { in: string[] } };
  const findMany = vi.fn(async ({ where }: { where: Where }) => {
    if (where.id?.in) return holders.filter((h) => where.id?.in.includes(h.id)).map(({ id, username }) => ({ id, username }));
    const except = where.AND?.[0]?.id?.not;
    return holders.filter((h) => h.deletedAt === null && h.id !== except).map(({ id }) => ({ id }));
  });
  const tx = {
    user: { findMany },
    userGroupMember: { findMany: async () => [] },
    tenant: { findFirst: async () => ({ id: TENANT }) },
    $executeRaw: vi.fn(async () => 0),
  };
  return { tx: { ...tx, $transaction: (fn: (t: unknown) => unknown) => fn(tx) } as never, findMany };
}

const TENANT = 't-platform';
const OWNER: Holder = { id: 'u-owner', username: 'owner', deletedAt: null };
const SPARE: Holder = { id: 'u-spare', username: 'spare', deletedAt: null };

describe('wildcardRefusal', () => {
  it('lets a role without * through without counting anyone', async () => {
    const { tx, findMany } = txWith([OWNER, SPARE]);
    expect(await wildcardRefusal(tx, { roleKeys: ['user.read'], tenantId: TENANT, userId: 'u-new', max: 2 })).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('refuses the * role to a third person when two hold it', async () => {
    const { tx } = txWith([OWNER, SPARE]);
    expect(await wildcardRefusal(tx, { roleKeys: ['*'], tenantId: TENANT, userId: 'u-new', max: 2 })).toBe('superadmin_limit');
  });

  it('counts neither the person themselves nor a deleted holder', async () => {
    const { tx } = txWith([OWNER, SPARE, { id: 'u-gone', username: 'gone', deletedAt: new Date() }]);
    expect(await wildcardRefusal(tx, { roleKeys: ['*'], tenantId: TENANT, userId: 'u-spare', max: 2 })).toBeNull();
    expect(await wildcardRefusal(tx, { roleKeys: ['*'], tenantId: TENANT, userId: 'u-new', max: 3 })).toBeNull();
  });
});

describe('WildcardHoldersWatch', () => {
  it('names every holder in a warning when there are more than the cap, and says nothing otherwise', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const config = { get: () => '2' } as never;
    const over = txWith([OWNER, SPARE, { id: 'u-test', username: 'e2e_admin', deletedAt: null }]);
    await new WildcardHoldersWatch(over.tx, config).check();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('owner, spare, e2e_admin'));

    warn.mockClear();
    await new WildcardHoldersWatch(txWith([OWNER, SPARE]).tx, config).check();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
