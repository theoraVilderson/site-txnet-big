import { vi } from 'vitest';
import { BotClientRegistry } from '@txnet-backend/messenger';
import { runWithTenant } from '../../tenant-context/tenant-context';
import { LocaleService } from '../../locale/locale.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UserNotifier } from './user-notifier';

/**
 * F-707-y: a lottery winner is told where the prize went — the service GB or
 * days were added to, named as My services names it (the buyer's own label,
 * then the catalog name in their language, else the sku) — so a prize on the
 * wrong service is noticed at once. A prize no service holds (a coupon, a free
 * service) is "added to your account", as before.
 */

const NOTIFICATIONS = {
  engagement: {
    lotteryWon: '{{prize}} — {{where}}',
    lotteryWonOnService: 'to {{service}}',
    lotteryWonOnAccount: 'to your account',
    lotteryOpenedAutomatic: 'In {{title}}.{{prizeNote}}',
    lotteryPrizeNote: ' GB or days go {{where}}.',
    lotteryPrizeAutomatic: 'to the service that runs longest',
  },
  retention: { serviceNamed: '{{label}} ({{name}})' },
};

function tell(params: Record<string, string>, template: 'lotteryWon' | 'lotteryOpenedAutomatic' = 'lotteryWon') {
  const client = { sendMessage: vi.fn(async (_chat: string, _text: string, _markup?: unknown) => undefined) };
  const locale = {
    getNamespace: vi.fn((_lang: string, ns: string) => (ns === 'notifications' ? NOTIFICATIONS : undefined)),
    getKey: vi.fn((_l: string, ns: string, key: string) => (ns === 'catalog' && key === 'p.gold' ? 'Gold 50 GB' : undefined)),
    getDefaultLanguage: () => 'en',
  } as unknown as LocaleService;
  const prisma = {
    user: { findFirst: vi.fn(async () => ({ languagePreference: 'en' })) },
    linkedBotAccount: { findMany: vi.fn(async () => [{ platform: 'telegram', platformUserId: '5501' }]) },
  } as unknown as PrismaService;
  const bots = { primaryClient: vi.fn(async () => client), canSend: vi.fn(async () => true) } as unknown as BotClientRegistry;
  const notifier = new UserNotifier(prisma, bots, locale);
  return runWithTenant({ id: 'tenant-1', slug: 'platform', via: 'domain' }, async () => {
    await notifier.notify({ userId: 'u-1', channel: 'bot', template, params: { title: 'Autumn', prize: '20 GB', ...params } });
    return client.sendMessage.mock.calls[0]?.[1];
  });
}

describe("a lottery winner is told where the prize went (F-707-y)", () => {
  it('names the service by its label and catalog name', async () => {
    expect(await tell({ serviceLabel: 'Family', serviceNameKey: 'catalog.p.gold', serviceSku: 'GOLD-50' })).toContain('20 GB — to Family (Gold 50 GB)');
  });

  it('falls back to the catalog name, then the sku, for an unnamed service', async () => {
    expect(await tell({ serviceNameKey: 'catalog.p.gold', serviceSku: 'GOLD-50' })).toContain('— to Gold 50 GB');
    expect(await tell({ serviceSku: 'GOLD-50' })).toContain('— to GOLD-50');
  });

  it('says "your account" for a prize no service holds', async () => {
    expect(await tell({})).toContain('20 GB — to your account');
  });
});

describe('a lottery announcement names where a prize would go now (F-707-z)', () => {
  it('the chosen service, or automatic, to a member with a choice; nothing to the others', async () => {
    expect(await tell({ lotteryId: 'L', prizeChoice: '1', serviceLabel: 'Family', serviceNameKey: 'catalog.p.gold' }, 'lotteryOpenedAutomatic')).toBe('In Autumn. GB or days go to Family (Gold 50 GB).');
    expect(await tell({ lotteryId: 'L', prizeChoice: '1' }, 'lotteryOpenedAutomatic')).toBe('In Autumn. GB or days go to the service that runs longest.');
    expect(await tell({ lotteryId: 'L' }, 'lotteryOpenedAutomatic')).toBe('In Autumn.');
  });
});
