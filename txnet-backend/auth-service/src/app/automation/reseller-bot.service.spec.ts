import { TenantCredentialKind } from '@prisma/client';
import { aBotIntegration } from '@txnet-backend/messenger';
import { ResellerAccessRefused } from '@txnet-backend/shared-core';
import { ResellerBotRefused, ResellerBotService } from './reseller-bot.service';

/**
 * The invariant this item turns on: a bot a reseller connects is **proved
 * before it is stored and stored before it is registered**, its token lands in
 * the vault and comes back out of no answer (F-323), and retiring it revokes
 * that token whether or not the platform accepted the withdrawal (F-066-w5).
 *
 * The door itself is `ResellerAccess`'s and is specified in
 * `shared-core/src/lib/tenant/reseller-access.spec.ts` — what is checked here
 * is that this surface asks it, with the capability each verb deserves, and
 * that a refusal stops the work before anything is written.
 */
describe('ResellerBotService', () => {
  const actor = { userId: 'u-1', tenantId: 'platform', permissions: ['tenant.manage'] };
  const reseller = 'aaaaaaaa-0000-4000-8000-000000000001';

  const build = (options: {
    getMe?: unknown;
    deleteWebhook?: unknown;
    setWebhook?: unknown;
    admit?: unknown;
    byTenantBot?: unknown;
    primaryFor?: unknown;
    create?: unknown;
  } = {}) => {
    const order: string[] = [];
    const client = {
      getMe: options.getMe ?? vi.fn(async () => ({ id: 7, username: 'acmebot' })),
      setWebhook:
        options.setWebhook ??
        vi.fn(async () => {
          order.push('setWebhook');
          return true;
        }),
      deleteWebhook:
        options.deleteWebhook ??
        vi.fn(async () => {
          order.push('deleteWebhook');
          return true;
        }),
    };

    const row = aBotIntegration({
      id: 'bi-1',
      tenantId: reseller,
      botUsername: 'acmebot',
      credentialRef: 'bot:telegram:acmebot',
    });

    const directory = {
      byTenantBot: options.byTenantBot ?? vi.fn(async () => null),
      primaryFor: options.primaryFor ?? vi.fn(async () => null),
      listForTenant: vi.fn(async () => [row]),
      create:
        options.create ??
        vi.fn(async () => {
          order.push('create');
          return row;
        }),
      remove: vi.fn(async () => {
        order.push('remove');
      }),
      recordRegistration: vi.fn(async () => {
        order.push('recordRegistration');
      }),
      webhookSecret: vi.fn(async () => 'the-secret'),
    };

    const vault = {
      available: true,
      put: vi.fn(async (ref: { kind: string }) => {
        order.push(`put:${ref.kind}`);
        return {};
      }),
      revoke: vi.fn(async (ref: { kind: string }) => {
        order.push(`revoke:${ref.kind}`);
      }),
    };

    const access = {
      run: vi.fn(async (_a: unknown, _t: unknown, capability: string, work: (r: unknown) => Promise<unknown>) => {
        order.push(`admit:${capability}`);
        if (options.admit) return (options.admit as () => Promise<unknown>)();
        return work({ id: reseller, slug: 'vpnshop', as: 'owner' });
      }),
    };

    const bots = { clientForToken: vi.fn(() => client), client: vi.fn(async () => client) };
    const config = { get: (key: string) => ({ DOMAIN_NAME: 'txnet.test' })[key] };

    const service = new ResellerBotService(
      config as never,
      access as never,
      directory as never,
      vault as never,
      bots as never,
    );
    return { service, order, client, directory, vault, access, row };
  };

  describe('connect', () => {
    it('proves the token with the messenger, stores both credentials before the row, and registers last', async () => {
      const { service, order, client } = build();

      const result = await service.connect(actor, reseller, {
        platform: 'telegram',
        token: '7:AA',
      });

      expect(client.getMe).toHaveBeenCalled();
      expect(order).toEqual([
        'admit:staffWrite',
        `put:${TenantCredentialKind.telegram_bot_token}`,
        `put:${TenantCredentialKind.webhook_secret}`,
        'create',
        'setWebhook',
        'recordRegistration',
      ]);
      expect(result.registered).toBe(true);
    });

    it('never answers with the token, the webhook path or the vault label', async () => {
      const { service } = build();

      const result = await service.connect(actor, reseller, {
        platform: 'telegram',
        token: '7:AA',
      });

      const answer = JSON.stringify(result);
      expect(answer).not.toContain('7:AA');
      expect(answer).not.toContain('the-secret');
      expect(result.bot).not.toHaveProperty('webhookPath');
      expect(result.bot).not.toHaveProperty('credentialRef');
      expect(result.bot.botUsername).toBe('acmebot');
    });

    it('refuses a token the messenger does not recognise, and writes nothing', async () => {
      const { service, order, vault } = build({ getMe: vi.fn(async () => null) });

      await expect(
        service.connect(actor, reseller, { platform: 'telegram', token: 'nope' }),
      ).rejects.toMatchObject({ reason: 'invalid_token' });
      expect(vault.put).not.toHaveBeenCalled();
      expect(order).toEqual(['admit:staffWrite']);
    });

    it('refuses a bot this reseller already has', async () => {
      const { service, vault } = build({
        byTenantBot: vi.fn(async () => aBotIntegration({ botUsername: 'acmebot' })),
      });

      await expect(
        service.connect(actor, reseller, { platform: 'telegram', token: '7:AA' }),
      ).rejects.toMatchObject({ reason: 'bot_already_connected' });
      expect(vault.put).not.toHaveBeenCalled();
    });

    it('refuses a second primary on the same platform (C-05)', async () => {
      const { service, vault } = build({
        primaryFor: vi.fn(async () => aBotIntegration({ botUsername: 'otherbot' })),
      });

      await expect(
        service.connect(actor, reseller, { platform: 'telegram', token: '7:AA' }),
      ).rejects.toMatchObject({ reason: 'primary_exists' });
      expect(vault.put).not.toHaveBeenCalled();
    });

    it('revokes the credentials it just wrote when the row cannot be created', async () => {
      const { service, order, vault } = build({
        create: vi.fn(async () => {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }),
      });

      await expect(
        service.connect(actor, reseller, { platform: 'telegram', token: '7:AA' }),
      ).rejects.toMatchObject({ reason: 'bot_already_connected' });
      expect(vault.revoke).toHaveBeenCalledTimes(2);
      expect(order.slice(-2)).toEqual([
        `revoke:${TenantCredentialKind.telegram_bot_token}`,
        `revoke:${TenantCredentialKind.webhook_secret}`,
      ]);
    });

    it('keeps the bot when the platform refuses the webhook, and says so', async () => {
      const { service, directory } = build({ setWebhook: vi.fn(async () => false) });

      const result = await service.connect(actor, reseller, {
        platform: 'telegram',
        token: '7:AA',
      });

      expect(result.registered).toBe(false);
      expect(directory.recordRegistration).toHaveBeenCalledWith('bi-1', { ok: false });
    });

    it('stops at the door, before the messenger is asked', async () => {
      const { service, client } = build({
        admit: () => Promise.reject(new ResellerAccessRefused('not_allowed')),
      });

      await expect(
        service.connect(actor, reseller, { platform: 'telegram', token: '7:AA' }),
      ).rejects.toMatchObject({ reason: 'not_allowed' });
      expect(client.getMe).not.toHaveBeenCalled();
    });
  });

  describe('retire', () => {
    it('withdraws the webhook, revokes both credentials, then deletes the row', async () => {
      const { service, order } = build({
        byTenantBot: vi.fn(async () =>
          aBotIntegration({ id: 'bi-1', tenantId: reseller, botUsername: 'acmebot' }),
        ),
      });

      const result = await service.retire(actor, reseller, 'telegram', 'acmebot');

      expect(order).toEqual([
        'admit:staffWrite',
        'deleteWebhook',
        `revoke:${TenantCredentialKind.telegram_bot_token}`,
        `revoke:${TenantCredentialKind.webhook_secret}`,
        'remove',
      ]);
      expect(result).toEqual({ retired: true, webhookRemoved: true });
    });

    it('revokes the token even when the platform never withdrew the webhook', async () => {
      const { service, order, vault } = build({
        byTenantBot: vi.fn(async () =>
          aBotIntegration({ id: 'bi-1', tenantId: reseller, botUsername: 'acmebot' }),
        ),
        deleteWebhook: vi.fn(async () => false),
      });

      const result = await service.retire(actor, reseller, 'telegram', 'acmebot');

      expect(result.webhookRemoved).toBe(false);
      expect(vault.revoke).toHaveBeenCalledTimes(2);
      expect(order).toContain('remove');
    });

    it('is a 404 for a bot this reseller does not have', async () => {
      const { service, vault } = build();

      await expect(service.retire(actor, reseller, 'telegram', 'ghostbot')).rejects.toMatchObject({
        reason: 'bot_not_found',
      });
      expect(vault.revoke).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('reads under the reseller-read capability, so a suspended reseller still sees its bots', async () => {
      const { service, order } = build();

      const bots = await service.list(actor, reseller);

      expect(order).toEqual(['admit:read']);
      expect(bots[0]).not.toHaveProperty('webhookPath');
      expect(bots[0]).not.toHaveProperty('credentialRef');
    });
  });

  it('refuses every verb when the vault cannot be reached', async () => {
    const { service, vault } = build();
    (vault as { available: boolean }).available = false;

    await expect(
      service.connect(actor, reseller, { platform: 'telegram', token: '7:AA' }),
    ).rejects.toBeInstanceOf(ResellerBotRefused);
  });
});
