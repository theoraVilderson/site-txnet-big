import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  REDIS_KEYSPACE_VERSION_DEFAULT,
  REDIS_KEY_NAMESPACE_DEFAULT,
  buildRedisKeyPrefix,
  normalizeRedisNamespace,
} from './keyspace';

/**
 * The TypeScript half of the keyspace contract (ADR-0036, C-03).
 *
 * The Go half is `auth-handler/internal/config/keyspace_contract_test.go`,
 * against the same `contracts/redis/keyspace.json`. It replaces the thing this
 * repo used to do instead: a TypeScript transcription of the Go function,
 * living inside a spec, compared against the real Node implementation. That
 * tested that two TypeScript functions agreed — it could never have caught the
 * Go side drifting, which is the only drift that matters here.
 */

const FIXTURE = join(__dirname, '../../../../../contracts/redis/keyspace.json');

interface KeyspaceFixture {
  namespaceDefault: string;
  version: string;
  prefixCases: Array<{ namespace: string; version: string; prefix: string }>;
}

const fixture = JSON.parse(
  readFileSync(FIXTURE, 'utf8'),
) as KeyspaceFixture;

describe('contracts/redis/keyspace.json', () => {
  it('declares the one keyspace version every service shares', () => {
    // A default that disagrees with itself splits the fleet across two live
    // keyspaces, which is what F-075 found: 8 sessions under v1, 7 under v2.
    expect(fixture.version).toBe(REDIS_KEYSPACE_VERSION_DEFAULT);
  });

  it('declares the one default namespace', () => {
    expect(fixture.namespaceDefault).toBe(REDIS_KEY_NAMESPACE_DEFAULT);
  });

  it.each(fixture.prefixCases)(
    'builds $prefix from namespace $namespace and version $version',
    ({ namespace, version, prefix }) => {
      expect(buildRedisKeyPrefix(namespace, version)).toBe(prefix);
    },
  );

  it('applies the declared defaults when nothing is configured', () => {
    expect(buildRedisKeyPrefix()).toBe(
      `${fixture.namespaceDefault}:${fixture.version}:`,
    );
  });
});

describe('normalizeRedisNamespace', () => {
  it('strips any number of trailing colons and is idempotent', () => {
    // Both languages normalise. A namespace normalised twice must be the same
    // string, or belt and braces becomes its own source of drift.
    expect(normalizeRedisNamespace('txnet:auth::')).toBe('txnet:auth');
    expect(normalizeRedisNamespace(normalizeRedisNamespace('txnet:auth::'))).toBe(
      'txnet:auth',
    );
  });

  it('leaves interior colons alone', () => {
    expect(normalizeRedisNamespace('txnet:auth:eu')).toBe('txnet:auth:eu');
  });
});
