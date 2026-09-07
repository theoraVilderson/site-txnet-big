import { ChatLanguage } from './chat-language';

/**
 * The order is the whole feature: a user's own choice outranks the tenant's
 * default, which outranks this deployment's `DEFAULT_LANGUAGE`, which outranks
 * the language their messenger app happens to be in (user decision, 2026-09-06;
 * ADR-0016).
 */
function make(
  over: {
    stored?: string | null;
    tenant?: string;
    deployment?: string;
    served?: string[];
  } = {},
) {
  const redis = {
    getJson: jest.fn().mockResolvedValue(over.stored ?? null),
    setJson: jest.fn(),
    touch: jest.fn(),
  };
  const locale = { languages: () => over.served ?? ['fa', 'en'] };
  const env: Record<string, string | undefined> = {
    BOT_DEFAULT_LANGUAGE: over.tenant,
    DEFAULT_LANGUAGE: over.deployment,
  };
  const config = { get: (k: string) => env[k] };
  return {
    redis,
    langs: new ChatLanguage(redis as any, locale as any, config as any),
  };
}

describe('ChatLanguage', () => {
  it('prefers what the chat chose over everything else', async () => {
    const { langs } = make({ stored: 'en', tenant: 'fa', deployment: 'fa' });
    expect(await langs.resolve('telegram', '1', 'fa')).toBe('en');
  });

  it("prefers the deployment's language over the messenger's hint", async () => {
    const { langs } = make({ tenant: 'fa' });
    expect(await langs.resolve('telegram', '1', 'en')).toBe('fa');
  });

  // The defect this item exists for: `.env` sets DEFAULT_LANGUAGE=fa and
  // BOT_DEFAULT_LANGUAGE is set nowhere, so an English Telegram client used to
  // be greeted in English on a Persian-first deployment.
  it('falls back to DEFAULT_LANGUAGE when no bot-specific default is set', async () => {
    const { langs } = make({ deployment: 'fa' });
    expect(await langs.resolve('telegram', '1', 'en')).toBe('fa');
  });

  it('lets BOT_DEFAULT_LANGUAGE outrank DEFAULT_LANGUAGE', async () => {
    const { langs } = make({ tenant: 'en', deployment: 'fa' });
    expect(await langs.resolve('telegram', '1', 'fa')).toBe('en');
  });

  it('falls through to DEFAULT_LANGUAGE when the tenant default is not served', async () => {
    const { langs } = make({ tenant: 'de', deployment: 'fa' });
    expect(await langs.resolve('telegram', '1', 'en')).toBe('fa');
  });

  it("falls through to the messenger's hint when no configured default is served", async () => {
    const { langs } = make({ tenant: 'de', deployment: 'ru' });
    expect(await langs.resolve('telegram', '1', 'en')).toBe('en');
  });

  it("follows the messenger's hint when neither default is configured", async () => {
    const { langs } = make();
    expect(await langs.resolve('telegram', '1', 'en')).toBe('en');
  });

  it('ignores a stored language locale-service no longer serves', async () => {
    const { langs } = make({ stored: 'de' });
    expect(await langs.resolve('telegram', '1', 'fa')).toBe('fa');
  });

  it('refuses to store a language that is not served', async () => {
    const { langs, redis } = make();
    expect(await langs.choose('telegram', '1', 'de')).toBe(false);
    expect(redis.setJson).not.toHaveBeenCalled();
  });
});
