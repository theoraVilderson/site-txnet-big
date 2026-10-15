/**
 * An admin's freeze is hard or soft (F-0401-d, catalog F-0401): hard — the
 * default, today's freeze — only an admin lifts; soft the user may lift
 * themselves. What breaks without anyone seeing it:
 *
 *  - **a body without `mode` changes meaning.** Absent is hard, single and
 *    bulk, so every caller from before this row freezes exactly as it did;
 *  - **an admin hands out a `self` freeze.** Only hard or soft is accepted —
 *    self is the user's own act, counted against their daily three;
 *  - **a mode change moves the clock or the configs.** Changing the mode of a
 *    frozen Grant writes the mode alone, conditional on the mode it read;
 *  - **the user cannot tell whether to wait for support.** The freeze notice,
 *    and the notice of a mode change, end with one line that says it;
 *  - **the page keeps the old state.** Every freeze act also writes the live
 *    event the owner's My services re-reads on (C-14).
 */
import { FreezeMode, GrantStatus } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

import { ADMIN_FROZEN, setFreezeMode } from '../../entitlement/freeze';
import { EntitlementRefused } from '../../entitlement/grant';
import { auditedGrantAct, type GrantAuditAction } from '../../grant-audit/grant-audit';
import { grantBulkSchema } from './grant-bulk.schema';
import { grantBulkJobSchema } from './grant-bulk-job.schema';
import { grantFreezeModeSchema, grantFreezeSchema } from './grant-freeze.schema';

const TENANT = '22222222-2222-4222-8222-222222222222';
const GRANT = '99999999-9999-4999-8999-999999999999';
const OWNER = '66666666-6666-4666-8666-666666666666';
const REQUEST = '77777777-7777-4777-8777-777777777777';
const actor = { userId: '44444444-4444-4444-8444-444444444444', ip: '203.0.113.7' };

describe('the freeze bodies take a mode', () => {
  it('single: hard or soft, absent left to the act (hard); self or anything else refused', () => {
    expect(grantFreezeSchema.parse({}).mode).toBeUndefined();
    expect(grantFreezeSchema.parse({ mode: 'soft' }).mode).toBe(FreezeMode.soft);
    expect(grantFreezeSchema.parse({ mode: 'hard' }).mode).toBe(FreezeMode.hard);
    for (const mode of ['self', 'soft ', 'HARD', 1]) expect(grantFreezeSchema.safeParse({ mode }).success).toBe(false);
  });

  it('bulk by id and by filter carry it on a freeze, and only there', () => {
    const byId = { requestId: REQUEST, action: 'freeze', grantIds: [GRANT], reason: 'abuse report', mode: 'soft' };
    expect(grantBulkSchema.parse(byId)).toMatchObject({ mode: FreezeMode.soft });
    const { grantIds: _ids, ...rest } = byId;
    expect(grantBulkJobSchema.parse({ ...rest, filter: {} })).toMatchObject({ mode: FreezeMode.soft });
    expect(grantBulkSchema.safeParse({ ...byId, action: 'unfreeze' }).success).toBe(false);
    expect(grantBulkSchema.safeParse({ ...byId, mode: 'self' }).success).toBe(false);
  });

  it('a mode change names the mode it sets, hard or soft, with an optional reason', () => {
    expect(grantFreezeModeSchema.parse({ mode: 'soft', reason: 'paid back' })).toEqual({ mode: FreezeMode.soft, reason: 'paid back' });
    expect(grantFreezeModeSchema.safeParse({}).success).toBe(false);
    expect(grantFreezeModeSchema.safeParse({ mode: 'self' }).success).toBe(false);
  });
});

type Row = { status: GrantStatus; statusReason: string | null; freezeMode: FreezeMode | null; frozenUntil: Date | null; endsAt: Date | null };

function grantTx(row: Partial<Row>) {
  const grant: Row = { status: GrantStatus.suspended, statusReason: ADMIN_FROZEN, freezeMode: FreezeMode.hard, frozenUntil: null, endsAt: new Date('2026-11-01T00:00:00Z'), ...row };
  const writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const tx = {
    grant: {
      findFirst: async () => ({ ...grant }),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        writes.push({ where, data });
        if (where.freezeMode !== grant.freezeMode) return { count: 0 };
        Object.assign(grant, data);
        return { count: 1 };
      },
    },
  };
  return { tx: tx as never, grant, writes };
}

const refusal = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(EntitlementRefused);
  return (e as EntitlementRefused).reason;
};

describe('setFreezeMode', () => {
  it('turns a hard freeze soft and back, the mode alone, conditional on the one it read', async () => {
    const { tx, grant, writes } = grantTx({});
    await expect(setFreezeMode(tx, GRANT, FreezeMode.soft)).resolves.toEqual({ freezeModeBefore: FreezeMode.hard, freezeMode: FreezeMode.soft });
    expect(writes[0]).toEqual({ where: { id: GRANT, status: GrantStatus.suspended, statusReason: ADMIN_FROZEN, freezeMode: FreezeMode.hard }, data: { freezeMode: FreezeMode.soft } });
    expect(grant.endsAt).toEqual(new Date('2026-11-01T00:00:00Z'));

    await expect(setFreezeMode(tx, GRANT, FreezeMode.hard)).resolves.toEqual({ freezeModeBefore: FreezeMode.soft, freezeMode: FreezeMode.hard });
  });

  it("takes a user's own freeze over too", async () => {
    const { tx, grant } = grantTx({ freezeMode: FreezeMode.self });
    await setFreezeMode(tx, GRANT, FreezeMode.soft);
    expect(grant.freezeMode).toBe(FreezeMode.soft);
  });

  it('refuses a Grant not frozen, the mode it already has, and a mode changed in between', async () => {
    expect(await refusal(setFreezeMode(grantTx({ status: GrantStatus.active, statusReason: null, freezeMode: null }).tx, GRANT, FreezeMode.soft))).toBe('grant_not_frozen');
    expect(await refusal(setFreezeMode(grantTx({}).tx, GRANT, FreezeMode.hard))).toBe('freeze_mode_unchanged');

    const raced = grantTx({});
    const findFirst = raced.tx as unknown as { grant: { findFirst: () => Promise<Row> } };
    const read = await findFirst.grant.findFirst();
    findFirst.grant.findFirst = async () => ({ ...read, freezeMode: FreezeMode.self });
    expect(await refusal(setFreezeMode(raced.tx, GRANT, FreezeMode.soft))).toBe('grant_moved');
  });
});

/** An admin's freeze act, audited and told: the rows it writes to the outbox. */
async function told(action: GrantAuditAction, result: unknown) {
  const outbox: Array<Record<string, unknown>> = [];
  const tx = {
    grant: { findUnique: async ({ select }: { select: Record<string, unknown> }) => (select.userId ? { userId: OWNER } : { status: 'suspended' }) },
    adminAuditLog: { create: async () => ({ id: 'audit-1' }) },
    outboxEvent: { create: async ({ data }: { data: Record<string, unknown> }) => (outbox.push(data), { id: 'o' }) },
  };
  await auditedGrantAct(tx as never, actor, TENANT, GRANT, { action, reason: null, outcome: (r) => r }, async () => result);
  return outbox;
}

const payload = (params: Record<string, string>) => ({ tenantId: TENANT, userId: OWNER, grantId: GRANT, period: 'audit-1', ...params });
const liveRead = { aggregate: 'entitlement.grant', aggregateId: GRANT, type: OutboxEventType.GRANT_FREEZE_CHANGED, payload: { tenantId: TENANT, userId: OWNER, grantId: GRANT } };

describe("the user's notice says who may unfreeze it", () => {
  it('a hard freeze: support; a soft one: the user — and the page re-reads either way', async () => {
    expect(await told('grant_freeze', { frozenUntil: null, configsDisabled: 2, freezeMode: FreezeMode.hard })).toEqual([
      expect.objectContaining({ type: OutboxEventType.GRANT_ADMIN_FROZEN, payload: payload({ supportUnfreeze: 'yes' }) }),
      liveRead,
    ]);
    expect(await told('grant_freeze', { frozenUntil: null, configsDisabled: 2, freezeMode: FreezeMode.soft })).toEqual([
      expect.objectContaining({ type: OutboxEventType.GRANT_ADMIN_FROZEN, payload: payload({ selfUnfreeze: 'yes' }) }),
      liveRead,
    ]);
  });

  it('a mode change is told as the freeze it now is', async () => {
    expect(await told('grant_freeze_mode_set', { freezeModeBefore: FreezeMode.hard, freezeMode: FreezeMode.soft })).toEqual([
      expect.objectContaining({ type: OutboxEventType.GRANT_ADMIN_FROZEN, payload: payload({ selfUnfreeze: 'yes' }) }),
      liveRead,
    ]);
  });

  it('an unfreeze re-reads the page too; an act that is not a freeze does not', async () => {
    expect((await told('grant_unfreeze', { endsAt: null, configsRestored: 2 })).map((r) => r.type)).toEqual([OutboxEventType.GRANT_ADMIN_UNFROZEN, OutboxEventType.GRANT_FREEZE_CHANGED]);
    expect((await told('grant_link_rotate', 'https://sub.acme.test/sub/x')).map((r) => r.type)).toEqual([OutboxEventType.GRANT_ADMIN_LINK_ROTATED]);
  });
});
