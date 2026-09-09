import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { envConfigOptions, envSchema } from './env.validation';

/**
 * Compose passes every optional variable as `VAR=${VAR:-}`, so inside the
 * container an unset option is the empty string, not a missing key.
 *
 * `optional()` in `env.validation.ts` already turns that into `undefined` —
 * but `ConfigService.get` reads the validated env *first and process.env
 * second*, so an undefined validated value fell through to the raw `''` and
 * the call-site default never ran. `BOT_LANG_TTL_SEC` then reached Redis as
 * `expire <key> ''`, which is an error reply, which is a 500 on every single
 * webhook update.
 *
 * `skipProcessEnv` makes the validated env the only source, which is what the
 * schema was written to be.
 */
describe('env config', () => {
  const optionals = [
    'BOT_LANG_TTL_SEC',
    'BOT_COMMAND_LANGS',
    'BOT_DEFAULT_LANGUAGE',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of optionals) {
      saved[key] = process.env[key];
      // Exactly what docker compose puts in the container.
      process.env[key] = '';
    }
    // The three the schema insists on, so the module can boot at all.
    process.env.DOMAIN_NAME ??= 'example.test';
    process.env.AUTH_API_BASE_URL ??= 'http://auth.example.test';
    process.env.SERVICE_AUTH_TOKEN ??= 'a-service-auth-token-long-enough-for-the-schema';
  });

  afterEach(() => {
    for (const key of optionals) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  async function config(): Promise<ConfigService> {
    const moduleRef = await Test.createTestingModule({
      // The app's own wiring, not a copy of it: this is the thing under test.
      imports: [ConfigModule.forRoot(envConfigOptions)],
    }).compile();
    return moduleRef.get(ConfigService);
  }

  it('lets the call-site default answer for an empty optional', async () => {
    const c = await config();
    expect(c.get<number>('BOT_LANG_TTL_SEC', 42)).toBe(42);
    expect(c.get<string>('BOT_COMMAND_LANGS') ?? 'fa,en').toBe('fa,en');
  });

  // The defaults come from the schema, not from a second copy typed here: the
  // claim is "an unconfigured optional reaches ConfigService as the schema's
  // default", and restating `'fa'` would let the schema change while this
  // stayed green.
  const schemaDefault = <K extends keyof typeof envSchema.shape>(key: K) =>
    envSchema.shape[key].parse(undefined);

  it('still answers with a schema default nobody configured', async () => {
    const c = await config();
    expect(c.get<string>('DEFAULT_LANGUAGE')).toBe(
      schemaDefault('DEFAULT_LANGUAGE'),
    );
    expect(c.get<number>('OTP_BOT_HTTP_TIMEOUT_MS')).toBe(
      schemaDefault('OTP_BOT_HTTP_TIMEOUT_MS'),
    );
  });

  it('still answers with what is configured', async () => {
    process.env.BOT_LANG_TTL_SEC = '900';
    const c = await config();
    expect(c.get<number>('BOT_LANG_TTL_SEC', 42)).toBe(900);
  });
});
