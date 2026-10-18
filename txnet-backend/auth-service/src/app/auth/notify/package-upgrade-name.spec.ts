import { vi } from 'vitest';
import { BotClientRegistry } from '@txnet-backend/messenger';
import { packageTextKey } from '@txnet-backend/shared-core';
import { runWithTenant } from '../../tenant-context/tenant-context';
import { LocaleService } from '../../locale/locale.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UserNotifier } from './user-notifier';

/**
 * PK-1-e (ADR-0154 (7)): the AI upgrade suggestion names its package by the
 * key tenant-service derived, in the owner's language — never the `name`
 * column typed in another one. A language with no published text falls back
 * to `package` as ai sent it, which is that column: the source text.
 */

const PKG = '0a1b2c3d-0000-4000-8000-00000000c0de';
const NAME_KEY = packageTextKey(PKG, 'name');
const PUBLISHED: Record<string, Record<string, string>> = { fa: { [NAME_KEY.slice('packages.'.length)]: 'طلایی' } };

function tell(lang: string, params: Record<string, string>) {
  const client = { sendMessage: vi.fn(async (_chat: string, _text: string, _markup?: unknown) => undefined) };
  const locale = {
    getNamespace: vi.fn((_lang: string, ns: string) => (ns === 'notifications' ? { suggestion: { package_upgrade: '{{quota}} → {{package}} ({{price}})' } } : undefined)),
    getKey: vi.fn((l: string, ns: string, key: string) => (ns === 'packages' ? PUBLISHED[l]?.[key] : undefined)),
    getDefaultLanguage: () => 'en',
  } as unknown as LocaleService;
  const prisma = {
    user: { findFirst: vi.fn(async () => ({ languagePreference: lang })) },
    linkedBotAccount: { findMany: vi.fn(async () => [{ platform: 'telegram', platformUserId: '5501' }]) },
  } as unknown as PrismaService;
  const bots = { primaryClient: vi.fn(async () => client), canSend: vi.fn(async () => true) } as unknown as BotClientRegistry;
  const notifier = new UserNotifier(prisma, bots, locale);
  return runWithTenant({ id: 'tenant-1', slug: 'platform', via: 'domain' }, async () => {
    await notifier.notify({ userId: 'owner-1', channel: 'bot', template: 'suggestionPackageUpgrade', params: { quota: 'Q', price: '95.00 USD', ...params } });
    return client.sendMessage.mock.calls[0]?.[1];
  });
}

describe('the upgrade suggestion names its package in the owner\'s language (PK-1-e)', () => {
  it('by its key, when that language has the text published', async () => {
    expect(await tell('fa', { package: 'Gold', packageNameKey: NAME_KEY })).toBe('Q → طلایی (95.00 USD)');
  });

  it('by the source text ai sent, when that language has none — never another language\'s draft', async () => {
    expect(await tell('de', { package: 'Gold', packageNameKey: NAME_KEY })).toBe('Q → Gold (95.00 USD)');
  });

  it('a key from another namespace is not read as a package name', async () => {
    expect(await tell('fa', { package: 'Gold', packageNameKey: 'catalog.product.gold.name' })).toBe('Q → Gold (95.00 USD)');
  });
});
