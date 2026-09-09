import { ConfigService } from '@nestjs/config';
import { aBotIntegration, newWebhookPath } from '@txnet-backend/messenger';
import { WebhookRotationService } from './webhook-rotation.service';

/**
 * The invariant this item turns on: a rotation retires the old address
 * *before* it talks to the platform, so an upstream failure can leave a bot
 * unreachable but can never leave a burned path answering (F-322).
 */
describe('WebhookRotationService', () => {
  const config = (env: Record<string, string> = { DOMAIN_NAME: 'txnet.test' }) =>
    ({ get: (key: string) => env[key] }) as unknown as ConfigService;

  const build = (options: {
    setWebhook?: jest.Mock;
    client?: unknown;
    env?: Record<string, string>;
  } = {}) => {
    const integration = aBotIntegration({ webhookPath: 'old'.repeat(20) });
    const order: string[] = [];
    const setWebhook =
      options.setWebhook ??
      jest.fn(async () => {
        order.push('setWebhook');
        return true;
      });

    const rotateWebhookPath = jest.fn(async () => {
      order.push('rotateWebhookPath');
      return { ...integration, webhookPath: newWebhookPath(), status: 'pending' as const };
    });
    const recordRegistration = jest.fn(async () => {
      order.push('recordRegistration');
    });
    const webhookSecret = jest.fn(async () => 'the-secret');

    const directory = {
      rotateWebhookPath,
      recordRegistration,
      webhookSecret,
    };
    const bots = {
      client: jest.fn(async () =>
        options.client === undefined ? { setWebhook } : options.client,
      ),
    };

    const service = new WebhookRotationService(
      config(options.env),
      directory as never,
      bots as never,
    );
    return { service, integration, order, setWebhook, ...directory, bots };
  };

  it('writes the new path before it tells the platform about it', async () => {
    const { service, integration, order } = build();

    await service.rotate(integration);

    expect(order).toEqual([
      'rotateWebhookPath',
      'setWebhook',
      'recordRegistration',
    ]);
  });

  it('registers the new path at this deployment public base', async () => {
    const { service, integration, setWebhook, rotateWebhookPath } = build();

    await service.rotate(integration);

    const rotated = await rotateWebhookPath.mock.results[0].value;
    expect(setWebhook).toHaveBeenCalledWith(
      `https://api.txnet.test/api/bots/telegram/${rotated.webhookPath}`,
      'the-secret',
    );
  });

  it('never registers the path it just retired', async () => {
    const { service, integration, setWebhook } = build();

    await service.rotate(integration);

    expect(setWebhook.mock.calls[0][0]).not.toContain(integration.webhookPath);
  });

  it('keeps the rotation when the platform refuses, and says it is unregistered', async () => {
    const setWebhook = jest.fn(async () => false);
    const { service, integration, rotateWebhookPath, recordRegistration } =
      build({ setWebhook });

    const result = await service.rotate(integration);

    expect(rotateWebhookPath).toHaveBeenCalled();
    expect(result.registered).toBe(false);
    expect(result.integration.status).toBe('error');
    expect(recordRegistration).toHaveBeenCalledWith(integration.id, {
      ok: false,
    });
  });

  it('still retires the old path when there is no usable token', async () => {
    const { service, integration, rotateWebhookPath, recordRegistration } =
      build({ client: null });

    const result = await service.rotate(integration);

    expect(rotateWebhookPath).toHaveBeenCalled();
    expect(result.registered).toBe(false);
    expect(recordRegistration).toHaveBeenCalledWith(integration.id, {
      ok: false,
    });
  });

  it('still retires the old path when no webhook base is configured', async () => {
    const { service, integration, rotateWebhookPath, setWebhook } = build({
      env: {},
    });

    const result = await service.rotate(integration);

    expect(rotateWebhookPath).toHaveBeenCalled();
    expect(setWebhook).not.toHaveBeenCalled();
    expect(result.registered).toBe(false);
  });
});
