/**
 * "Reset link" on the owner's path, at most 3 times per Grant per 24 hours
 * (F-114-e-d). The per-user bucket (5 per 15 minutes) read as unlimited —
 * 480 a day — and every reset breaks the link in every app that holds it.
 *
 * What breaks without anyone seeing it:
 *  - **a fourth reset let through.** The count is per Grant over a sliding
 *    24 hours, taken under the Grant's row lock, so two resets at once cannot
 *    both see room for the third;
 *  - **a refusal with no "when".** It carries the moment the oldest of the
 *    three leaves the window, as a number the panel can print;
 *  - **someone else's reset spent.** Ownership is decided before anything is
 *    counted or written: another user's Grant is the same 404 as a missing one;
 *  - **staff and resellers bounded.** Only the owner's path counts or is
 *    refused; an admin's reset writes no row here.
 */
import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { BackendI18nKeys, runWithTenant } from '@txnet-backend/shared-core';

import { SubscriptionLinkService } from '../payment/gift/subscription-link.service';
import { EntitlementRefused } from './grant';
import { assertOwnerResetRoom, LINK_RESET_WINDOW_MS, LinkResetLimited, nextOwnerResetAt, OWNER_LINK_RESETS_PER_DAY } from './link-reset';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const GRANT = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-09-30T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
/** `resetOwn` / `reset` read the real clock, so their rows are placed against it — pinned to NOW they fell out of the 24 hours on 2026-10-01. */
const realHoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

function fakeTx(opts: { owner?: string | null; recent?: Date[] }) {
  const calls: string[] = [];
  const written: Array<Record<string, unknown>> = [];
  let since: Date | undefined;
  const tx = {
    $queryRaw: vi.fn(async () => {
      calls.push('lock');
      return opts.owner === null ? [] : [{ userId: opts.owner ?? USER, tenantId: TENANT }];
    }),
    grantLinkReset: {
      findMany: vi.fn(async (args: { where: { createdAt: { gt: Date } } }) => {
        calls.push('count');
        since = args.where.createdAt.gt;
        return (opts.recent ?? []).filter((d) => d > since!).map((createdAt) => ({ createdAt }));
      }),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        calls.push('record');
        written.push(args.data);
        return args.data;
      }),
    },
    tenantDomain: { findMany: async () => [{ domainValue: 'sub.example.com', domainType: 'custom_domain' }] },
    $executeRaw: async () => 0,
  };
  return { tx, calls, written, since: () => since };
}

describe('nextOwnerResetAt', () => {
  it('is null while fewer than 3 resets fall in the last 24 hours', () => {
    expect(OWNER_LINK_RESETS_PER_DAY).toBe(3);
    expect(LINK_RESET_WINDOW_MS).toBe(24 * 3_600_000);
    expect(nextOwnerResetAt([], NOW)).toBeNull();
    expect(nextOwnerResetAt([hoursAgo(1), hoursAgo(2)], NOW)).toBeNull();
    // One of the three is older than the window: it no longer counts.
    expect(nextOwnerResetAt([hoursAgo(1), hoursAgo(2), hoursAgo(25)], NOW)).toBeNull();
  });

  it('with 3 in the window, is when the oldest of them leaves it', () => {
    expect(nextOwnerResetAt([hoursAgo(1), hoursAgo(20), hoursAgo(5)], NOW)).toEqual(hoursAgo(20 - 24));
  });
});

describe('assertOwnerResetRoom', () => {
  it('locks the Grant, then counts only the last 24 hours, and answers its tenant', async () => {
    const { tx, calls, since } = fakeTx({ recent: [hoursAgo(1)] });
    await expect(assertOwnerResetRoom(tx as never, GRANT, USER, NOW)).resolves.toBe(TENANT);
    expect(calls).toEqual(['lock', 'count']);
    expect(since()).toEqual(hoursAgo(24));
  });

  it('refuses the fourth with the moment the next is allowed', async () => {
    const { tx } = fakeTx({ recent: [hoursAgo(1), hoursAgo(2), hoursAgo(3)] });
    const err = await assertOwnerResetRoom(tx as never, GRANT, USER, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinkResetLimited);
    expect((err as LinkResetLimited).reason).toBe('link_reset_limit');
    expect((err as LinkResetLimited).limit).toBe(3);
    expect((err as LinkResetLimited).nextAt).toEqual(hoursAgo(3 - 24));
  });

  it("decides another user's Grant, and a missing one, before counting anything", async () => {
    for (const owner of [OTHER, null]) {
      const { tx, calls } = fakeTx({ owner, recent: [hoursAgo(1), hoursAgo(2), hoursAgo(3)] });
      const err = await assertOwnerResetRoom(tx as never, GRANT, USER, NOW).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EntitlementRefused);
      expect((err as EntitlementRefused).reason).toBe('grant_not_found');
      expect(calls).toEqual(['lock']);
    }
  });
});

describe('SubscriptionLinkService.resetOwn', () => {
  function build(opts: { owner?: string | null; recent?: Date[] }) {
    const fake = fakeTx(opts);
    const prisma = { $transaction: (fn: (t: unknown) => unknown) => fn(fake.tx) };
    const grants = {
      rotateToken: vi.fn(async () => {
        fake.calls.push('rotate');
        return 'tok-0002';
      }),
    };
    const links = new SubscriptionLinkService(prisma as never, grants as never);
    const inTenant = <R>(fn: () => Promise<R>) => runWithTenant({ id: TENANT }, fn);
    return { ...fake, links, grants, inTenant };
  }

  it('rotates, then records the reset in the same transaction', async () => {
    const { links, inTenant, calls, written } = build({ recent: [hoursAgo(1), hoursAgo(2)] });
    await expect(inTenant(() => links.resetOwn(GRANT, USER))).resolves.toBe('https://sub.example.com/sub/tok-0002');
    expect(calls).toEqual(['lock', 'count', 'rotate', 'record']);
    expect(written).toEqual([{ tenantId: TENANT, grantId: GRANT }]);
  });

  it('answers the fourth 429 link_reset_limit with {limit, nextAtMs}, and the old link keeps working', async () => {
    const { links, inTenant, grants, written } = build({ recent: [realHoursAgo(1), realHoursAgo(2), realHoursAgo(3)] });
    const err = await inTenant(() => links.resetOwn(GRANT, USER)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect((err as HttpException).getResponse()).toMatchObject({
      i18nKey: BackendI18nKeys.errors.billing.grant.linkResetLimited,
      reason: 'link_reset_limit',
      facts: { limit: 3, nextAtMs: expect.any(Number) },
    });
    expect(grants.rotateToken).not.toHaveBeenCalled();
    expect(written).toEqual([]);
  });

  it("is a 404 for another user's Grant", async () => {
    const { links, inTenant } = build({ owner: OTHER });
    await expect(inTenant(() => links.resetOwn(GRANT, USER))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('leaves the staff path unbounded: reset() neither counts nor records', async () => {
    const { links, inTenant, calls } = build({ recent: [realHoursAgo(1), realHoursAgo(2), realHoursAgo(3)] });
    await inTenant(() => links.reset(GRANT, USER));
    expect(calls).toEqual(['rotate']);
  });
});
