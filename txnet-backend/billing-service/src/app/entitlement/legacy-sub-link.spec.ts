import type { Prisma } from '@prisma/client';

import { legacyPathOf, recordLegacyLink } from './legacy-sub-link';

/**
 * F-203-a: an imported user's old subscription link keeps working, so the
 * commit keeps the path each one holds. What fails silently here: a host kept
 * with its port or its case (F-203-b then matches nothing once the old host
 * points here), a trailing slash kept on one side and not the other, a
 * hostile source's `javascript:` or bare-root "link" kept as someone's, and a
 * second client claiming a path another Grant already answers.
 */
const TOKEN = 'eyJzdWIiOiJhbGkiLCJpYXQiOjE3MDAwMDAwMDB9.c2lnbmF0dXJl';
const UUID = '0d1e2f30-4a5b-4c6d-8e7f-8091a2b3c4d5';

describe('legacyPathOf', () => {
  it.each([
    ['Marzban / Marzneshin', `https://sub.ali-vpn.ir/sub/${TOKEN}`, { host: 'sub.ali-vpn.ir', path: `/sub/${TOKEN}` }],
    ['3x-ui on its sub port, mixed case', 'http://Sub.Ali-VPN.ir:2096/sub/k7x2m9q4/', { host: 'sub.ali-vpn.ir', path: '/sub/k7x2m9q4' }],
    ['S-UI, an escaped name', 'https://s.example.com:2096/sub/ali%20reza', { host: 's.example.com', path: '/sub/ali reza' }],
    ['Hiddify, its proxy path and uuid', `https://h.example.com/Xp4thSecret/${UUID}/`, { host: 'h.example.com', path: `/Xp4thSecret/${UUID}` }],
  ])('keeps the host and path of %s', (_family, url, want) => {
    expect(legacyPathOf(url)).toEqual(want);
  });

  it.each([
    ['no address', undefined],
    ['an empty one', ''],
    ['not http(s)', 'javascript:alert(1)'],
    ['the bare root, which is nobody’s link', 'https://sub.ali-vpn.ir/'],
    ['malformed', 'https://'],
    ['a broken escape', 'https://sub.ali-vpn.ir/sub/%E0%A4%A'],
  ])('keeps nothing for %s', (_case, url) => {
    expect(legacyPathOf(url)).toBeNull();
  });
});

describe('recordLegacyLink', () => {
  const link = { tenantId: 'tenant-a', grantId: 'grant-1', migrationItemId: 'item-1' };
  const txWith = (count: number) => {
    const createMany = vi.fn(async () => ({ count }));
    return { tx: { legacySubLink: { createMany } } as unknown as Prisma.TransactionClient, createMany };
  };

  it('writes one row for the Grant, safe to write twice', async () => {
    const { tx, createMany } = txWith(1);
    await expect(recordLegacyLink(tx, { ...link, subscriptionUrl: `https://sub.ali-vpn.ir/sub/${TOKEN}` })).resolves.toBe('recorded');
    expect(createMany).toHaveBeenCalledWith({
      data: [{ tenantId: 'tenant-a', host: 'sub.ali-vpn.ir', path: `/sub/${TOKEN}`, grantId: 'grant-1', migrationItemId: 'item-1' }],
      skipDuplicates: true,
    });
  });

  it('leaves a path another Grant already answers to it', async () => {
    const { tx } = txWith(0);
    await expect(recordLegacyLink(tx, { ...link, subscriptionUrl: 'https://sub.ali-vpn.ir/sub/shared-subid' })).resolves.toBe('taken');
  });

  it('writes nothing for a client with no old link', async () => {
    const { tx, createMany } = txWith(1);
    await expect(recordLegacyLink(tx, { ...link, subscriptionUrl: undefined })).resolves.toBe('none');
    expect(createMany).not.toHaveBeenCalled();
  });
});
