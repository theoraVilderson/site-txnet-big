/**
 * Exhaustion — a spent bag and a short wallet suspend the Grant (F-027-x, ADR-0075).
 *
 * What breaks without anyone seeing it:
 *  - **`exhausted` instead of `suspended`.** `grant_status_one_way` makes
 *    `exhausted` terminal, so the top-up the user makes next could never
 *    revive the Grant it paid for (entitlement invariant 12);
 *  - **a suspension with no clock.** Without `suspendedAt` the purge never
 *    comes due and the panel seat is held forever (invariant 11);
 *  - **one config left enabled.** A Grant lives on every panel its configs do;
 *    disabling the one the loop happened to see leaves the user on the others;
 *  - **a paying user suspended.** A top-up committing between the balance read
 *    and the suspension would be undone by it — the wallet is locked first;
 *  - **a user with bytes left, or money left, cut off.** Both halves must hold.
 */
import { GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';

import { QUOTA_EXHAUSTED } from '../entitlement/suspension';
import { suspendIfClosed, suspendIfExhausted, walletCanBuy } from './exhaustion';

const GRANT = '77777777-7777-4777-8777-777777777777';
const USER = '44444444-4444-4444-8444-444444444444';
const RATE = new Prisma.Decimal('0.5');
const AT = new Date('2026-09-23T10:00:00Z');

type GrantRow = {
  userId: string;
  status: GrantStatus;
  billingMode: VariantBillingMode;
  meteredRate: Prisma.Decimal | null;
  purchasedBytes: bigint;
  consumedBytes: bigint;
};

function fakeTx(input: { grant: Partial<GrantRow> | null; balance: string | null }) {
  const grant: GrantRow | null = input.grant
    ? {
        userId: USER,
        status: GrantStatus.active,
        billingMode: VariantBillingMode.metered,
        meteredRate: RATE,
        purchasedBytes: BigInt(1000),
        consumedBytes: BigInt(1000),
        ...input.grant,
      }
    : null;
  const calls: string[] = [];
  const grantWrites: { where: unknown; data: Record<string, unknown> }[] = [];
  const configWrites: { where: unknown; data: Record<string, unknown> }[] = [];
  const tx = {
    grant: {
      findUnique: async () => {
        calls.push('grant.read');
        return grant;
      },
      updateMany: async (args: { where: { status?: GrantStatus }; data: Record<string, unknown> }) => {
        calls.push('grant.write');
        grantWrites.push(args);
        return { count: grant && grant.status === args.where.status ? 1 : 0 };
      },
    },
    config: {
      updateMany: async (args: { where: unknown; data: Record<string, unknown> }) => {
        calls.push('config.write');
        configWrites.push(args);
        return { count: 3 };
      },
    },
    // No wallet row: the reserve release (F-118-b) holds nothing here; vpn-reserve.spec.ts holds it.
    // No postpaid vpn.traffic meter: a prepaid Grant's path (F-118-k).
    grantMeter: { findUnique: async () => null },
    wallet: { findUnique: async () => null },
    // The cutoff notice (F-601-b) — cut-off.spec.ts holds what it says.
    outboxEvent: { create: async () => ({ id: 'e1' }) },
    $queryRaw: async () => {
      calls.push('wallet.lock');
      return input.balance === null ? [] : [{ free: new Prisma.Decimal(input.balance) }];
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, calls, grantWrites, configWrites };
}

describe('suspendIfExhausted', () => {
  it('suspends a Grant whose bag is spent and whose wallet cannot fund a cent — suspended, never exhausted', async () => {
    const { tx, grantWrites } = fakeTx({ grant: {}, balance: '0.00' });

    const outcome = await suspendIfExhausted(tx, GRANT, AT);

    expect(outcome).toEqual({ grantId: GRANT, verdict: 'suspended', configsDisabled: 3 });
    expect(grantWrites).toEqual([
      {
        where: { id: GRANT, status: GrantStatus.active },
        data: { status: GrantStatus.suspended, statusReason: QUOTA_EXHAUSTED, suspendedAt: AT },
      },
    ]);
    expect(QUOTA_EXHAUSTED).toBe('quota_exhausted');
  });

  it('disables every config of the Grant, whichever panel it lives on', async () => {
    const { tx, configWrites } = fakeTx({ grant: {}, balance: '0.00' });

    await suspendIfExhausted(tx, GRANT, AT);

    // Scoped by the Grant alone — no panel, no status, no config id.
    expect(configWrites).toEqual([{ where: { grantId: GRANT, desiredEnabled: true }, data: { desiredEnabled: false } }]);
  });

  it('suspends a Grant a panel served past its bag — an overrun is spent, not credit', async () => {
    const { tx } = fakeTx({ grant: { consumedBytes: BigInt(1500) }, balance: '0.00' });

    expect((await suspendIfExhausted(tx, GRANT, AT)).verdict).toBe('suspended');
  });

  it('treats a user with no wallet row as one with an empty wallet', async () => {
    const { tx } = fakeTx({ grant: {}, balance: null });

    expect((await suspendIfExhausted(tx, GRANT, AT)).verdict).toBe('suspended');
  });

  it('locks the wallet before it reads the cursors, so a top-up is either seen or waits for the suspension', async () => {
    const { tx, calls } = fakeTx({ grant: {}, balance: '0.00' });

    await suspendIfExhausted(tx, GRANT, AT);

    // The cursors' read is the first after the lock; the reserve release reads again after the write.
    const read = calls.indexOf('grant.read', calls.indexOf('wallet.lock'));
    expect(calls.indexOf('wallet.lock')).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(calls.indexOf('wallet.lock'));
    expect(calls.indexOf('grant.write')).toBeGreaterThan(read);
  });

  it.each([
    ['a bag with bytes left', { consumedBytes: BigInt(999) }, '0.00', 'bag_not_empty'],
    ['a wallet that still funds a cent', {}, '0.01', 'wallet_can_buy'],
    ['a prepaid Grant', { billingMode: VariantBillingMode.prepaid, meteredRate: null }, '0.00', 'not_metered'],
    ['a Grant already suspended', { status: GrantStatus.suspended }, '0.00', 'not_active'],
    ['a Grant already expired', { status: GrantStatus.expired }, '0.00', 'not_active'],
  ] as const)('leaves %s alone and writes nothing', async (_name, grant, balance, verdict) => {
    const { tx, grantWrites, configWrites } = fakeTx({ grant, balance });

    const outcome = await suspendIfExhausted(tx, GRANT, AT);

    expect(outcome).toEqual({ grantId: GRANT, verdict, configsDisabled: 0 });
    expect(grantWrites).toHaveLength(0);
    expect(configWrites).toHaveLength(0);
  });

  it('answers a missing Grant without locking anything', async () => {
    const { tx, calls } = fakeTx({ grant: null, balance: '0.00' });

    expect((await suspendIfExhausted(tx, GRANT, AT)).verdict).toBe('grant_not_found');
    expect(calls).toEqual(['grant.read']);
  });

  it('disables nothing when the Grant moved out of active between the read and the write', async () => {
    const { tx, configWrites } = fakeTx({ grant: {}, balance: '0.00' });
    // The conditional write matches no row: another pass suspended it first.
    (tx.grant as unknown as { updateMany: () => Promise<{ count: number }> }).updateMany = async () => ({ count: 0 });

    expect(await suspendIfExhausted(tx, GRANT, AT)).toEqual({ grantId: GRANT, verdict: 'not_active', configsDisabled: 0 });
    expect(configWrites).toHaveLength(0);
  });
});

describe('walletCanBuy', () => {
  it.each([
    ['0.00', false],
    ['0.009', false],
    ['0.01', true],
    ['12.34', true],
  ])('a balance of %s funds a block: %s', (balance, expected) => {
    expect(walletCanBuy(RATE, new Prisma.Decimal(balance))).toBe(expected);
  });

  it('is short at a rate so high that a cent buys no whole byte', () => {
    expect(walletCanBuy(new Prisma.Decimal('9999999999.99999999'), new Prisma.Decimal('0.01'))).toBe(false);
  });

  it('does not read an unpriceable rate as a short wallet — that refusal is the purchase path’s', () => {
    expect(() => walletCanBuy(new Prisma.Decimal(0), new Prisma.Decimal('5'))).toThrow(/rate_not_priceable/);
  });
});

/**
 * A prepaid Grant the planner closed is suspended (F-027-dw, ADR-0096).
 *
 * The planner already cut the user off (`network/contract.lease.md` rule 24);
 * this makes the close a state billing, the panel, the bot and `/sub` all
 * read. What breaks without anyone seeing it:
 *  - **a renewal undone.** A renewal that raised Quota after the close was
 *    written reopens it; the event arrives late and must not suspend a Grant
 *    that has bytes again — the close row is read *now*, against Quota *now*;
 *  - **a metered Grant suspended with money in the wallet.** Its exhaustion
 *    is the block path's (`suspendIfExhausted`), never the close;
 *  - **an unlimited Grant, or one no longer active, touched at all.**
 */
describe('suspendIfClosed', () => {
  type Row = { status: GrantStatus; billingMode: VariantBillingMode; trafficUnlimited: boolean; purchasedBytes: bigint };

  function closedTx(input: { grant: Partial<Row> | null; closedAt: bigint | null }) {
    const grant: Row | null = input.grant
      ? { status: GrantStatus.active, billingMode: VariantBillingMode.prepaid, trafficUnlimited: false, purchasedBytes: BigInt(1000), ...input.grant }
      : null;
    const calls: string[] = [];
    const grantWrites: { where: unknown; data: Record<string, unknown> }[] = [];
    const tx = {
      $queryRaw: async (sql: TemplateStringsArray) => {
        const text = sql.join('?');
        if (text.includes('entitlement"."grant"')) {
          calls.push(text.includes('FOR UPDATE') ? 'grant.lock' : 'grant.read');
          return grant ? [grant] : [];
        }
        calls.push('close.read');
        return input.closedAt === null ? [] : [{ quotaBytes: input.closedAt }];
      },
      grant: {
        // The reserve release (F-118-b) reads the Grant; vpn-reserve.spec.ts holds it.
        findUnique: async () => null,
        updateMany: async (args: { where: { status?: GrantStatus }; data: Record<string, unknown> }) => {
          calls.push('grant.write');
          grantWrites.push(args);
          return { count: grant && grant.status === args.where.status ? 1 : 0 };
        },
      },
      config: {
        updateMany: async () => {
          calls.push('config.write');
          return { count: 2 };
        },
      },      outboxEvent: { create: async () => ({ id: 'e1' }) },
    };
    return { tx: tx as unknown as Prisma.TransactionClient, calls, grantWrites };
  }

  it('suspends a prepaid Grant whose close stands on its Quota — quota_exhausted, with a clock, every config off', async () => {
    const { tx, calls, grantWrites } = closedTx({ grant: {}, closedAt: BigInt(1000) });
    await expect(suspendIfClosed(tx, GRANT, AT)).resolves.toEqual({ grantId: GRANT, verdict: 'suspended', configsDisabled: 2 });
    expect(grantWrites[0].data).toEqual({ status: GrantStatus.suspended, statusReason: QUOTA_EXHAUSTED, suspendedAt: AT });
    // The Grant row is locked before the close is read: a renewal waits, then finds it suspended and revives it.
    expect(calls).toEqual(['grant.lock', 'close.read', 'grant.write', 'config.write']);
  });

  it('suspends nothing once a renewal moved Quota past the close, or the close was deleted', async () => {
    for (const closedAt of [BigInt(900), null]) {
      const { tx, grantWrites } = closedTx({ grant: {}, closedAt });
      await expect(suspendIfClosed(tx, GRANT, AT)).resolves.toMatchObject({ verdict: 'reopened' });
      expect(grantWrites).toEqual([]);
    }
  });

  it('leaves a metered, an unlimited, a missing and a non-active Grant alone', async () => {
    const cases: [Partial<Row> | null, string][] = [
      [{ billingMode: VariantBillingMode.metered }, 'not_prepaid'],
      [{ trafficUnlimited: true }, 'unlimited'],
      [{ status: GrantStatus.suspended }, 'not_active'],
      [null, 'grant_not_found'],
    ];
    for (const [grant, verdict] of cases) {
      const { tx, grantWrites } = closedTx({ grant, closedAt: BigInt(1000) });
      await expect(suspendIfClosed(tx, GRANT, AT)).resolves.toMatchObject({ verdict });
      expect(grantWrites).toEqual([]);
    }
  });
});
