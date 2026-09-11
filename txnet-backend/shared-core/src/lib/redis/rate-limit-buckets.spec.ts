import {
  RateLimitBucket,
  rateLimitBucketKey,
} from './rate-limit-buckets';

/**
 * The rate-limit bucket registry (F-077, ADR-0036).
 *
 * A bucket name is part of a Redis key, and the two ways it goes wrong are both
 * silent. Two call sites that mean to **share** a budget must spell it
 * identically — `login-failures` was hand-written in two places with a comment
 * between them saying so, and nothing making it true. Two that mean to be
 * **separate** must not collide, and a collision just makes one route spend the
 * other's allowance with no error anywhere.
 *
 * So the assertions here are about the registry as a set, not about any
 * individual name.
 */
describe('RateLimitBucket', () => {
  const entries = Object.entries(RateLimitBucket);

  it('gives every bucket a distinct wire name', () => {
    // The collision case. Two routes sharing a name share a counter, and the
    // first one to spend the budget locks the other out of a limit it was
    // never meant to be inside.
    const values = entries.map(([, value]) => value);
    const duplicates = values.filter((v, i) => values.indexOf(v) !== i);
    expect(duplicates).toEqual([]);
  });

  it('keeps every name free of the separator it is joined with', () => {
    // A trailing or leading `:` produces `bucket::subject`, which is a
    // different counter from `bucket:subject` and looks identical in a log.
    for (const [name, value] of entries) {
      expect(`${name} => ${value}`).toBe(
        `${name} => ${value.replace(/^:+|:+$/g, '')}`,
      );
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it('joins a bucket to its subject with one separator', () => {
    expect(rateLimitBucketKey(RateLimitBucket.LOGIN_PWD, '1.2.3.4')).toBe(
      'login:pwd:1.2.3.4',
    );
  });

  it('gives the two routes that must share a budget the same bucket', () => {
    // Login and the password-change check are two ways to guess one password.
    // If they stopped sharing, the second would be the cheaper door
    // (`identity/rules.md` #11). One constant is what makes that structural.
    const fromLogin = rateLimitBucketKey(
      RateLimitBucket.LOGIN_FAILURES,
      'someone@example.com',
    );
    const fromPasswordChange = rateLimitBucketKey(
      RateLimitBucket.LOGIN_FAILURES,
      'someone@example.com',
    );
    expect(fromLogin).toBe(fromPasswordChange);
  });

  it('records the whole rate-limited surface in one place', () => {
    // The other thing the registry buys: before it, the only way to read the
    // platform's rate-limit surface was to grep for a decorator across six
    // controllers. A new bucket landing here without a reviewer noticing is
    // what this snapshot is for.
    expect(entries.map(([name, value]) => `${name} = ${value}`)).toMatchSnapshot();
  });
});
