import { ChatLanguage } from './chat-language';

/**
 * The order is the whole feature: a user's own choice outranks the tenant's
 * default, which outranks the language their messenger app happens to be in
 * (user decision, 2026-09-06).
 */
function make(over: { stored?: string | null; tenant?: string } = {}) {
  const redis = {
    getJson: jest.fn().mockResolvedValue(over.stored ?? null),
    setJson: jest.fn(),
    touch: jest.fn(),
  };
  const locale = { languages: () => ['fa', 'en'] };
  const config = { get: (k: string) => (k === 'BOT_DEFAULT_LANGUAGE' ? over.tenant : undefined) };
  return {
    redis,
    langs: new ChatLanguage(redis as any, locale as any, config as any),
  };
}

describe('ChatLanguage', () => {
  it('prefers what the chat chose over everything else', async () => {
    const { langs } = make({ stored: 'en', tenant: 'fa' });
    expect(await langs.resolve('telegram', '1', 'fa')).toBe('en');
  });

  it("prefers the deployment's language over the messenger's hint", async () => {
    const { langs } = make({ tenant: 'fa' });
    expect(await langs.resolve('telegram', '1', 'en')).toBe('fa');
  });

  it("follows the messenger's hint when no default is configured", async () => {
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
