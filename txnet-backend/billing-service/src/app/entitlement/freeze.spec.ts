/**
 * Freeze and unfreeze (F-311-h, spec F-311): an admin stops a user's service
 * and later lets it run again, with the time it stood still given back.
 * What would break quietly here, and nowhere else:
 *
 *  - **the clock stops.** Unfreeze moves `endsAt` forward by exactly the
 *    frozen span, so a 30-day plan frozen for ten days still serves 30; a
 *    permanent Grant stays permanent;
 *  - **a frozen Grant is kept, never purged** (user, 2026-09-27). Nothing is
 *    released from the panel, so unfreeze turns on the very configs the user
 *    already holds — the purge scan and its day-ahead notice skip it;
 *  - **only the admin unfreezes it.** `suspended` has two meanings: a top-up
 *    or a renewal lifts `quota_exhausted` alone, and this lifts `admin_frozen`
 *    alone — each write conditional on its own reason;
 *  - **a freeze may be timed.** `frozenUntil` set, the hourly sweep unfreezes
 *    it at that time, in its own tenant; unset, it waits for the admin;
 *  - **the write is conditional on what was read** — a renewal that moved the
 *    end in between is `grant_moved`, never an end shifted twice;
 *  - **a freeze has a mode** (F-0401-a): hard, soft or self, and whether the
 *    clock stopped, both fixed at the freeze. Hard beats soft beats self; the
 *    user lifts only soft or self, never a system freeze (`awaitingPanel`),
 *    and the end moves only for a freeze that stopped the clock.
 */
import { ConfigStatus, DesiredRemote, EnforcementState, FreezeMode, GrantStatus } from '@prisma/client';
import { TenantContext } from '@txnet-backend/shared-core';

import { ADMIN_FROZEN, freezeGrant, freezeModeBeats, GrantUnfreezeService, unfreezeGrant, unfreezeOwnGrant, userMayUnfreeze } from './freeze';
import { EntitlementRefused } from './grant';
import { GrantPurgeService } from './purge';
import { GrantPurgeNoticeService } from './purge-notice';
import { QUOTA_EXHAUSTED } from './suspension';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const GRANT = '99999999-9999-4999-8999-999999999991';
const GRANT_2 = '99999999-9999-4999-8999-999999999992';
const DAY = 86_400_000;
/** Every freeze from before F-0401-a reads this way (the migration's backfill). */
const HARD = { freezeMode: FreezeMode.hard, freezeStopsClock: true };

type Row = {
  id: string;
  status: GrantStatus;
  statusReason: string | null;
  suspendedAt: Date | null;
  endsAt: Date | null;
  frozenUntil: Date | null;
  freezeMode: FreezeMode | null;
  freezeStopsClock: boolean | null;
  awaitingPanel: boolean;
};

type Write = { where: Record<string, unknown>; data: Record<string, unknown>; tenant: string | null };

function build(row: Partial<Row> | null) {
  const grant: Row | null = row
    ? { id: GRANT, status: GrantStatus.active, statusReason: null, suspendedAt: null, endsAt: null, frozenUntil: null, freezeMode: null, freezeStopsClock: null, awaitingPanel: false, ...row }
    : null;
  const grants: Write[] = [];
  const configs: Write[] = [];
  const tenant = () => TenantContext.currentOrNull()?.id ?? null;
  const matches = (where: Record<string, unknown>) =>
    !!grant && Object.entries(where).every(([k, v]) => {
      const have = (grant as Record<string, unknown>)[k];
      return v instanceof Date || have instanceof Date ? (v as Date | null)?.getTime() === (have as Date | null)?.getTime() : have === v;
    });
  const tx = {
    $executeRaw: async () => 0,
    grant: {
      findFirst: async ({ where }: { where: { id: string } }) => (grant && where.id === grant.id ? { ...grant } : null),
      // The reserve release (F-118-b) reads the Grant; vpn-reserve.spec.ts holds it.
      findUnique: async () => null,
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        grants.push({ where, data, tenant: tenant() });
        if (!matches(where)) return { count: 0 };
        Object.assign(grant as Row, data);
        return { count: 1 };
      },
    },
    config: {
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        configs.push({ where, data, tenant: tenant() });
        return { count: 2 };
      },
    },
  };
  return { tx: tx as never, grant, grants, configs };
}

const refusal = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(EntitlementRefused);
  return (e as EntitlementRefused).reason;
};

describe('freezeGrant', () => {
  const at = new Date('2026-09-27T10:00:00Z');

  it('suspends an active Grant as frozen, stamps the clock and turns every config off', async () => {
    const { tx, grant, grants, configs } = build({ endsAt: new Date(at.getTime() + 20 * DAY) });

    const result = await freezeGrant(tx, GRANT, { at });

    expect(result).toEqual({ frozenUntil: null, configsDisabled: 2 });
    expect(grant).toMatchObject({ status: GrantStatus.suspended, statusReason: ADMIN_FROZEN, suspendedAt: at, frozenUntil: null });
    // An admin's freeze with no mode is today's: hard, clock stopped (F-0401-a).
    expect(grant).toMatchObject({ freezeMode: FreezeMode.hard, freezeStopsClock: true });
    // Conditional on `active`: a Grant that moved on is left where it is.
    expect(grants[0].where).toMatchObject({ id: GRANT, status: GrantStatus.active });
    // Desired state only — the panel keeps the client, turned off.
    expect(configs).toEqual([{ where: { grantId: GRANT, desiredEnabled: true }, data: { desiredEnabled: false }, tenant: null }]);
  });

  it('keeps the time it unfreezes itself at', async () => {
    const until = new Date(at.getTime() + 10 * DAY);
    const { tx, grant } = build({});

    expect(await freezeGrant(tx, GRANT, { at, until })).toMatchObject({ frozenUntil: until });
    expect(grant?.frozenUntil).toEqual(until);
  });

  it('refuses an unfreeze time that is not in the future, writing nothing', async () => {
    const { tx, grants } = build({});
    expect(await refusal(freezeGrant(tx, GRANT, { at, until: at }))).toBe('freeze_until_not_future');
    expect(grants).toHaveLength(0);
  });

  it('refuses a Grant that is not active — an exhausted one stays the top-up’s to revive', async () => {
    const exhausted = build({ status: GrantStatus.suspended, statusReason: QUOTA_EXHAUSTED, suspendedAt: at });
    expect(await refusal(freezeGrant(exhausted.tx, GRANT, { at }))).toBe('grant_not_active');
    expect(exhausted.configs).toHaveLength(0);

    expect(await refusal(freezeGrant(build(null).tx, GRANT, { at }))).toBe('grant_not_found');
  });
});

describe('unfreezeGrant', () => {
  const frozenAt = new Date('2026-09-01T10:00:00Z');
  const at = new Date('2026-09-11T10:00:00Z'); // ten days frozen

  it('gives the frozen time back to the end and turns the same configs on again', async () => {
    const endsAt = new Date('2026-09-20T10:00:00Z');
    const { tx, grant, grants, configs } = build({ status: GrantStatus.suspended, statusReason: ADMIN_FROZEN, suspendedAt: frozenAt, endsAt, frozenUntil: at, ...HARD });

    const result = await unfreezeGrant(tx, GRANT, at);

    expect(result).toEqual({ endsAt: new Date('2026-09-30T10:00:00Z'), configsRestored: 2 });
    expect(grant).toMatchObject({ status: GrantStatus.active, statusReason: null, suspendedAt: null, frozenUntil: null, endsAt: result.endsAt });
    // Conditional on the reason and on the clock and end it read.
    expect(grants[0].where).toMatchObject({ id: GRANT, status: GrantStatus.suspended, statusReason: ADMIN_FROZEN, suspendedAt: frozenAt, endsAt });
    // A retired config stays gone, and an admin-disabled one waits for its admin.
    expect(configs[0].where).toEqual({ grantId: GRANT, status: ConfigStatus.active });
    expect(configs[0].data).toEqual({ desiredEnabled: true, desiredRemote: DesiredRemote.present, enforcementState: EnforcementState.pending });
  });

  it('leaves a permanent Grant permanent', async () => {
    const { tx, grant } = build({ status: GrantStatus.suspended, statusReason: ADMIN_FROZEN, suspendedAt: frozenAt, endsAt: null, ...HARD });
    expect((await unfreezeGrant(tx, GRANT, at)).endsAt).toBeNull();
    expect(grant?.endsAt).toBeNull();
  });

  it('never lifts a suspension for quota — that is the top-up’s', async () => {
    const { tx, configs } = build({ status: GrantStatus.suspended, statusReason: QUOTA_EXHAUSTED, suspendedAt: frozenAt });
    expect(await refusal(unfreezeGrant(tx, GRANT, at))).toBe('grant_not_frozen');
    expect(configs).toHaveLength(0);
    expect(await refusal(unfreezeGrant(build({}).tx, GRANT, at))).toBe('grant_not_frozen');
  });

  it('is grant_moved when the end changed between the read and the write', async () => {
    const built = build({ status: GrantStatus.suspended, statusReason: ADMIN_FROZEN, suspendedAt: frozenAt, endsAt: new Date('2026-09-20T10:00:00Z'), ...HARD });
    const read = built.tx as unknown as { grant: { findFirst: (a: unknown) => Promise<Row> } };
    const original = read.grant.findFirst;
    // A renewal lands after the read.
    read.grant.findFirst = async (a) => {
      const r = await original(a);
      (built.grant as Row).endsAt = new Date('2026-10-20T10:00:00Z');
      return r;
    };
    expect(await refusal(unfreezeGrant(built.tx, GRANT, at))).toBe('grant_moved');
    expect(built.configs).toHaveLength(0);
  });
});

describe('a freeze has a mode (F-0401-a)', () => {
  const frozenAt = new Date('2026-09-01T10:00:00Z');
  const at = new Date('2026-09-11T10:00:00Z'); // ten days frozen
  const endsAt = new Date('2026-09-20T10:00:00Z');
  const frozen = (mode: FreezeMode, more: Partial<Row> = {}) =>
    build({ status: GrantStatus.suspended, statusReason: ADMIN_FROZEN, suspendedAt: frozenAt, endsAt, freezeMode: mode, freezeStopsClock: true, ...more });

  it('ranks hard over soft over self', () => {
    expect(freezeModeBeats(FreezeMode.hard, FreezeMode.soft)).toBe(true);
    expect(freezeModeBeats(FreezeMode.soft, FreezeMode.self)).toBe(true);
    expect(freezeModeBeats(FreezeMode.self, FreezeMode.soft)).toBe(false);
    expect(freezeModeBeats(FreezeMode.soft, FreezeMode.soft)).toBe(false);
  });

  it('fixes the mode and the clock on the Grant at the freeze', async () => {
    const { tx, grant } = build({});
    await freezeGrant(tx, GRANT, { at: frozenAt, mode: FreezeMode.self, stopsClock: false });
    expect(grant).toMatchObject({ status: GrantStatus.suspended, freezeMode: FreezeMode.self, freezeStopsClock: false });
  });

  it('raises a weaker freeze in place: the clock it started with and its configs untouched', async () => {
    const { tx, grant, grants, configs } = frozen(FreezeMode.self, { freezeStopsClock: false });
    const result = await freezeGrant(tx, GRANT, { at, mode: FreezeMode.hard });
    expect(result).toEqual({ frozenUntil: null, configsDisabled: 0 });
    expect(grant).toMatchObject({ freezeMode: FreezeMode.hard, freezeStopsClock: false, suspendedAt: frozenAt });
    // Conditional on the mode it read: two raises at once land one.
    expect(grants[0].where).toMatchObject({ id: GRANT, status: GrantStatus.suspended, statusReason: ADMIN_FROZEN, freezeMode: FreezeMode.self });
    expect(configs).toHaveLength(0);
  });

  it('refuses a freeze that does not beat the one in place', async () => {
    expect(await refusal(freezeGrant(frozen(FreezeMode.hard).tx, GRANT, { at, mode: FreezeMode.soft }))).toBe('grant_not_active');
    expect(await refusal(freezeGrant(frozen(FreezeMode.soft).tx, GRANT, { at, mode: FreezeMode.self }))).toBe('grant_not_active');
    expect(await refusal(freezeGrant(frozen(FreezeMode.soft).tx, GRANT, { at, mode: FreezeMode.soft }))).toBe('grant_not_active');
  });

  it('moves the end only when the clock stopped', async () => {
    const { tx, grant } = frozen(FreezeMode.self, { freezeStopsClock: false });
    expect((await unfreezeGrant(tx, GRANT, at)).endsAt).toEqual(endsAt);
    expect(grant).toMatchObject({ status: GrantStatus.active, endsAt, freezeMode: null, freezeStopsClock: null });
  });

  it('lets the user lift a soft or self freeze, conditional on what made it theirs', async () => {
    for (const mode of [FreezeMode.soft, FreezeMode.self]) {
      const { tx, grant, grants } = frozen(mode);
      expect(await unfreezeOwnGrant(tx, GRANT, at)).toEqual({ endsAt: new Date('2026-09-30T10:00:00Z'), configsRestored: 2 });
      expect(grant?.status).toBe(GrantStatus.active);
      // An admin who hardened it, or an evict that left it waiting, in between: the write misses.
      expect(grants[0].where).toMatchObject({ freezeMode: mode, awaitingPanel: false });
    }
  });

  it('never lets the user lift a hard freeze or a system one', async () => {
    const hard = frozen(FreezeMode.hard);
    expect(await refusal(unfreezeOwnGrant(hard.tx, GRANT, at))).toBe('freeze_not_users');
    expect(hard.grants).toHaveLength(0);

    const waiting = frozen(FreezeMode.soft, { awaitingPanel: true });
    expect(await refusal(unfreezeOwnGrant(waiting.tx, GRANT, at))).toBe('freeze_not_users');
    expect(await refusal(unfreezeOwnGrant(build({}).tx, GRANT, at))).toBe('grant_not_frozen');

    expect(userMayUnfreeze({ freezeMode: FreezeMode.self, awaitingPanel: false })).toBe(true);
    expect(userMayUnfreeze({ freezeMode: FreezeMode.hard, awaitingPanel: false })).toBe(false);
    expect(userMayUnfreeze({ freezeMode: null, awaitingPanel: false })).toBe(false);
  });

  it('lets the admin lift any freeze, a system one included', async () => {
    const { tx, grant } = frozen(FreezeMode.hard, { awaitingPanel: true });
    await unfreezeGrant(tx, GRANT, at);
    expect(grant?.status).toBe(GrantStatus.active);
  });
});

describe('GrantUnfreezeService.unfreezeDue', () => {
  it('unfreezes every timed freeze that is due, each in its own tenant', async () => {
    const now = new Date('2026-09-27T10:00:00Z');
    const scans: unknown[][] = [];
    const tenantsSeen: Array<string | null> = [];
    const built = build({ status: GrantStatus.suspended, statusReason: ADMIN_FROZEN, suspendedAt: new Date(now.getTime() - DAY), frozenUntil: now, ...HARD });
    const tx = built.tx as unknown as { grant: { findFirst: (a: { where: { id: string } }) => Promise<unknown> } };
    const find = tx.grant.findFirst;
    tx.grant.findFirst = async (a) => {
      tenantsSeen.push(TenantContext.currentOrNull()?.id ?? null);
      return find(a);
    };
    const prisma = { $transaction: (fn: (t: unknown) => unknown) => fn(built.tx) };
    const crossTenant = {
      $queryRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => {
        scans.push([sql.join('?'), ...values]);
        return [
          { id: GRANT, tenantId: TENANT_A },
          // Not frozen by the time its turn comes: skipped, not a failed sweep.
          { id: GRANT_2, tenantId: TENANT_B },
        ];
      },
    };
    const service = new GrantUnfreezeService(prisma as never, crossTenant as never, { get: () => 50 } as never);

    const result = await service.unfreezeDue(now);

    expect(result).toEqual({ scanned: 2, unfrozen: 1 });
    expect(tenantsSeen).toEqual([TENANT_A, TENANT_B]);
    expect(scans[0]).toEqual(expect.arrayContaining([ADMIN_FROZEN, now, 50]));
    expect(String(scans[0][0])).toContain('"frozenUntil" <=');
  });
});

describe('a frozen Grant is kept', () => {
  it('is never picked by the purge scan nor told its purge is near', async () => {
    const seen: unknown[][] = [];
    const crossTenant = {
      $queryRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => {
        seen.push([sql.join('?'), ...values]);
        return [];
      },
    };
    const config = { get: () => 50 };
    await new GrantPurgeService({} as never, crossTenant as never, config as never).purgeDue();
    await new GrantPurgeNoticeService({} as never, crossTenant as never, config as never).noticeDue();

    expect(seen).toHaveLength(2);
    for (const scan of seen) {
      expect(String(scan[0])).toContain('"statusReason" IS DISTINCT FROM');
      expect(scan).toContain(ADMIN_FROZEN);
    }
  });
});
