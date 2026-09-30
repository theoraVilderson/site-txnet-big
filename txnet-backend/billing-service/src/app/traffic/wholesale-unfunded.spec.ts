/**
 * F-118-w — a reseller whose billing wallet cannot fund the wholesale leg is
 * told once per refusal spell that its users on platform panels are cut; a
 * block its wallet funds again on a platform panel ends the spell. The Grant
 * is never suspended for it: its own panels keep serving.
 */
import { GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';
import { BLOCK_REQUEST_MESSAGE_VERSION, OutboxEventType, type BlockRequestMessage } from '@txnet-backend/shared-core';

import { UsageSettlementRefused } from '../usage/usage-price';
import { BlockPurchaseRefused } from './block-purchase';
import { BlockRequestService } from './block-request';
import { noticeWholesaleUnfunded, rearmWholesaleNotice } from './wholesale-unfunded';

const NOW = new Date('2026-09-29T12:00:00Z');
const TOLD = new Date('2026-09-29T09:00:00Z');
const RESELLER = 'r1';
const GRANT = '4b0c7d1e-2f3a-4b5c-8d6e-7f8091a2b3c4';
const MB = BigInt(1 << 20);

type Update = { where: Record<string, unknown>; data: Record<string, unknown> };
type Event = { aggregate: string; aggregateId: string; type: string; payload: Record<string, unknown> };

type World = {
  /** The reseller wallet's marker; `undefined` is no wallet row. */
  noticeAt?: Date | null;
  /** Whether the Grant's group holds a platform panel. */
  platform?: boolean;
  /** The Grant's meter has a wholesale leg. */
  leg?: boolean;
  consumedBytes?: bigint;
  postpaid?: boolean;
};

function fakeTx(world: World = {}) {
  const wallet = { noticeAt: world.noticeAt === undefined ? null : world.noticeAt };
  const walletUpdates: Update[] = [];
  const grantUpdates: Update[] = [];
  const events: Event[] = [];
  const tx = {
    // No planner close (F-027-ec).
    leaseClose: { findUnique: async () => null },
    tenantBillingWallet: {
      findUnique: async () => ({ unfundedNoticeAt: wallet.noticeAt }),
      updateMany: async (args: Update) => {
        walletUpdates.push(args);
        const want = args.where['unfundedNoticeAt'];
        if ((want ?? null) !== wallet.noticeAt) return { count: 0 };
        wallet.noticeAt = args.data['unfundedNoticeAt'] as Date | null;
        return { count: 1 };
      },
    },
    tenant: { findUnique: async () => ({ ownerUserId: 'owner1' }) },
    productVariant: { findUnique: async () => ({ panelGroupId: 'pg1' }) },
    panelGroupMember: { findFirst: async () => (world.platform === false ? null : { panelId: 'p1' }) },
    grant: {
      findUnique: async () => ({
        id: GRANT,
        tenantId: RESELLER,
        userId: 'u',
        variantId: 'v1',
        status: GrantStatus.active,
        billingMode: VariantBillingMode.metered,
        trafficUnlimited: false,
        purchasedBytes: BigInt(400) * MB,
        consumedBytes: world.consumedBytes ?? BigInt(100) * MB,
        lowBalanceNoticeAt: null,
      }),
      updateMany: async (args: Update) => {
        grantUpdates.push(args);
        return { count: 1 };
      },
    },
    grantMeter: {
      findUnique: async () => ({ mode: 'prepaid', unitPrice: new Prisma.Decimal('0.5'), currencyCode: 'USD', wholesalePayerTenantId: world.leg === false ? null : RESELLER }),
    },
    wallet: { findUnique: async () => null },
    // The user's wallet still buys: the exhaustion check answers `wallet_can_buy`.
    $queryRaw: async () => [{ free: new Prisma.Decimal('50.00'), own: new Prisma.Decimal(0) }],
    config: { updateMany: async () => ({ count: 1 }) },
    outboxEvent: {
      create: async ({ data }: { data: Event }) => {
        events.push(data);
        return { id: 'e1' };
      },
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, wallet, walletUpdates, grantUpdates, events };
}

describe('noticeWholesaleUnfunded', () => {
  it('tells the reseller owner once, marking the spell in the same write', async () => {
    const { tx, walletUpdates, events } = fakeTx();
    expect(await noticeWholesaleUnfunded(tx, RESELLER, NOW)).toBe('told');
    expect(walletUpdates).toEqual([{ where: { tenantId: RESELLER, unfundedNoticeAt: null }, data: { unfundedNoticeAt: NOW } }]);
    expect(events).toEqual([
      {
        aggregate: 'tenant.billing',
        aggregateId: RESELLER,
        type: OutboxEventType.TENANT_WHOLESALE_UNFUNDED,
        payload: { tenantId: RESELLER, ownerUserId: 'owner1', period: NOW.toISOString() },
      },
    ]);
  });

  it('says nothing again while the spell stands: a second refusal, or a racing one, finds it marked', async () => {
    const { tx, events } = fakeTx({ noticeAt: TOLD });
    expect(await noticeWholesaleUnfunded(tx, RESELLER, NOW)).toBeNull();
    expect(events).toHaveLength(0);
  });
});

describe('rearmWholesaleNotice', () => {
  const meter = { wholesalePayerTenantId: RESELLER } as never;

  it('ends the spell when a block on a platform panel is funded again', async () => {
    const { tx, wallet } = fakeTx({ noticeAt: TOLD });
    expect(await rearmWholesaleNotice(tx, { variantId: 'v1' }, meter)).toBe(true);
    expect(wallet.noticeAt).toBeNull();
  });

  it('keeps it on a block of the reseller own panels only: that says nothing of the platform side', async () => {
    const { tx, wallet } = fakeTx({ noticeAt: TOLD, platform: false });
    expect(await rearmWholesaleNotice(tx, { variantId: 'v1' }, meter)).toBe(false);
    expect(wallet.noticeAt).toBe(TOLD);
  });

  it('writes nothing when no spell is open, or the meter has no wholesale leg', async () => {
    const open = fakeTx();
    expect(await rearmWholesaleNotice(open.tx, { variantId: 'v1' }, meter)).toBe(false);
    expect(open.walletUpdates).toHaveLength(0);
    const legless = fakeTx({ noticeAt: TOLD });
    expect(await rearmWholesaleNotice(legless.tx, { variantId: 'v1' }, { wholesalePayerTenantId: null } as never)).toBe(false);
    expect(legless.walletUpdates).toHaveLength(0);
  });
});

function message(): BlockRequestMessage {
  return {
    version: BLOCK_REQUEST_MESSAGE_VERSION,
    grantId: GRANT,
    purchasedBytes: (BigInt(400) * MB).toString(),
    targetBytes: (BigInt(2_000) * MB).toString(),
    rateBps: '100000000',
    requestedAt: '2026-09-29T12:00:00Z',
  };
}

function service(refuse?: Error, postpaid = false) {
  const blocks = {
    purchase: async (_tx: unknown, input: { grantId: string; targetBytes: bigint }) => {
      if (refuse) throw refuse;
      return { grantId: input.grantId, bytes: input.targetBytes, amount: new Prisma.Decimal(1), walletTransactionId: 'w', purchasedBytes: BigInt(0), billed: BigInt(0), balanceAfter: new Prisma.Decimal('100.00') };
    },
  };
  const reserve = {
    isPostpaid: async () => postpaid,
    servePostpaid: async () => {
      if (refuse) throw refuse;
      return { captured: new Prisma.Decimal(0), held: new Prisma.Decimal(1) };
    },
  };
  return new BlockRequestService({} as never, {} as never, blocks as never, reserve as never);
}

describe('BlockRequestService on a reseller at zero', () => {
  it('tells the reseller and keeps the Grant active, even with its bag spent', async () => {
    const { tx, grantUpdates, events } = fakeTx({ consumedBytes: BigInt(400) * MB });
    const outcome = await service(new BlockPurchaseRefused('wholesale_unfunded')).buyIn(tx, message());
    expect(outcome.refused).toBe('wholesale_unfunded');
    expect(outcome.wholesaleNotice).toBe('told');
    expect(outcome.exhausted?.verdict).toBe('wallet_can_buy');
    expect(grantUpdates).toHaveLength(0);
    expect(events.map((e) => e.type)).toEqual([OutboxEventType.TENANT_WHOLESALE_UNFUNDED]);
  });

  it('tells a postpaid Grant reseller the same way (F-118-n4)', async () => {
    const { tx, events } = fakeTx();
    const outcome = await service(new UsageSettlementRefused('wholesale_unfunded', 'short'), true).buyIn(tx, message());
    expect(outcome.refused).toBe('wholesale_unfunded');
    expect(outcome.wholesaleNotice).toBe('told');
    expect(events.map((e) => e.type)).toEqual([OutboxEventType.TENANT_WHOLESALE_UNFUNDED]);
  });

  it('tells nothing for a user short of funds: that is the user wallet, not the reseller', async () => {
    const { tx, events } = fakeTx();
    const outcome = await service(new BlockPurchaseRefused('insufficient_funds')).buyIn(tx, message());
    expect(outcome.wholesaleNotice).toBeNull();
    expect(events).toHaveLength(0);
  });

  it('re-arms the notice on the next block it funds on a platform panel', async () => {
    const { tx, wallet } = fakeTx({ noticeAt: TOLD });
    const outcome = await service().buyIn(tx, message());
    expect(outcome.bought).not.toBeNull();
    expect(outcome.wholesaleNotice).toBe('rearmed');
    expect(wallet.noticeAt).toBeNull();
  });
});
