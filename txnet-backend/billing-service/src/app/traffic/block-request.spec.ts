/**
 * F-027-dc — a metered Grant's block, asked for by the lease planner
 * (ADR-0093 amendment 2026-09-27).
 *
 * The planner sees the counter, so it says when; this side keeps the money, so
 * it decides whether. The wire is `contracts/network/block-request.json`,
 * whose Go half is `network-service/internal/publish/block_request_test.go`;
 * the reserve Go adds to Quota is held here to the same figures this side
 * prices a block with.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';
import {
  BLOCK_REQUEST_MESSAGE_VERSION,
  BLOCK_REQUEST_ROUTING_KEY,
  NETWORK_LEASE_ROUTING_PREFIX,
  WalletVersionConflict,
  blockRequestMessageSchema,
  type BlockRequestMessage,
} from '@txnet-backend/shared-core';

import { BlockPurchaseRefused, bytesAffordable } from './block-purchase';
import { BlockRequestService } from './block-request';
import { MIN_BLOCK_SECONDS } from './horizon';

const FIXTURE = join(__dirname, '../../../../../contracts/network/block-request.json');
type Fixture = {
  version: number;
  routingKeys: { prefix: string; blockRequest: string };
  message: { name: string; type: string }[];
  affordable: { rate: string; balance: string; bytes: string }[];
};
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;

const GRANT = '4b0c7d1e-2f3a-4b5c-8d6e-7f8091a2b3c4';
const MB = BigInt(1 << 20);
const RATE_BPS = BigInt(100_000_000); // 100 Mbit

describe('the block request wire', () => {
  it('publishes under the fixture key, outside the prefix metering dead-letters', () => {
    expect(BLOCK_REQUEST_ROUTING_KEY).toBe(fixture.routingKeys.blockRequest);
    expect(NETWORK_LEASE_ROUTING_PREFIX).toBe(fixture.routingKeys.prefix);
    expect(BLOCK_REQUEST_MESSAGE_VERSION).toBe(fixture.version);
    expect(BLOCK_REQUEST_ROUTING_KEY.startsWith('network.usage.')).toBe(false);
  });

  it('reads exactly the fields the fixture declares, and refuses a byte figure sent as a number', () => {
    expect(Object.keys(blockRequestMessageSchema.shape).sort()).toEqual(fixture.message.map((f) => f.name).sort());
    const good = message({});
    expect(blockRequestMessageSchema.safeParse(good).success).toBe(true);
    expect(blockRequestMessageSchema.safeParse({ ...good, targetBytes: 5 }).success).toBe(false);
  });

  it('prices the reserve to the same figures the planner adds to Quota', () => {
    for (const row of fixture.affordable) {
      expect(bytesAffordable(new Prisma.Decimal(row.rate), new Prisma.Decimal(row.balance)).toString()).toBe(row.bytes);
    }
  });
});

// ---- the purchase -------------------------------------------------------------

function message(input: Partial<BlockRequestMessage>): BlockRequestMessage {
  return {
    version: BLOCK_REQUEST_MESSAGE_VERSION,
    grantId: GRANT,
    purchasedBytes: (BigInt(400) * MB).toString(),
    targetBytes: (BigInt(2_000) * MB).toString(),
    rateBps: RATE_BPS.toString(),
    requestedAt: '2026-09-27T10:00:00Z',
    ...input,
  };
}

type GrantRow = {
  status?: GrantStatus;
  prepaid?: boolean;
  unlimited?: boolean;
  purchasedBytes?: bigint;
  consumedBytes?: bigint;
};

function fakeTx(row: GrantRow | null) {
  const suspensions: Record<string, unknown>[] = [];
  const grant = row && {
    id: GRANT,
    userId: 'u',
    status: row.status ?? GrantStatus.active,
    billingMode: row.prepaid ? VariantBillingMode.prepaid : VariantBillingMode.metered,
    meteredRate: row.prepaid ? null : new Prisma.Decimal('0.5'),
    trafficUnlimited: row.unlimited ?? false,
    purchasedBytes: row.purchasedBytes ?? BigInt(400) * MB,
    consumedBytes: row.consumedBytes ?? BigInt(0),
  };
  const tx = {
    grant: {
      findUnique: async () => grant,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        suspensions.push(data);
        return { count: 1 };
      },
    },
    $queryRaw: async () => [{ cachedBalance: new Prisma.Decimal('0.00') }],
    config: { updateMany: async () => ({ count: 1 }) },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, suspensions };
}

function service(refuse?: Error) {
  const purchases: { grantId: string; targetBytes: bigint }[] = [];
  const blocks = {
    purchase: async (_tx: unknown, input: { grantId: string; targetBytes: bigint }) => {
      purchases.push(input);
      if (refuse) throw refuse;
      return { grantId: input.grantId, bytes: input.targetBytes, amount: new Prisma.Decimal(1), walletTransactionId: 'w', purchasedBytes: BigInt(0), billedBytes: BigInt(0) };
    },
  };
  return { requests: new BlockRequestService({} as never, {} as never, blocks as never), purchases };
}

describe('BlockRequestService.buyIn', () => {
  it('buys the target the planner sized, on the bag it saw', async () => {
    const { tx } = fakeTx({});
    const { requests, purchases } = service();
    const outcome = await requests.buyIn(tx, message({}));
    expect(purchases).toEqual([{ grantId: GRANT, targetBytes: BigInt(2_000) * MB }]);
    expect(outcome.bought?.bytes).toBe(BigInt(2_000) * MB);
    expect(outcome.skipped).toBeNull();
  });

  it('raises a target under the block floor to a minute of the rate, so the ledger gets one row a minute at most', async () => {
    const { tx } = fakeTx({});
    const { requests, purchases } = service();
    await requests.buyIn(tx, message({ targetBytes: '1000' }));
    expect(purchases[0].targetBytes).toBe((RATE_BPS / BigInt(8)) * BigInt(MIN_BLOCK_SECONDS));
  });

  it('drops a request for a bag that has moved since: another block was bought first', async () => {
    const { tx } = fakeTx({ purchasedBytes: BigInt(900) * MB });
    const { requests, purchases } = service();
    const outcome = await requests.buyIn(tx, message({}));
    expect(outcome.skipped).toBe('stale');
    expect(purchases).toHaveLength(0);
  });

  it('buys nothing for a prepaid, unlimited, inactive or missing Grant', async () => {
    const cases: [GrantRow | null, string][] = [
      [{ prepaid: true }, 'not_metered'],
      [{ unlimited: true }, 'not_metered'],
      [{ status: GrantStatus.suspended }, 'not_active'],
      [null, 'grant_not_found'],
    ];
    for (const [row, reason] of cases) {
      const { requests, purchases } = service();
      const outcome = await requests.buyIn(fakeTx(row).tx, message({}));
      expect(outcome.skipped).toBe(reason);
      expect(purchases).toHaveLength(0);
    }
  });

  it('reports a short wallet while the bag still holds bytes, and suspends nothing', async () => {
    const { tx, suspensions } = fakeTx({ consumedBytes: BigInt(100) * MB });
    const { requests } = service(new BlockPurchaseRefused('insufficient_funds'));
    const outcome = await requests.buyIn(tx, message({}));
    expect(outcome.refused).toBe('insufficient_funds');
    expect(outcome.exhausted).toBeNull();
    expect(suspensions).toHaveLength(0);
  });

  it('asks about exhaustion when the bag is spent and the wallet cannot buy (F-027-x)', async () => {
    const { tx, suspensions } = fakeTx({ consumedBytes: BigInt(400) * MB });
    const { requests } = service(new BlockPurchaseRefused('insufficient_funds'));
    const outcome = await requests.buyIn(tx, message({}));
    expect(outcome.refused).toBe('insufficient_funds');
    expect(outcome.exhausted?.verdict).toBe('suspended');
    expect(suspensions).toHaveLength(1);
  });

  it('throws anything that is not a short wallet', async () => {
    const { tx } = fakeTx({});
    const { requests } = service(new Error('db down'));
    await expect(requests.buyIn(tx, message({}))).rejects.toThrow('db down');
  });
});

describe('BlockRequestService.handle', () => {
  it('answers a lost purchase race as raced, not a failure: the planner asks again on the new bag', async () => {
    const crossTenant = { grant: { findUnique: async () => ({ tenantId: 't' }) } };
    const requests = new BlockRequestService({} as never, crossTenant as never, {} as never);
    requests.buy = async () => {
      throw new WalletVersionConflict('w');
    };
    await expect(requests.handle(message({}))).resolves.toEqual({ grantId: GRANT, outcome: 'raced' });
  });

  it('drops a Grant it cannot find without buying, and a version it does not read by dead-lettering', async () => {
    const crossTenant = { grant: { findUnique: async () => null } };
    const requests = new BlockRequestService({} as never, crossTenant as never, {} as never);
    await expect(requests.handle(message({}))).resolves.toEqual({ grantId: GRANT, outcome: 'grant_not_found' });
    await expect(requests.handle(message({ version: 2 }))).rejects.toThrow('version 2');
  });
});
