import type { Mocked } from 'vitest';
import { aBotIntegration } from '@txnet-backend/messenger';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { ChatContext, NavState } from '../conversation/nav.types';
import { NotificationApiClient } from '../notification-api/notification-api.client';
import { BotSessionStore } from '../session/bot-session.store';
import { ChatAccess } from '../session/chat-access';
import { TenantApiClient } from '../tenant-api/tenant-api.client';
import { ResellerCampaignFlow, RECENT_CAMPAIGNS } from './reseller-campaign.flow';

const ctx: ChatContext = { integration: aBotIntegration(), platform: 'telegram', chatId: '5501', senderId: 42, lang: 'fa' };
const TENANT = ctx.integration.tenantId;
const ok = <T>(data: T) => ({ ok: true, msg: 'ok', data });
const refused = (msg: string) => ({ ok: false, msg });

const DRAFT = {
  id: 'c-1',
  channel: 'telegram_bot',
  messageBody: 'Ten percent off this week',
  status: 'draft' as const,
  sentCount: 0,
  failedCount: 0,
  createdAt: '2026-09-20T08:00:00.000Z',
};
const SENDING = { ...DRAFT, status: 'sending' as const, sentCount: 12, failedCount: 1 };

function harness(
  over: {
    verdict?: unknown;
    count?: unknown;
    draft?: unknown;
    start?: unknown;
    campaign?: unknown;
    list?: unknown;
    configured?: boolean;
  } = {},
) {
  const auth = {
    refresh: vi.fn().mockResolvedValue(ok({ accessToken: 'access-1', expiresIn: 900, refreshToken: 'r-next' })),
  } as unknown as Mocked<AuthApiClient>;
  const notifications = {
    isConfigured: over.configured ?? true,
    audienceCount: vi.fn().mockResolvedValue(over.count ?? ok({ count: 42 })),
    draft: vi.fn().mockResolvedValue(over.draft ?? ok(DRAFT)),
    start: vi.fn().mockResolvedValue(over.start ?? ok(SENDING)),
    campaign: vi.fn().mockResolvedValue(over.campaign ?? ok(SENDING)),
    list: vi.fn().mockResolvedValue(over.list ?? ok({ items: [DRAFT], total: 1, page: 1, pageSize: RECENT_CAMPAIGNS })),
  } as unknown as Mocked<NotificationApiClient>;
  const tenant = {
    isConfigured: true,
    access: vi.fn().mockResolvedValue(over.verdict ?? ok({ tenantId: TENANT, canRead: true, canWrite: true, reason: null })),
  } as unknown as Mocked<TenantApiClient>;
  const sessions = {
    get: vi.fn().mockResolvedValue({ refreshToken: 'r-1', signedInAt: 0 }),
    save: vi.fn(),
    clear: vi.fn(),
  } as unknown as BotSessionStore;
  return { notifications, tenant, flow: new ResellerCampaignFlow(notifications, tenant, new ChatAccess(auth, sessions)) };
}

const ids = (r: { view: { actions?: { id: string }[][] } }) => (r.view.actions ?? []).flat().map((a) => a.id);
const at = (step: string, data: Record<string, string> = {}): NavState => ({ flow: 'campaign', step, data });

describe('ResellerCampaignFlow (F-313-b)', () => {
  describe('the way in', () => {
    it('offers the segments to a reseller the door lets write, for the bot’s own tenant', async () => {
      const { flow, tenant } = harness();

      const result = await flow.start(ctx);

      expect(tenant.access).toHaveBeenCalledWith(TENANT, { lang: 'fa', accessToken: 'access-1' });
      expect(result.view.id).toBe('campaign.segment');
      expect(ids(result)).toEqual(expect.arrayContaining(['cseg:all', 'cseg:active', 'cseg:new30']));
    });

    // `tenant/rules.md`: a suspended reseller reads what it did and starts
    // nothing new. The screen it gets is the one it may actually use.
    it('shows a suspended reseller what it has sent, and no way to start another', async () => {
      const { flow, notifications } = harness({
        verdict: ok({ tenantId: TENANT, canRead: true, canWrite: false, reason: null }),
      });

      const result = await flow.start(ctx);

      expect(result.view.id).toBe('campaign.list');
      expect(notifications.audienceCount).not.toHaveBeenCalled();
      expect(ids(result).some((id) => id.startsWith('cseg:'))).toBe(false);
    });

    it('does the same when the door does not answer, rather than offering a send that will be refused', async () => {
      const { flow } = harness({ verdict: refused('try again') });

      expect((await flow.start(ctx)).view.id).toBe('campaign.list');
    });

    it('says nothing at all to a chat that is signed out', async () => {
      const { flow, tenant } = harness();
      const sessions = { get: vi.fn().mockResolvedValue(null), save: vi.fn(), clear: vi.fn() } as unknown as BotSessionStore;
      const signedOut = new ResellerCampaignFlow(
        harness().notifications,
        tenant,
        new ChatAccess({ refresh: vi.fn() } as unknown as Mocked<AuthApiClient>, sessions),
      );

      const result = await signedOut.start(ctx);

      expect(result.view.id).toBe('reseller.signedOut');
      expect(tenant.access).not.toHaveBeenCalled();
    });
  });

  describe('picking a segment and seeing the count', () => {
    it('counts with notification’s own audience shape, for the bot’s tenant', async () => {
      const { flow, notifications } = harness();

      const result = await flow.handle(ctx, at('campaign.segment'), 'cseg:active');

      expect(notifications.audienceCount).toHaveBeenCalledWith(
        TENANT,
        { statuses: ['active'] },
        { lang: 'fa', accessToken: 'access-1' },
      );
      expect(result.view.id).toBe('campaign.text');
      expect(result.view.body.values).toEqual({ count: '42' });
      expect(result.nextState).toMatchObject({ step: 'campaign.text', data: { segment: 'active', count: '42' } });
    });

    it('asks for no message where the segment is empty, and leaves the reseller on the segments', async () => {
      const { flow, notifications } = harness({ count: ok({ count: 0 }) });

      const result = await flow.handle(ctx, at('campaign.segment'), 'cseg:all');

      expect(result.view.id).toBe('campaign.segment');
      expect(result.nextState).toMatchObject({ step: 'campaign.segment' });
      expect(notifications.draft).not.toHaveBeenCalled();
    });

    it('relays notification’s own sentence when the count is refused', async () => {
      const { flow } = harness({ count: refused('You may not do that here.') });

      expect((await flow.handle(ctx, at('campaign.segment'), 'cseg:all')).view.body.raw).toBe('You may not do that here.');
    });
  });

  describe('writing it, and the draft that becomes', () => {
    it('drafts what was typed, over this messenger, for the segment the screen asked about', async () => {
      const { flow, notifications } = harness();

      const result = await flow.handle(
        { ...ctx, text: 'Ten percent off this week' },
        at('campaign.text', { segment: 'new30', count: '42' }),
        null,
      );

      expect(notifications.draft).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({ channel: 'telegram_bot', messageBody: 'Ten percent off this week' }),
        { lang: 'fa', accessToken: 'access-1' },
      );
      // The segment is the remembered one, resolved to notification's filter
      // here and never carried on a button.
      expect(notifications.draft.mock.calls[0][1].audience.registeredFrom).toBeTypeOf('string');
      expect(result.view.id).toBe('campaign.confirm');
      expect(result.nextState).toMatchObject({ step: 'campaign.confirm', data: { id: 'c-1', count: '42' } });
    });

    it('sends a Bale bot’s campaign over Bale', async () => {
      const { flow, notifications } = harness();

      await flow.handle({ ...ctx, platform: 'bale', text: 'Hi' }, at('campaign.text', { segment: 'all', count: '3' }), null);

      expect(notifications.draft.mock.calls[0][1].channel).toBe('bale_bot');
    });

    it('relays a refused draft as the sentence notification wrote', async () => {
      const { flow } = harness({ draft: refused('That message is too long.') });

      const result = await flow.handle({ ...ctx, text: 'x' }, at('campaign.text', { segment: 'all', count: '3' }), null);

      expect(result.view.body.raw).toBe('That message is too long.');
    });
  });

  describe('confirming, and watching it go', () => {
    it('starts the send only from the screen that asked, and shows where it got to', async () => {
      const { flow, notifications } = harness();

      const result = await flow.handle(ctx, at('campaign.confirm', { id: 'c-1', count: '42' }), 'csend:c-1');

      expect(notifications.start).toHaveBeenCalledWith(TENANT, 'c-1', { lang: 'fa', accessToken: 'access-1' });
      expect(result.view.id).toBe('campaign.status');
      expect(result.view.body.values).toEqual({ sent: '12', failed: '1' });
    });

    // The mutation check: drop the id comparison and this one starts a send.
    it('sends nothing when the tap names a campaign the screen does not', async () => {
      const { flow, notifications } = harness();

      const result = await flow.handle(ctx, at('campaign.confirm', { id: 'c-9', count: '42' }), 'csend:c-1');

      expect(notifications.start).not.toHaveBeenCalled();
      expect(notifications.campaign).toHaveBeenCalledWith(TENANT, 'c-1', { lang: 'fa', accessToken: 'access-1' });
      expect(result.view.id).toBe('campaign.status');
    });

    it('sends nothing on a stale keyboard from another screen either', async () => {
      const { flow, notifications } = harness();

      await flow.handle(ctx, at('campaign.text', { segment: 'all' }), 'csend:c-1');

      expect(notifications.start).not.toHaveBeenCalled();
    });

    it('re-reads the campaign on a refresh, which is the only way a chat watches anything', async () => {
      const { flow, notifications } = harness();

      const result = await flow.handle(ctx, at('campaign.sent', { id: 'c-1' }), 'cstat:c-1');

      expect(notifications.campaign).toHaveBeenCalledWith(TENANT, 'c-1', { lang: 'fa', accessToken: 'access-1' });
      expect(result.view.body.key).toBe('bot.campaign.statusSending');
    });
  });

  describe('what it has already sent', () => {
    it('lists the recent ones, newest first as notification answered them', async () => {
      const { flow, notifications } = harness();

      const result = await flow.handle(ctx, at('campaign.segment'), 'campaign:list');

      expect(notifications.list).toHaveBeenCalledWith(
        TENANT,
        { page: 1, pageSize: RECENT_CAMPAIGNS },
        { lang: 'fa', accessToken: 'access-1' },
      );
      expect(ids(result)).toContain('camp:c-1');
    });

    it('opens one of them at its status', async () => {
      const { flow, notifications } = harness();

      const result = await flow.handle(ctx, at('campaign.list'), 'camp:c-1');

      expect(notifications.campaign).toHaveBeenCalledWith(TENANT, 'c-1', { lang: 'fa', accessToken: 'access-1' });
      expect(result.view.id).toBe('campaign.status');
    });

    it('has its own screen for a reseller that has sent nothing', async () => {
      const { flow } = harness({ list: ok({ items: [], total: 0, page: 1, pageSize: RECENT_CAMPAIGNS }) });

      expect((await flow.handle(ctx, at('campaign.segment'), 'campaign:list')).view.id).toBe('campaign.list.empty');
    });
  });
});
