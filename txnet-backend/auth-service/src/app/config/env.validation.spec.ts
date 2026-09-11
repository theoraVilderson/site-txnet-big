import { validateEnv } from './env.validation';

/**
 * Docker compose passes an unset variable through as `FOO=`, so the service
 * receives an empty string where a human reading the compose file sees
 * "not configured". Every optional var with a *shape* rule — a length, a URL —
 * has to treat that empty string as absent, or the service refuses to boot
 * over a setting nobody filled in on purpose.
 */
describe('validateEnv — an empty var is an unset var', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@db:5432/d',
    DATABASE_APP_URL: 'postgresql://a:p@db:5432/d',
    DATABASE_CROSS_TENANT_URL: 'postgresql://x:p@db:5432/d',
    JWT_ACCESS_SECRET: 'a'.repeat(24),
    JWT_REFRESH_HASH_SECRET: 'b'.repeat(24),
    JWT_SECRET_CAPTCHA: 'c'.repeat(24),
    REDIS_URL: 'redis://redis:6379',
    DOMAIN_NAME: 'example.com',
  };

  /**
   * F-087, decided 2026-09-11: every per-route limit is env-tunable **and**
   * has a default. These two assertions are that decision.
   */
  describe('per-route rate limits', () => {
    const limits = (env: Record<string, unknown>) =>
      Object.entries(env).filter(([k]) => k.endsWith('_RATE_LIMIT'));

    it('gives every limit a positive default when nothing is set', () => {
      const found = limits(validateEnv(base));
      // 22 routes, two of which share CAPTCHA_RATE_LIMIT.
      expect(found).toHaveLength(21);
      for (const [name, value] of found) {
        expect(`${name}=${value}`).toMatch(/=[1-9]\d*$/);
      }
    });

    it('treats a limit compose passed as "" as unset, not as zero', () => {
      const env = validateEnv({ ...base, LOGIN_PWD_RATE_LIMIT: '' });
      expect(env.LOGIN_PWD_RATE_LIMIT).toBe(validateEnv(base).LOGIN_PWD_RATE_LIMIT);
    });

    it('takes a configured limit, and refuses one that is not a count', () => {
      expect(validateEnv({ ...base, LOGIN_PWD_RATE_LIMIT: '5' }).LOGIN_PWD_RATE_LIMIT).toBe(5);
      expect(() => validateEnv({ ...base, LOGIN_PWD_RATE_LIMIT: '0' })).toThrow();
      expect(() => validateEnv({ ...base, LOGIN_PWD_RATE_LIMIT: 'many' })).toThrow();
    });
  });

  it('accepts DEFAULT_PHONE_COUNTRY="" as not set', () => {
    const env = validateEnv({ ...base, DEFAULT_PHONE_COUNTRY: '' });
    expect(env.DEFAULT_PHONE_COUNTRY).toBeUndefined();
  });

  it('still rejects a DEFAULT_PHONE_COUNTRY that is present and wrong', () => {
    expect(() =>
      validateEnv({ ...base, DEFAULT_PHONE_COUNTRY: 'IRN' }),
    ).toThrow();
  });

  it('accepts FRONTEND_ORIGIN="" as not set', () => {
    const env = validateEnv({ ...base, FRONTEND_ORIGIN: '' });
    expect(env.FRONTEND_ORIGIN).toBeUndefined();
  });

  it('still rejects a FRONTEND_ORIGIN that is present and not a URL', () => {
    expect(() => validateEnv({ ...base, FRONTEND_ORIGIN: 'panel' })).toThrow();
  });

  it('keeps a configured value', () => {
    const env = validateEnv({
      ...base,
      DEFAULT_PHONE_COUNTRY: 'IR',
      FRONTEND_ORIGIN: 'https://panel.example.com',
    });
    expect(env.DEFAULT_PHONE_COUNTRY).toBe('IR');
    expect(env.FRONTEND_ORIGIN).toBe('https://panel.example.com');
  });
});
