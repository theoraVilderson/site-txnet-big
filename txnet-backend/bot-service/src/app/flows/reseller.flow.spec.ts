import type { Mocked } from 'vitest';
import { aBotIntegration } from '@txnet-backend/messenger';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { BillingApiClient } from '../billing-api/billing-api.client';
import { ChatContext, NavState } from '../conversation/nav.types';
import { BotKeys } from '../locale/bot-keys';
import { BotSessionStore } from '../session/bot-session.store';
import { ChatAccess } from '../session/chat-access';
import { TenantApiClient } from '../tenant-api/tenant-api.client';
import { ResellerCampaignFlow } from './reseller-campaign.flow';
import { ResellerFlow, USERS_PER_PAGE } from './reseller.flow';

const ctx: ChatContext = { integration: aBotIntegration(), platform: 'telegram', chatId: '5501', senderId: 42, lang: 'fa' };
const TENANT = ctx.integration.tenantId;
const ok = <T>(data: T) => ({ ok: true, msg: 'ok', data });
const refused = (msg: string) => ({ ok: false, msg });

const ALICE = { id: 'u-1', fullName: 'Alice', username: 'alice', phoneMasked: '0912***4455', status: 'active' as const, createdAt: '2026-04-01T10:11:12.000Z' };
const BOB = { id: 'u-2', fullName: 'Bob', username: 'bob', phoneMasked: null, status: 'suspended' as const, createdAt: '2026-05-02T00:00:00.000Z' };
const BANNED = { ...ALICE, id: 'u-3', fullName: 'Carol', status: 'banned' as const };

const page = (items: unknown[], over: { total?: number; page?: number } = {}) => ok({
  items,
  total: over.total ?? items.length,
  page: over.page ?? 1,
  pageSize: USERS_PER_PAGE,
});

function harness(over: { verdict?: unknown; users?: unknown; revenue?: unknown; block?: unknown; tenantConfigured?: boolean; campaigns?: boolean } = {}) {
  const auth = {
    refresh: vi.fn().mockResolvedValue(ok({ accessToken: 'access-1', expiresIn: 900, refreshToken: 'r-next' })),
    resellerUsers: vi.fn().mockResolvedValue(over.users ?? page([ALICE, BOB])),
    blockResellerUser: vi.fn().mockResolvedValue(over.block ?? ok({ ...ALICE, status: 'suspended' })),
    unblockResellerUser: vi.fn().mockResolvedValue(ok({ ...BOB, status: 'active' })),
  } as unknown as Mocked<AuthApiClient>;
  const billing = {
    resellerRevenue: vi.fn().mockResolvedValue(
      over.revenue ??
        ok({
          from: '2026-08-21T00:00:00.000Z',
          to: '2026-09-20T00:00:00.000Z',
          sales: { total: '0.00', count: 0, byReason: [] },
          topUps: { total: '1250.00', count: 7 },
        }),
    ),
  } as unknown as Mocked<BillingApiClient>;
  const tenant = {
    isConfigured: over.tenantConfigured ?? true,
    access: vi.fn().mockResolvedValue(over.verdict ?? ok({ tenantId: TENANT, canRead: true, canWrite: true, reason: null })),
  } as unknown as Mocked<TenantApiClient>;
  const sessions = {
    get: vi.fn().mockResolvedValue({ refreshToken: 'r-1', signedInAt: 0 }),
    save: vi.fn(),
    clear: vi.fn(),
  } as unknown as BotSessionStore;
  const campaigns = {
    isConfigured: over.campaigns ?? true,
    start: vi.fn(),
    handle: vi.fn(),
  } as unknown as Mocked<ResellerCampaignFlow>;
  return {
    auth,
    billing,
    tenant,
    campaigns,
    flow: new ResellerFlow(auth, billing, tenant, new ChatAccess(auth, sessions), campaigns),
  };
}

const ids = (r: { view: { actions?: { id: string }[][] } }) => (r.view.actions ?? []).flat().map((a) => a.id);
const onUsers = (data: Record<string, string> = {}): NavState => ({ flow: 'reseller', step: 'reseller.users', data });
const onUser = (target: string): NavState => ({ flow: 'reseller', step: 'reseller.user', data: { page: '1', target } });

describe('ResellerFlow', () => {
  describe('the menu row (F-311-e is what decides it)', () => {
    it('asks the door about the bot’s own reseller, never the session’s tenant', async () => {
      const { flow, tenant } = harness();

      const may = await flow.canAdminister(ctx, 'access-1');

      expect(tenant.access).toHaveBeenCalledWith(TENANT, { lang: 'fa', accessToken: 'access-1' });
      expect(may).toBe(true);
    });

    it('hides the row from a customer of this same bot', async () => {
      const { flow } = harness({ verdict: ok({ tenantId: TENANT, canRead: false, canWrite: false, reason: 'not_allowed' }) });

      expect(await flow.canAdminister(ctx, 'access-1')).toBe(false);
    });

    it('hides it when tenant-service cannot be reached, rather than failing a customer’s menu', async () => {
      const { flow } = harness({ verdict: refused('try again') });

      expect(await flow.canAdminister(ctx, 'access-1')).toBe(false);
    });

    it('hides it where TENANT_API_BASE_URL is unset, without a call', async () => {
      const { flow, tenant } = harness({ tenantConfigured: false });

      expect(await flow.canAdminister(ctx, 'access-1')).toBe(false);
      expect(tenant.access).not.toHaveBeenCalled();
    });
  });

  describe('the customer list', () => {
    it('lists the bot’s reseller’s own users, one page, with the chat’s access token', async () => {
      const { flow, auth } = harness();

      const result = await flow.handle(ctx, { flow: 'reseller', step: 'reseller.home', data: {} }, 'reseller:users');

      expect(auth.resellerUsers).toHaveBeenCalledWith(
        TENANT,
        { q: undefined, page: 1, pageSize: USERS_PER_PAGE },
        { chatId: '5501', lang: 'fa', platform: 'telegram', tenantId: TENANT, accessToken: 'access-1' },
      );
      expect(ids(result)).toEqual(expect.arrayContaining(['ruser:u-1', 'ruser:u-2']));
      expect(result.nextState).toMatchObject({ step: 'reseller.users', data: { page: '1' } });
    });

    it('reads free text on that screen as the search box a chat does not have', async () => {
      const { flow, auth } = harness();

      const result = await flow.handle({ ...ctx, text: ' alice ' }, onUsers({ page: '1' }), null);

      expect(auth.resellerUsers).toHaveBeenCalledWith(TENANT, { q: 'alice', page: 1, pageSize: USERS_PER_PAGE }, expect.anything());
      expect(result.nextState?.data).toMatchObject({ q: 'alice', page: '1' });
    });

    it('refuses to send a one-letter search, which is a dump wearing a search box', async () => {
      const { flow, auth } = harness();

      const result = await flow.handle({ ...ctx, text: 'a' }, onUsers({ page: '1' }), null);

      expect(auth.resellerUsers).not.toHaveBeenCalled();
      expect(result.view.id).toBe('reseller.users.short');
    });

    it('keeps a page tap inside the search it was made in', async () => {
      const { flow, auth } = harness({ users: page([ALICE], { total: 30, page: 2 }) });

      await flow.handle(ctx, onUsers({ q: 'ali', page: '1' }), 'rpage:2');

      expect(auth.resellerUsers).toHaveBeenCalledWith(TENANT, { q: 'ali', page: 2, pageSize: USERS_PER_PAGE }, expect.anything());
    });

    it('says a search matched nobody differently from a reseller with no customers', async () => {
      const { flow } = harness({ users: page([]) });

      const empty = await flow.handle(ctx, { flow: 'reseller', step: 'reseller.home', data: {} }, 'reseller:users');
      const noMatch = await flow.handle({ ...ctx, text: 'zzz' }, onUsers({ page: '1' }), null);

      expect(empty.view.id).toBe('reseller.users.empty');
      expect(noMatch.view.id).toBe('reseller.users.noMatch');
    });
  });

  describe('one customer', () => {
    it('re-reads the page rather than trusting the button, and shows what it found', async () => {
      const { flow, auth } = harness();

      const result = await flow.handle(ctx, onUsers({ page: '1' }), 'ruser:u-2');

      expect(auth.resellerUsers).toHaveBeenCalledWith(TENANT, { q: undefined, page: 1, pageSize: USERS_PER_PAGE }, expect.anything());
      expect(result.view.body).toMatchObject({ values: { name: 'Bob', joined: '2026-05-02' } });
      expect(result.nextState).toMatchObject({ step: 'reseller.user', data: { target: 'u-2' } });
    });

    // A status is a word this bot owns, so it is a `BotText` and not a string:
    // a bare key renders as `bot.reseller.statusSuspended` inside the profile,
    // and nothing fails while it does.
    it('shows the status as a sentence to translate, never as the key itself', async () => {
      const { flow } = harness();

      const result = await flow.handle(ctx, onUsers({ page: '1' }), 'ruser:u-2');

      expect(result.view.body.values?.status).toEqual({ key: BotKeys.reseller.statusSuspended });
    });

    it('lands back on the list for a row that has since left the page', async () => {
      const { flow } = harness();

      const result = await flow.handle(ctx, onUsers({ page: '1' }), 'ruser:someone-else');

      expect(result.view.id).toBe('reseller.user.gone');
      expect(result.nextState?.step).toBe('reseller.users');
    });

    it('offers block for an active user and unblock for a blocked one', async () => {
      const { flow } = harness();

      const active = await flow.handle(ctx, onUsers({ page: '1' }), 'ruser:u-1');
      const blocked = await flow.handle(ctx, onUsers({ page: '1' }), 'ruser:u-2');

      expect(ids(active)).toContain('rblock:u-1');
      expect(ids(blocked)).toContain('runblock:u-2');
    });

    it('offers neither to a reseller the door admits for reading only', async () => {
      const { flow } = harness({ verdict: ok({ tenantId: TENANT, canRead: true, canWrite: false, reason: null }) });

      const result = await flow.handle(ctx, onUsers({ page: '1' }), 'ruser:u-1');

      expect(ids(result)).not.toContain('rblock:u-1');
      expect(result.view.body).toMatchObject({ values: { name: 'Alice' } });
    });

    it('offers neither on an account the platform banned, however wide the verdict', async () => {
      const { flow } = harness({ users: page([BANNED]) });

      const result = await flow.handle(ctx, onUsers({ page: '1' }), 'ruser:u-3');

      expect(ids(result)).not.toContain('rblock:u-3');
      expect(ids(result)).not.toContain('runblock:u-3');
    });
  });

  describe('blocking', () => {
    it('asks before it blocks, and the first tap writes nothing', async () => {
      const { flow, auth } = harness();

      const asked = await flow.handle(ctx, onUser('u-1'), 'rblock:u-1');

      expect(auth.blockResellerUser).not.toHaveBeenCalled();
      expect(asked.view.id).toBe('reseller.block.confirm');
      expect(asked.nextState).toMatchObject({ step: 'reseller.block.confirm', data: { target: 'u-1' } });
    });

    it('blocks on the second tap, on the confirmation screen', async () => {
      const { flow, auth } = harness();
      const confirming: NavState = { flow: 'reseller', step: 'reseller.block.confirm', data: { page: '1', target: 'u-1' } };

      const result = await flow.handle(ctx, confirming, 'rblock:u-1');

      expect(auth.blockResellerUser).toHaveBeenCalledWith(TENANT, 'u-1', expect.anything());
      expect(result.view.id).toBe('reseller.blocked');
      expect(result.nextState).toBeNull();
    });

    it('cannot be answered by a stale keyboard naming someone else', async () => {
      const { flow, auth } = harness();
      const confirming: NavState = { flow: 'reseller', step: 'reseller.block.confirm', data: { page: '1', target: 'u-1' } };

      const result = await flow.handle(ctx, confirming, 'rblock:u-2');

      expect(auth.blockResellerUser).not.toHaveBeenCalled();
      expect(result.view.id).toBe('reseller.block.confirm');
    });

    it('unblocks in one tap — giving access back needs no confirmation', async () => {
      const { flow, auth } = harness();

      const result = await flow.handle(ctx, onUser('u-2'), 'runblock:u-2');

      expect(auth.unblockResellerUser).toHaveBeenCalledWith(TENANT, 'u-2', expect.anything());
      expect(result.view.id).toBe('reseller.unblocked');
    });

    it('relays auth-api’s own refusal instead of writing a rule of its own', async () => {
      const { flow } = harness({ block: refused('این نمایندگی معلق است') });
      const confirming: NavState = { flow: 'reseller', step: 'reseller.block.confirm', data: { page: '1', target: 'u-1' } };

      const result = await flow.handle(ctx, confirming, 'rblock:u-1');

      expect(result.view.body).toEqual({ raw: 'این نمایندگی معلق است' });
    });
  });

  describe('the revenue figure', () => {
    it('shows billing’s two figures for its own window, as the strings it answered', async () => {
      const { flow, billing } = harness();

      const result = await flow.handle(ctx, { flow: 'reseller', step: 'reseller.home', data: {} }, 'reseller:revenue');

      expect(billing.resellerRevenue).toHaveBeenCalledWith(TENANT, {
        lang: 'fa',
        accessToken: 'access-1',
        platform: 'telegram',
        botTenantId: TENANT,
      });
      expect(result.view.body).toMatchObject({
        values: { from: '2026-08-21', to: '2026-09-20', sales: '0.00', salesCount: '0', topUps: '1250.00', topUpsCount: '7' },
      });
    });
  });
});
