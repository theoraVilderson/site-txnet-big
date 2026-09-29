/**
 * The kept subscription token (F-114-e-a, D-43, ADR-0085).
 *
 * What breaks without anyone seeing it:
 *  - **a link that is shown once again.** Issue and rotation must seal the token
 *    they answer, so My services can show the same link later;
 *  - **a link that opens the wrong service.** What opens has to hash to the row's
 *    `subscriptionTokenHash`, because that hash is what `/sub` looks up;
 *  - **the vault key reused.** The token key is derived from the KEK, so a value
 *    sealed under the KEK itself (a DEK) never opens as a token;
 *  - **another user's link.** It is refused exactly as a missing Grant is;
 *  - **a sale refused for want of a key.** With no KEK loaded the Grant is still
 *    issued, and it simply holds no sealed token.
 */
import { GrantSource, Prisma, VariantBillingMode, VariantVisibility } from '@prisma/client';
import { KekService, runWithTenant, seal } from '@txnet-backend/shared-core';

import { EntitlementRefused, GrantService, hashSubscriptionToken } from './grant';
import { GrantTokenSeal, type SealedToken } from './grant-token-seal';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const VARIANT = '66666666-6666-4666-8666-6666666666c1';

const KEK_A = Buffer.alloc(32, 7);
const KEK_B = Buffer.alloc(32, 9);

function kek(active: string | null, keys: Record<string, Buffer> = { 'kek-a': KEK_A, 'kek-b': KEK_B }): KekService {
  return {
    available: active !== null,
    get activeKekId() {
      if (!active) throw new Error('no KEK');
      return active;
    },
    keyFor: (id: string) => {
      const key = keys[id];
      if (!key) throw new Error(`no KEK '${id}'`);
      return key;
    },
  } as unknown as KekService;
}

describe('GrantTokenSeal', () => {
  it('opens what it sealed, and names the KEK it was sealed under', () => {
    const tokens = new GrantTokenSeal(kek('kek-a'));
    const sealed = tokens.seal('the-token') as SealedToken;

    expect(sealed.kekId).toBe('kek-a');
    expect(JSON.stringify(sealed)).not.toContain('the-token');
    expect(tokens.open(sealed)).toBe('the-token');
  });

  it('opens a token sealed under an older KEK after the active one changed', () => {
    const sealed = new GrantTokenSeal(kek('kek-a')).seal('the-token') as SealedToken;
    expect(new GrantTokenSeal(kek('kek-b')).open(sealed)).toBe('the-token');
  });

  it('never opens a value sealed under the KEK itself — the token key is derived', () => {
    const underKek = { kekId: 'kek-a', ...seal('the-token', KEK_A) };
    expect(() => new GrantTokenSeal(kek('kek-a')).open(underKek)).toThrow();
  });

  it('seals nothing when no KEK is loaded', () => {
    expect(new GrantTokenSeal(kek(null)).seal('the-token')).toBeNull();
  });
});

describe('GrantService keeps the token it answers', () => {
  const variant = {
    id: VARIANT,
    tenantId: null,
    isActive: true,
    visibility: VariantVisibility.public,
    billingMode: VariantBillingMode.prepaid,
    quotas: {},
    durationDays: 30,
    rateCards: [],
    product: { isActive: true, featureKeys: ['vpn.access'], categories: [{ position: 0, category: { key: 'vpn', isActive: true, parentId: null } }] },
  };

  function fakeTx() {
    const grants: Array<Record<string, unknown>> = [];
    const byId = (id: unknown) => grants.find((g) => g['id'] === id) ?? null;
    // Prisma writes `DbNull` as SQL NULL and reads it back as `null`.
    const stored = (data: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v === Prisma.DbNull ? null : v]));
    const tx = {
      tenant: { findUnique: async () => ({ operatingCurrencyCode: 'USD' }) },
      productVariant: { findUnique: vi.fn(async () => variant) },
      grant: {
        findFirst: vi.fn(async () => null),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => byId(where.id)),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `grant-${grants.length + 1}`, ...stored(data) };
          grants.push(row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = byId(where.id) as Record<string, unknown>;
          Object.assign(row, stored(data));
          return row;
        }),
      },
    };
    return { tx: tx as unknown as Prisma.TransactionClient, grants };
  }

  const serviceWith = (keys: KekService) => new GrantService({} as never, new GrantTokenSeal(keys));
  const issue = (service: GrantService, tx: Prisma.TransactionClient) =>
    runWithTenant({ id: TENANT }, () => service.issue(tx, { userId: USER, variantId: VARIANT, source: GrantSource.coupon }));

  it('answers the same token later that it answered at issue, and it hashes to the row', async () => {
    const service = serviceWith(kek('kek-a'));
    const { tx, grants } = fakeTx();

    const { grant, token } = await issue(service, tx);
    const later = await service.subscriptionTokenFor(tx, grant.id, USER);

    expect(later).toBe(token);
    expect(hashSubscriptionToken(later as string)).toBe(grants[0]['subscriptionTokenHash']);
  });

  it('keeps the new token after a rotation, and no longer the old one', async () => {
    const service = serviceWith(kek('kek-a'));
    const { tx } = fakeTx();

    const { grant, token } = await issue(service, tx);
    const rotated = await service.rotateToken(tx, grant.id, USER);

    expect(rotated).not.toBe(token);
    expect(await service.subscriptionTokenFor(tx, grant.id, USER)).toBe(rotated);
  });

  it('refuses another user\'s Grant exactly as a missing one', async () => {
    const service = serviceWith(kek('kek-a'));
    const { tx } = fakeTx();
    const { grant } = await issue(service, tx);

    for (const [id, user] of [[grant.id, OTHER], ['grant-404', USER]]) {
      await expect(service.subscriptionTokenFor(tx, id, user)).rejects.toMatchObject({ reason: 'grant_not_found' });
    }
    await expect(service.subscriptionTokenFor(tx, grant.id, OTHER)).rejects.toBeInstanceOf(EntitlementRefused);
  });

  it('still issues with no KEK, and that Grant has no token to answer until it is reset', async () => {
    const { tx, grants } = fakeTx();
    const without = serviceWith(kek(null));

    const { grant, token } = await issue(without, tx);

    expect(token).toEqual(expect.any(String));
    expect(grants[0]['subscriptionTokenSealed']).toBeNull();
    expect(await without.subscriptionTokenFor(tx, grant.id, USER)).toBeNull();

    const withKek = serviceWith(kek('kek-a'));
    const reset = await withKek.rotateToken(tx, grant.id, USER);
    expect(await withKek.subscriptionTokenFor(tx, grant.id, USER)).toBe(reset);
  });

  it('refuses a sealed token that does not hash to the row, rather than answer another link', async () => {
    const service = serviceWith(kek('kek-a'));
    const { tx, grants } = fakeTx();
    const { grant } = await issue(service, tx);

    grants[0]['subscriptionTokenSealed'] = new GrantTokenSeal(kek('kek-a')).seal('someone-else');

    await expect(service.subscriptionTokenFor(tx, grant.id, USER)).rejects.toThrow(/does not match/);
  });
});
