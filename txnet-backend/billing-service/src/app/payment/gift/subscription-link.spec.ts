/**
 * A Grant's `/sub` link, answered as often as asked (F-114-e-b, D-43, ADR-0085):
 * `GET /api/billing/gift/grants/:id/subscription-link`, and the reset route that
 * answers the new one.
 *
 * Four things are the whole feature, and each is silent when wrong:
 *
 *  - **the host is one `/sub` answers on.** A link on a panel domain, an
 *    unproven custom domain or a CNAME target is a link the user's VPN app
 *    reads as a 404 and drops — it looks exactly like a working one here;
 *  - **the host is the same every time.** Two answers on two hosts are two
 *    links, and a user who pasted one wonders which is theirs;
 *  - **no domain refuses before a reset destroys anything.** A reset that
 *    rotated first and then found no host would kill the working link and hand
 *    back nothing;
 *  - **another user's Grant stays a 404**, never a domain or "not kept"
 *    refusal that would say the id exists.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { BackendI18nKeys, RATE_LIMIT_KEY, RateLimitBucket, type RateLimitOptions, runWithTenant } from '@txnet-backend/shared-core';

import { EntitlementRefused } from '../../entitlement/grant';
import { GiftController } from './gift.controller';
import { GrantTokenController } from './grant-token.controller';
import { SubscriptionLinkService, subscriptionHostOf } from './subscription-link.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const GRANT = '22222222-2222-4222-8222-222222222222';
const E = BackendI18nKeys.errors.billing.grant;

type Row = { domainValue: string; domainType: 'subdomain' | 'custom_domain' };

function build(rows: Row[], token: string | null = 'tok-0001') {
  const calls: string[] = [];
  let where: unknown;
  const tx = {
    tenantDomain: {
      findMany: async (args: { where: unknown }) => {
        calls.push('domains');
        where = args.where;
        return rows;
      },
    },
    $executeRaw: async () => 0,
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  const owner = (userId: string) => {
    if (userId !== USER) throw new EntitlementRefused('grant_not_found', GRANT);
  };
  const grants = {
    subscriptionTokenFor: vi.fn(async (_tx: unknown, _id: string, userId: string) => {
      calls.push('open');
      owner(userId);
      return token;
    }),
    rotateToken: vi.fn(async (_tx: unknown, _id: string, userId: string) => {
      calls.push('rotate');
      owner(userId);
      return 'tok-0002';
    }),
  };
  const links = new SubscriptionLinkService(prisma as never, grants as never);
  const inTenant = <R>(fn: () => Promise<R>) => runWithTenant({ id: TENANT }, fn);
  return { links, grants, calls, inTenant, where: () => where };
}

const refusal = (e: unknown) => (e as ConflictException).getResponse() as Record<string, unknown>;

describe('subscriptionHostOf', () => {
  it('prefers a proven custom domain, then a subdomain, each alphabetically', () => {
    expect(
      subscriptionHostOf([
        { domainValue: 'b.sub.txnet.app', domainType: 'subdomain' },
        { domainValue: 'z.example.com', domainType: 'custom_domain' },
        { domainValue: 'a.example.com', domainType: 'custom_domain' },
      ]),
    ).toBe('a.example.com');
    expect(
      subscriptionHostOf([
        { domainValue: 'b.sub.txnet.app', domainType: 'subdomain' },
        { domainValue: 'a.sub.txnet.app', domainType: 'subdomain' },
      ]),
    ).toBe('a.sub.txnet.app');
  });

  it('never answers a CNAME target, and nothing for no rows', () => {
    expect(subscriptionHostOf([{ domainValue: 'r1.edge.txnet.app', domainType: 'subdomain' }])).toBeNull();
    expect(subscriptionHostOf([])).toBeNull();
  });
});

describe('SubscriptionLinkService', () => {
  it('answers https://<subscription host>/sub/<token>, reading only routable subscription domains of this tenant', async () => {
    const { links, inTenant, where } = build([{ domainValue: 'sub.example.com', domainType: 'custom_domain' }]);

    await expect(inTenant(() => links.linkFor(GRANT, USER))).resolves.toBe('https://sub.example.com/sub/tok-0001');
    expect(where()).toEqual({
      tenantId: TENANT,
      purpose: 'subscription',
      OR: [{ domainType: 'subdomain' }, { verificationStatus: 'verified' }],
    });
  });

  it('answers the same link on every call', async () => {
    const { links, inTenant, grants } = build([{ domainValue: 's.sub.txnet.app', domainType: 'subdomain' }]);
    const first = await inTenant(() => links.linkFor(GRANT, USER));
    expect(await inTenant(() => links.linkFor(GRANT, USER))).toBe(first);
    expect(grants.rotateToken).not.toHaveBeenCalled();
  });

  it('refuses a Grant with no kept token as link_not_kept (409), so the panel offers a reset', async () => {
    const { links, inTenant } = build([{ domainValue: 'sub.example.com', domainType: 'custom_domain' }], null);
    const err = await inTenant(() => links.linkFor(GRANT, USER)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(refusal(err)).toMatchObject({ i18nKey: E.linkNotKept, reason: 'link_not_kept' });
  });

  it('refuses a tenant with no subscription domain as no_subscription_domain (409)', async () => {
    const { links, inTenant } = build([]);
    const err = await inTenant(() => links.linkFor(GRANT, USER)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(refusal(err)).toMatchObject({ i18nKey: E.noSubscriptionDomain, reason: 'no_subscription_domain' });
    expect(JSON.stringify(refusal(err))).not.toContain('tok-');
  });

  it('answers another user’s Grant as a missing one, before any domain is looked at', async () => {
    const { links, inTenant, calls } = build([]);
    const err = await inTenant(() => links.linkFor(GRANT, 'someone-else')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(refusal(err)).toMatchObject({ i18nKey: E.notFound, reason: 'grant_not_found' });
    expect(calls).toEqual(['open']);
  });

  it('reset answers the new link, in the transaction that rotated it', async () => {
    const { links, inTenant, calls } = build([{ domainValue: 'sub.example.com', domainType: 'custom_domain' }]);
    await expect(inTenant(() => links.reset(GRANT, USER))).resolves.toBe('https://sub.example.com/sub/tok-0002');
    expect(calls).toEqual(['domains', 'rotate']);
  });

  it('reset with no subscription domain refuses before the working link is destroyed', async () => {
    const { links, inTenant, grants } = build([]);
    const err = await inTenant(() => links.reset(GRANT, USER)).catch((e: unknown) => e);
    expect(refusal(err)).toMatchObject({ reason: 'no_subscription_domain' });
    expect(grants.rotateToken).not.toHaveBeenCalled();
  });

  it('lets anything that is not a refusal through, rather than turning a bug into a 404', async () => {
    const { links, inTenant, grants } = build([{ domainValue: 'sub.example.com', domainType: 'custom_domain' }]);
    grants.subscriptionTokenFor.mockRejectedValueOnce(new Error('the sealed subscription token does not match its hash'));
    await expect(inTenant(() => links.linkFor(GRANT, USER))).rejects.toThrow('does not match its hash');
  });
});

describe('GrantTokenController — the link routes', () => {
  const req = (userId: string) => ({ identity: { userId, tenantId: TENANT, roleId: 'r', sessionId: 's', permissions: [] } });

  it('answers {grantId, subscriptionUrl} for the id in the path and the gate’s user', async () => {
    const links = { linkFor: vi.fn(async () => 'https://sub.example.com/sub/tok-0001') };
    const controller = new GrantTokenController(links as never);
    await expect(controller.link(GRANT, req(USER) as never)).resolves.toEqual({
      grantId: GRANT,
      subscriptionUrl: 'https://sub.example.com/sub/tok-0001',
    });
    expect(links.linkFor).toHaveBeenCalledWith(GRANT, USER);
  });

  it('is a GET on its own bucket — reading the link never spends the reset budget', () => {
    const handler = GrantTokenController.prototype.link;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(0); // RequestMethod.GET
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id/subscription-link');
    const limit = Reflect.getMetadata(RATE_LIMIT_KEY, handler) as RateLimitOptions;
    expect(limit.configKey).toBe('SUBSCRIPTION_LINK_RATE_LIMIT');
    expect(limit.key(req(USER) as never)).toBe(`${RateLimitBucket.SUBSCRIPTION_LINK}:${USER}`);
    expect(RateLimitBucket.SUBSCRIPTION_LINK).not.toBe(RateLimitBucket.GRANT_ROTATE_TOKEN);
  });
});

describe('the token leaves only inside the link (F-114-e-c)', () => {
  it('a free-service redemption answers the Grant, and neither a key nor the token', async () => {
    const gifts = {
      redeem: vi.fn(async () => ({
        kind: 'free_grant' as const,
        redemptionId: 'r-1',
        code: 'FREEVPN',
        grant: { id: GRANT, variantId: 'v-1', startsAt: new Date('2026-09-25T00:00:00Z'), endsAt: null, featureKeys: ['vpn.access'] },
        token: 'tok-secret',
      })),
    };
    const controller = new GiftController(gifts as never);
    const req = { identity: { userId: USER, tenantId: TENANT, roleId: 'r', sessionId: 's', permissions: [] } };

    const answer = await controller.redeem({ code: 'FREEVPN' }, req as never);

    expect(answer).toMatchObject({ kind: 'free_grant', code: 'FREEVPN', grant: { id: GRANT } });
    expect(answer).not.toHaveProperty('subscriptionKey');
    expect(JSON.stringify(answer)).not.toContain('tok-secret');
  });
});
