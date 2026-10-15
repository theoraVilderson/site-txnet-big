/**
 * The user freezes and unfreezes their own service (F-0401-c, catalog F-0401):
 * `POST /api/billing/gift/grants/:grantId/freeze` and `…/unfreeze`.
 *
 * What breaks without anyone seeing it:
 *  - **a prepaid package frozen by its user.** It would buy free days, so only
 *    a metered Grant is frozen this way; an admin's soft freeze is another path;
 *  - **the reseller's switch ignored.** Off, the freeze is refused; the clock
 *    the reseller chose is copied onto the Grant at the freeze;
 *  - **a fourth freeze in 24 hours let through.** The count is the Grant's own
 *    `grant_self_freeze` audit rows over a sliding day, under the Grant's lock;
 *  - **an admin's freeze lifted by the user.** Hard is support's; soft and
 *    self are the user's — and an unfreeze still works after the reseller
 *    turned self-freeze off, so nobody is trapped frozen;
 *  - **the act unrecorded, or told.** Each one writes an audit row as the user,
 *    and no notice — the user did it — only the live event the page re-reads on.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import { AuditTargetType, FreezeMode, GrantStatus, VariantBillingMode } from '@prisma/client';
import { BackendI18nKeys, OutboxEventType, runWithTenant } from '@txnet-backend/shared-core';

import { ADMIN_FROZEN } from '../../entitlement/freeze';
import { SELF_FREEZES_PER_DAY } from '../../entitlement/self-freeze';
import { OwnFreezeService } from './own-freeze.service';

const E = BackendI18nKeys.errors.billing.grant;
const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const GRANT = '22222222-2222-4222-8222-222222222222';
const IP = '203.0.113.7';
const DAY = 86_400_000;
/** The service reads the real clock, so counted rows are placed against it. */
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

type Settings = { selfFreezeEnabled: boolean; selfFreezeStopsClock: boolean };
type GrantRow = {
  id: string;
  userId: string;
  status: GrantStatus;
  statusReason: string | null;
  suspendedAt: Date | null;
  endsAt: Date | null;
  frozenUntil: Date | null;
  freezeMode: FreezeMode | null;
  freezeStopsClock: boolean | null;
  awaitingPanel: boolean;
};

function build(opts: { owner?: string; billingMode?: VariantBillingMode; settings?: Settings; recent?: Date[]; grant?: Partial<GrantRow> } = {}) {
  const grant: GrantRow = {
    id: GRANT,
    userId: opts.owner ?? USER,
    status: GrantStatus.active,
    statusReason: null,
    suspendedAt: null,
    endsAt: new Date(Date.now() + 20 * DAY),
    frozenUntil: null,
    freezeMode: null,
    freezeStopsClock: null,
    awaitingPanel: false,
    ...opts.grant,
  };
  const audits: Array<Record<string, unknown>> = [];
  const outbox: Array<Record<string, unknown>> = [];
  const counted: Array<Record<string, unknown>> = [];
  const matches = (where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      const have = (grant as Record<string, unknown>)[k];
      return v instanceof Date || have instanceof Date ? (v as Date | null)?.getTime() === (have as Date | null)?.getTime() : have === v;
    });
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [{ userId: grant.userId, tenantId: TENANT, billingMode: opts.billingMode ?? VariantBillingMode.metered }],
    grantFreezeSetting: { findUnique: async () => opts.settings ?? null },
    adminAuditLog: {
      findMany: async ({ where }: { where: Record<string, unknown> & { createdAt: { gt: Date } } }) => {
        counted.push(where);
        return (opts.recent ?? []).filter((d) => d > where.createdAt.gt).map((createdAt) => ({ createdAt }));
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return { id: `audit-${audits.length}` };
      },
    },
    grant: {
      findFirst: async ({ where }: { where: { id: string } }) => (where.id === GRANT ? { ...grant } : null),
      // The reserve (vpn-reserve.spec.ts holds it) asks for the billing mode: nothing reserved here.
      findUnique: async ({ select }: { select: Record<string, unknown> }) => (select.billingMode ? null : { ...grant }),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!matches(where)) return { count: 0 };
        Object.assign(grant, data);
        return { count: 1 };
      },
    },
    config: { updateMany: async () => ({ count: 2 }) },
    outboxEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        outbox.push(data);
        return { id: `event-${outbox.length}` };
      },
    },
  };
  const prisma = { $transaction: (fn: (t: unknown) => unknown) => fn(tx) };
  const service = new OwnFreezeService(prisma as never);
  const actor = { userId: USER, ip: IP };
  const inTenant = <R>(fn: () => Promise<R>) => runWithTenant({ id: TENANT }, fn);
  return { grant, audits, outbox, counted, freeze: () => inTenant(() => service.freeze(actor, GRANT)), unfreeze: () => inTenant(() => service.unfreeze(actor, GRANT)) };
}

const refused = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(HttpException);
  return { status: (e as HttpException).getStatus(), body: (e as HttpException).getResponse() as Record<string, unknown> };
};

const SELF_FROZEN = { status: GrantStatus.suspended, statusReason: ADMIN_FROZEN, suspendedAt: hoursAgo(5), freezeMode: FreezeMode.self, freezeStopsClock: false };

describe('OwnFreezeService.freeze', () => {
  it('freezes a metered Grant as `self`, its clock running by default, audited as the user and told to nobody', async () => {
    const { freeze, grant, audits, outbox } = build();
    await expect(freeze()).resolves.toEqual({ grantId: GRANT, freezeMode: FreezeMode.self, configsDisabled: 2 });
    expect(grant).toMatchObject({ status: GrantStatus.suspended, statusReason: ADMIN_FROZEN, freezeMode: FreezeMode.self, freezeStopsClock: false });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenantId: TENANT, adminId: USER, adminIpAddress: IP, action: 'grant_self_freeze', targetEntityType: AuditTargetType.grant, targetEntityId: GRANT });
    // Only the page's re-read: the user froze it, no notice says so.
    expect(outbox).toEqual([expect.objectContaining({ type: OutboxEventType.GRANT_FREEZE_CHANGED, payload: { tenantId: TENANT, userId: USER, grantId: GRANT } })]);
  });

  it("copies the reseller's clock onto the Grant at the freeze", async () => {
    const { freeze, grant } = build({ settings: { selfFreezeEnabled: true, selfFreezeStopsClock: true } });
    await freeze();
    expect(grant.freezeStopsClock).toBe(true);
  });

  it("counts only this Grant's own self-freezes of the last 24 hours, and refuses the fourth 429 with when the next is allowed", async () => {
    expect(SELF_FREEZES_PER_DAY).toBe(3);
    const ok = build({ recent: [hoursAgo(1), hoursAgo(2), hoursAgo(25)] });
    await ok.freeze();
    expect(ok.counted[0]).toMatchObject({ action: 'grant_self_freeze', targetEntityType: AuditTargetType.grant, targetEntityId: GRANT });
    expect(Date.now() - (ok.counted[0].createdAt as { gt: Date }).gt.getTime()).toBeGreaterThanOrEqual(DAY - 1000);

    const full = build({ recent: [hoursAgo(1), hoursAgo(3), hoursAgo(2)] });
    const { status, body } = await refused(full.freeze());
    expect(status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(body).toMatchObject({ i18nKey: E.selfFreezeLimited, reason: 'self_freeze_limit', facts: { limit: 3, nextAtMs: expect.any(Number) } });
    expect((body.facts as { nextAtMs: number }).nextAtMs).toBeCloseTo(hoursAgo(3 - 24).getTime(), -4);
    expect(full.grant.status).toBe(GrantStatus.active);
    expect(full.audits).toEqual([]);
    expect(full.outbox).toEqual([]);
  });

  it('refuses a prepaid Grant 409 and a reseller that turned it off 403, writing nothing', async () => {
    const prepaid = build({ billingMode: VariantBillingMode.prepaid });
    expect(await refused(prepaid.freeze())).toMatchObject({ status: 409, body: { i18nKey: E.selfFreezeNotMetered, reason: 'grant_not_metered' } });
    const off = build({ settings: { selfFreezeEnabled: false, selfFreezeStopsClock: false } });
    expect(await refused(off.freeze())).toMatchObject({ status: 403, body: { i18nKey: E.selfFreezeOff, reason: 'self_freeze_off' } });
    for (const { grant, audits, outbox } of [prepaid, off]) {
      expect(grant.status).toBe(GrantStatus.active);
      expect([...audits, ...outbox]).toEqual([]);
    }
  });

  it("is a 404 for another user's Grant, and a 409 for one already frozen", async () => {
    expect(await refused(build({ owner: OTHER }).freeze())).toMatchObject({ status: 404, body: { i18nKey: E.notFound } });
    const hard = build({ grant: { ...SELF_FROZEN, freezeMode: FreezeMode.hard } });
    expect(await refused(hard.freeze())).toMatchObject({ status: 409, body: { i18nKey: E.notFreezable, reason: 'grant_not_active' } });
    expect(hard.grant.freezeMode).toBe(FreezeMode.hard);
  });
});

describe('OwnFreezeService.unfreeze', () => {
  it('lifts its own freeze — and an admin’s soft one — audited as the user, the page told', async () => {
    for (const mode of [FreezeMode.self, FreezeMode.soft]) {
      const { unfreeze, grant, audits, outbox } = build({ grant: { ...SELF_FROZEN, freezeMode: mode } });
      await expect(unfreeze()).resolves.toMatchObject({ grantId: GRANT, configsRestored: 2 });
      expect(grant).toMatchObject({ status: GrantStatus.active, statusReason: null, freezeMode: null });
      expect(audits).toEqual([expect.objectContaining({ adminId: USER, action: 'grant_self_unfreeze', targetEntityId: GRANT })]);
      expect(outbox).toEqual([expect.objectContaining({ type: OutboxEventType.GRANT_FREEZE_CHANGED })]);
    }
  });

  it('still lifts it after the reseller turned self-freeze off: nobody is trapped frozen', async () => {
    const { unfreeze, grant } = build({ settings: { selfFreezeEnabled: false, selfFreezeStopsClock: false }, grant: SELF_FROZEN });
    await unfreeze();
    expect(grant.status).toBe(GrantStatus.active);
  });

  it("refuses a hard freeze and one waiting for a panel 403, a Grant not frozen 409, another user's 404", async () => {
    for (const grant of [{ ...SELF_FROZEN, freezeMode: FreezeMode.hard }, { ...SELF_FROZEN, freezeMode: FreezeMode.soft, awaitingPanel: true }]) {
      const built = build({ grant });
      expect(await refused(built.unfreeze())).toMatchObject({ status: 403, body: { i18nKey: E.freezeNotUsers, reason: 'freeze_not_users' } });
      expect(built.grant.status).toBe(GrantStatus.suspended);
      expect(built.audits).toEqual([]);
    }
    expect(await refused(build().unfreeze())).toMatchObject({ status: 409, body: { i18nKey: E.notFrozen, reason: 'grant_not_frozen' } });
    expect(await refused(build({ owner: OTHER, grant: SELF_FROZEN }).unfreeze())).toMatchObject({ status: 404 });
  });
});
