import { envSchema, validateEnv } from './env.validation';

/**
 * `billing-service`'s env schema (F-089, ADR-0036).
 *
 * This service was the one deployable that could start with a typo'd variable
 * and report itself healthy, because it read `process.env` raw. The assertions
 * below are about that: what a missing variable does, and what the empty string
 * compose actually sends does.
 */
const DB = {
  DATABASE_APP_URL: 'postgresql://app@db/txnet',
  // Required since F-092-j: the gateway callback is public, so it resolves its
  // tenant from the Host, and that read cannot run on the scoped pool.
  DATABASE_CROSS_TENANT_URL: 'postgresql://cross@db/txnet',
  REDIS_URL: 'redis://redis:6379',
  // Required since F-027-cl: the hot loop's queue.
  RABBITMQ_URL: 'amqp://rabbitmq:5672',
};

describe('envSchema', () => {
  it('starts with nothing configured but the database', () => {
    // Since F-092-a the service queries Postgres, so its connections are the
    // one thing an empty environment cannot default; everything else still
    // must, or the schema is a reason not to run it rather than a check on it.
    const env = validateEnv(DB);
    expect(env.PORT).toBe(3000);
    expect(env.GLOBAL_PREFIX).toBe('api');
    expect(env.NODE_ENV).toBe('development');
  });

  it('coerces the port compose passes as a string', () => {
    expect(validateEnv({ ...DB, PORT: '4000' }).PORT).toBe(4000);
  });

  it('refuses a port that is not a usable one', () => {
    // The whole point of validating: a nonsense port must stop the boot rather
    // than become `NaN` and bind somewhere unpredictable.
    expect(() => validateEnv({ ...DB, PORT: 'not-a-number' })).toThrow();
    expect(() => validateEnv({ ...DB, PORT: '0' })).toThrow();
    expect(() => validateEnv({ ...DB, PORT: '-1' })).toThrow();
  });

  it('refuses an environment name it does not know', () => {
    expect(() => validateEnv({ ...DB, NODE_ENV: 'staging' })).toThrow();
  });

  it('refuses an empty prefix rather than serving from the root', () => {
    // `''` would silently move every route, which is the kind of change that
    // must be asked for rather than fallen into.
    expect(() => validateEnv({ ...DB, GLOBAL_PREFIX: '' })).toThrow();
  });

  it('names every variable it rejected, not just the first', () => {
    // The boot log is the only place an operator sees this, so one failure per
    // deploy attempt would make a misconfigured environment take several.
    let message: Record<string, unknown> = {};
    try {
      envSchema.parse({ ...DB, PORT: 'x', NODE_ENV: 'staging' });
    } catch (error) {
      message = (error as { flatten: () => { fieldErrors: Record<string, unknown> } })
        .flatten().fieldErrors;
    }
    expect(Object.keys(message).sort()).toEqual(['NODE_ENV', 'PORT']);
  });

  it('refuses production without a PAYMENT_RESULT_SECRET a result page can trust', () => {
    const prod = { ...DB, NODE_ENV: 'production', FRONTEND_ORIGIN: 'https://panel.example', SERVICE_AUTH_TOKEN: 't' };
    const refused = (env: Record<string, unknown>) =>
      envSchema.safeParse(env).error?.issues.some((i) => i.path[0] === 'PAYMENT_RESULT_SECRET') ?? false;
    expect(refused(prod)).toBe(true);
    expect(refused({ ...prod, PAYMENT_RESULT_SECRET: 'short' })).toBe(true);
    expect(refused({ ...prod, PAYMENT_RESULT_SECRET: 'k'.repeat(32) })).toBe(false);
  });
});
