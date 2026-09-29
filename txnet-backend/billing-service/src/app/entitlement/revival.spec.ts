/**
 * What a top-up revives (F-027-ap, ADR-0079).
 *
 * F-027-y built `reviveOnTopUp` and left it without a caller. This is the
 * caller, and what it must get right is that **the revive and the suspend are
 * one rule, not two.** The guard is `walletCanBuy` — the exact predicate
 * `suspendIfExhausted` suspended on — so the two cannot drift apart when one
 * of them is next changed. Where they would show the drift is the purge clock:
 * `suspendedAt` *is* that clock and a revive clears it, so a Grant revived on
 * a balance that funds nothing is re-suspended on the next pass with its clock
 * reset, for ever.
 *
 * The realistic shape of that is narrow and worth naming, so nobody reads more
 * into these tests than is there. `cachedBalance` is `Decimal(18, 2)` and
 * `sizeBlock` floors a block to one cent, so at any sane rate every positive
 * balance funds one: a user topping up a cent at a time buys a cent of traffic
 * and is exploiting nothing. What is left for the guard is the degenerate end —
 * a balance still at zero, and a rate no arithmetic can price.
 *
 * The last block in this file is the other half of the decision: that the four
 * call sites stay four, and a fifth cannot quietly credit a balance and leave
 * the service off.
 *
 * It also revives only what a top-up may revive: this user, metered, suspended
 * for quota. `reviveOnTopUp` holds the `statusReason` half in its own `where`
 * (`purge.spec.ts`); what is proved here is that the scan never offers it
 * anything else.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import { GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';

import { reviveFundedGrants } from './revival';
import { QUOTA_EXHAUSTED } from './suspension';

const GRANT_1 = '99999999-9999-4999-8999-999999999991';
const GRANT_2 = '99999999-9999-4999-8999-999999999992';
const USER = '88888888-8888-4888-8888-888888888881';

const D = (n: string) => new Prisma.Decimal(n);

/** An ordinary metered price: 1.00 of base currency per GiB. */
const RATE = D('1.00000000');
/**
 * A rate one cent cannot buy a single byte at — `sizeBlock` refuses it
 * `block_below_one_byte`. It takes a price above 2^30/100 per GiB to get
 * there, which is why this is the degenerate end and not a normal case.
 */
const UNPRICEABLE = D('20000000.00000000');

/** A suspended Grant and its `vpn.traffic` meter's `unitPrice` (F-118-l). */
type Suspended = { id: string; rate: Prisma.Decimal };

function build(suspended: Suspended[]) {
  const scans: Array<Record<string, unknown>> = [];
  const revived: string[] = [];

  const tx = {
    grant: {
      findMany: async (args: Record<string, unknown>) => {
        scans.push(args);
        return suspended.map((g) => ({ id: g.id, meters: [{ unitPrice: g.rate, currencyCode: 'USD' }] }));
      },
      updateMany: async ({ where }: { where: Record<string, unknown> }) => {
        revived.push(where['id'] as string);
        return { count: 1 };
      },
    },
    config: { updateMany: async () => ({ count: 2 }) },
  };

  return { tx, scans, revived };
}

describe('reviveFundedGrants', () => {
  it('revives a Grant the new balance can buy a block at', async () => {
    const { tx, revived } = build([{ id: GRANT_1, rate: RATE }]);

    const result = await reviveFundedGrants(tx as never, USER, D('5.00'));

    expect(result).toEqual({ scanned: 1, revived: 1 });
    expect(revived).toEqual([GRANT_1]);
  });

  it('does not read the Grants at all when the balance is not positive', async () => {
    const { tx, scans } = build([{ id: GRANT_1, rate: RATE }]);

    // The common case by far — the wallet was empty, and this credit went
    // somewhere else. The scan runs on every credit in the platform, so the
    // cheapest answer is not asking.
    expect(await reviveFundedGrants(tx as never, USER, D('0'))).toEqual({ scanned: 0, revived: 0 });
    expect(scans).toHaveLength(0);
  });

  it('judges each Grant against its own locked rate', async () => {
    const { tx, revived } = build([
      { id: GRANT_1, rate: RATE },
      { id: GRANT_2, rate: UNPRICEABLE },
    ]);

    const result = await reviveFundedGrants(tx as never, USER, D('0.01'));

    // One cent buys ~10 MB at the first rate and not one byte at the second,
    // and the rate is the Grant's own (ADR-0073) — so one comes back and one
    // stays suspended, on the same credit.
    expect(result).toEqual({ scanned: 2, revived: 1 });
    expect(revived).toEqual([GRANT_1]);
  });

  it("asks only for this user's metered Grants suspended for quota", async () => {
    const { tx, scans } = build([]);

    const result = await reviveFundedGrants(tx as never, USER, D('5.00'));

    expect(result).toEqual({ scanned: 0, revived: 0 });
    expect(scans[0]['where']).toEqual({
      userId: USER,
      status: GrantStatus.suspended,
      statusReason: QUOTA_EXHAUSTED,
      billingMode: VariantBillingMode.metered,
      meters: { some: { meterKey: 'vpn.traffic' } },
    });
  });
});

/**
 * The guard on the four call sites (ADR-0079).
 *
 * The decision's one soft spot is that it is a responsibility spread over four
 * places: a fifth user-wallet credit added by someone who has not read the ADR
 * would credit the balance and leave the service off, and nothing about that
 * looks wrong at the call site. So the rule is checked here rather than
 * trusted — a class that holds `WalletLedgerService` may **debit** it (the
 * block purchase does, and a debit revives nothing), but the only place a
 * credit is written is the wrapper.
 */
describe('every user-wallet credit goes through WalletCreditService', () => {
  const APP = join(__dirname, '..');

  /** `wallet-credit.service.ts` is the wrapper itself; the ledger is what it wraps. */
  const ALLOWED = new Set(['wallet-credit.service.ts', 'wallet-ledger.service.ts']);

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return sources(full);
      if (!e.name.endsWith('.ts') || e.name.includes('.spec.')) return [];
      return [full];
    });
  }

  it('leaves no direct ledger credit outside the wrapper', () => {
    const offenders = sources(APP).filter((file) => {
      if (ALLOWED.has(basename(file))) return false;
      const text = readFileSync(file, 'utf8');
      return text.includes('WalletLedgerService') && /\.credit\(/.test(text);
    });

    expect(offenders.map((f) => relative(APP, f))).toEqual([]);
  });
});
