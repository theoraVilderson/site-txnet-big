import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MAX_DELTAS_PER_MESSAGE,
  NETWORK_USAGE_ROUTING_PREFIX,
  USAGE_DELTA_MESSAGE_VERSION,
  USAGE_DELTA_ROUTING_KEY,
  usageDeltaMessageSchema,
  usageDeltaRowSchema,
  usageQuarantineRowSchema,
  usageUnattributedRowSchema,
} from './usage-delta';

/**
 * The TypeScript half of the usage-delta wire (F-027-m, ADR-0036, C-04/C-08).
 *
 * `network-service` writes this message in Go and is not in the Nx workspace,
 * so nothing imports anything across that boundary. `contracts/network/delta
 * .json` is the declared home of the routing key and of every field, and each
 * side is held to it by a test of its own — the Go half is
 * `network-service/internal/publish/delta_contract_test.go`. A field renamed
 * on one side arrives here as an absent value, and a delta silently worth zero
 * bytes is a bill nobody can reconstruct afterwards.
 */
const FIXTURE = join(__dirname, '../../../../../contracts/network/delta.json');

type DeclaredField = { name: string; type: string };
type Fixture = {
  version: number;
  exchange: { default: string };
  routingKeys: { prefix: string; usageDelta: string };
  maxDeltasPerMessage: number;
  message: {
    envelope: DeclaredField[];
    delta: DeclaredField[];
    quarantine: DeclaredField[];
    unattributed: DeclaredField[];
  };
};

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;

describe('contracts/network/delta.json', () => {
  it('declares the routing key and the version this side reads', () => {
    expect(USAGE_DELTA_ROUTING_KEY).toBe(fixture.routingKeys.usageDelta);
    expect(NETWORK_USAGE_ROUTING_PREFIX).toBe(fixture.routingKeys.prefix);
    expect(USAGE_DELTA_ROUTING_KEY.startsWith(NETWORK_USAGE_ROUTING_PREFIX)).toBe(true);
    expect(USAGE_DELTA_MESSAGE_VERSION).toBe(fixture.version);
    expect(MAX_DELTAS_PER_MESSAGE).toBe(fixture.maxDeltasPerMessage);
  });

  it.each([
    ['envelope', usageDeltaMessageSchema, fixture.message.envelope],
    ['delta', usageDeltaRowSchema, fixture.message.delta],
    ['quarantine', usageQuarantineRowSchema, fixture.message.quarantine],
    ['unattributed', usageUnattributedRowSchema, fixture.message.unattributed],
  ])('parses exactly the fields %s declares', (_name, schema, declared) => {
    expect(Object.keys(schema.shape)).toEqual(declared.map((field) => field.name));
  });

  /**
   * The reason `bytes` is a string in the fixture: both ends store the figure
   * in a BIGINT, and a JSON number past 2^53 is already wrong by the time
   * `JSON.parse` has returned it. So the schema refuses a number here, rather
   * than coercing one and billing the rounded value.
   */
  it('refuses a byte figure that arrived as a JSON number', () => {
    const body = JSON.parse(
      '{"remoteIdentifier":"stranger","upBytes":9007199254740993,"downBytes":"0","observedAt":"2026-09-21T10:00:00Z"}',
    );
    expect(usageUnattributedRowSchema.safeParse(body).success).toBe(false);
  });

  it('parses a message the Go side would send, bytes and all', () => {
    const parsed = usageDeltaMessageSchema.parse({
      version: 1,
      panelId: '11111111-1111-1111-1111-111111111111',
      ownershipType: 'tenant',
      tenantId: '22222222-2222-2222-2222-222222222222',
      observedAt: '2026-09-21T10:00:00Z',
      chunk: 1,
      chunks: 1,
      deltas: [
        {
          deltaId: '9d2a4a0e-0000-5000-8000-000000000000',
          configId: '33333333-3333-3333-3333-333333333333',
          remoteId: 'c1',
          protocol: 'vless',
          upBytes: '9007199254740993',
          downBytes: '4096',
          observedAt: '2026-09-21T10:00:00Z',
          sessionId: '',
          afterReset: true,
        },
      ],
      quarantines: [],
      unattributed: [],
    });
    expect(parsed.deltas[0].upBytes).toBe('9007199254740993');
    // Not a BigInt literal: this spec's tsconfig targets below ES2020.
    expect(BigInt(parsed.deltas[0].upBytes)).toBe(BigInt('9007199254740993'));
  });

  /** Invariant 9: a platform panel has no tenant, and says so as null. */
  it('accepts a platform pass with no tenant', () => {
    const parsed = usageDeltaMessageSchema.parse({
      version: 1,
      panelId: '11111111-1111-1111-1111-111111111111',
      ownershipType: 'platform',
      tenantId: null,
      observedAt: '2026-09-21T10:00:00Z',
      chunk: 1,
      chunks: 1,
      deltas: [],
      quarantines: [],
      unattributed: [],
    });
    expect(parsed.tenantId).toBeNull();
  });
});
