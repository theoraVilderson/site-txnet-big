import { envSchema, validateEnv } from './env.validation';

/**
 * `billing-service`'s env schema (F-089, ADR-0036).
 *
 * This service was the one deployable that could start with a typo'd variable
 * and report itself healthy, because it read `process.env` raw. The assertions
 * below are about that: what a missing variable does, and what the empty string
 * compose actually sends does.
 */
describe('envSchema', () => {
  it('starts with nothing configured', () => {
    // A scaffold has to stay runnable with an empty environment, or the schema
    // is a reason not to run it rather than a check on it.
    const env = validateEnv({});
    expect(env.PORT).toBe(3000);
    expect(env.GLOBAL_PREFIX).toBe('api');
    expect(env.NODE_ENV).toBe('development');
  });

  it('coerces the port compose passes as a string', () => {
    expect(validateEnv({ PORT: '4000' }).PORT).toBe(4000);
  });

  it('refuses a port that is not a usable one', () => {
    // The whole point of validating: a nonsense port must stop the boot rather
    // than become `NaN` and bind somewhere unpredictable.
    expect(() => validateEnv({ PORT: 'not-a-number' })).toThrow();
    expect(() => validateEnv({ PORT: '0' })).toThrow();
    expect(() => validateEnv({ PORT: '-1' })).toThrow();
  });

  it('refuses an environment name it does not know', () => {
    expect(() => validateEnv({ NODE_ENV: 'staging' })).toThrow();
  });

  it('refuses an empty prefix rather than serving from the root', () => {
    // `''` would silently move every route, which is the kind of change that
    // must be asked for rather than fallen into.
    expect(() => validateEnv({ GLOBAL_PREFIX: '' })).toThrow();
  });

  it('names every variable it rejected, not just the first', () => {
    // The boot log is the only place an operator sees this, so one failure per
    // deploy attempt would make a misconfigured environment take several.
    let message: Record<string, unknown> = {};
    try {
      envSchema.parse({ PORT: 'x', NODE_ENV: 'staging' });
    } catch (error) {
      message = (error as { flatten: () => { fieldErrors: Record<string, unknown> } })
        .flatten().fieldErrors;
    }
    expect(Object.keys(message).sort()).toEqual(['NODE_ENV', 'PORT']);
  });
});
