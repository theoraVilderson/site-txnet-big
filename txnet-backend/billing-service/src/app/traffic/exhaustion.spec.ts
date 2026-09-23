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
import { suspendIfExhausted, walletCanBuy } from './exhaustion';

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
    $queryRaw: async () => {
      calls.push('wallet.lock');
      return input.balance === null ? [] : [{ cachedBalance: new Prisma.Decimal(input.balance) }];
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

    expect(calls.indexOf('wallet.lock')).toBeGreaterThan(-1);
    expect(calls.lastIndexOf('grant.read')).toBeGreaterThan(calls.indexOf('wallet.lock'));
    expect(calls.indexOf('grant.write')).toBeGreaterThan(calls.lastIndexOf('grant.read'));
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
