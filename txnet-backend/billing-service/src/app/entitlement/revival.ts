import { GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';

import { walletCanBuy } from '../traffic/exhaustion';
import { HAS_VPN_METER, VPN_RATE_SELECT } from '../traffic/vpn-meter';
import { withinCap } from '../usage/cap-funding';
import { reviveOnTopUp } from './purge';
import { emitReactivated, runs } from './reactivated';
import { SPENT_REASONS } from './suspension';

/**
 * What a top-up revives (F-027-ap, ADR-0079).
 *
 * ADR-0075 promised that a top-up returns a suspended Grant to `active` from
 * either stage, and F-027-y built the write that does it. This is what decides
 * *when* — the credit itself, in the transaction that lands the money, so the
 * balance and the service coming back commit or roll back together. A balance
 * a user can see while their service is still off is a support ticket.
 *
 * **The guard is the suspension's own predicate, deliberately.**
 * `suspendIfExhausted` suspends when `walletCanBuy` is false; this revives
 * when it is true, at the Grant's own locked rate (ADR-0073). Written as a
 * second rule about money — "any credit revives" — the two would be free to
 * drift the day either is changed, and the symptom would land on the purge
 * clock: `suspendedAt` is that clock, `reviveOnTopUp` clears it, and a Grant
 * revived on a balance that funds nothing is re-suspended on the next pass
 * with its clock reset, for ever.
 *
 * In practice that end is narrow, and it is worth being exact rather than
 * dramatic about it: balances are `Decimal(18, 2)` and a block floors to one
 * cent, so at any ordinary rate every positive balance funds a block. What is
 * genuinely caught here is a balance still at zero, and a rate no arithmetic
 * can price — a catalog fault that would otherwise become a user whose service
 * flaps for ever.
 *
 * **A rate that cannot be priced at all still throws**, as it does in
 * `walletCanBuy`: it is the catalog's fault and not the payer's, and swallowing
 * it here would quietly skip that Grant on every credit for the rest of its
 * life. Letting it propagate rolls the credit back with it, loudly.
 */

/** What one credit's revival did. */
export type Revivals = {
  /** Suspended-for-quota Grants this user holds. Zero where the balance made the question moot. */
  scanned: number;
  /** How many of them the new balance funded a block at, and so came back. */
  revived: number;
};

/**
 * Revive every Grant of this user that the new balance now funds, in the
 * caller's transaction.
 *
 * `balance` is the wallet's balance **after** the credit — `balanceAfter` off
 * the ledger row, which is the figure that transaction has already committed
 * to, rather than a re-read that could see someone else's debit.
 *
 * A non-positive balance is answered without a query. This runs on every
 * credit to every user wallet on the platform, and the overwhelmingly common
 * case is a user with nothing suspended at all; the cheapest form of that
 * answer is not asking.
 */
export async function reviveFundedGrants(
  tx: Prisma.TransactionClient,
  userId: string,
  balance: Prisma.Decimal,
  at: Date = new Date(),
): Promise<Revivals> {
  if (balance.lte(0)) return { scanned: 0, revived: 0 };

  const suspended = await tx.grant.findMany({
    where: {
      userId,
      status: GrantStatus.suspended,
      // Only the reason this module imposed. `suspended` also means an admin
      // or a tenant status change (ADR-0075), and a top-up buys traffic, not
      // an amnesty — `reviveOnTopUp` refuses those again in its own `where`.
      // `cap_reached` too (F-118-t): a cap write runs this, and money a
      // monthly cap's new period lets through revives it the same way.
      statusReason: { in: [...SPENT_REASONS] },
      billingMode: VariantBillingMode.metered,
      ...HAS_VPN_METER,
    },
    select: { id: true, tenantId: true, suspendedAt: true, endsAt: true, ...VPN_RATE_SELECT },
  });
  if (suspended.length === 0) return { scanned: 0, revived: 0 };

  let revived = 0;
  for (const grant of suspended) {
    // A Grant its spending cap cut stays cut until the cap is raised (F-118-i).
    if (!walletCanBuy(grant.meters[0].unitPrice, await withinCap(tx, { id: grant.id, userId }, balance))) continue;
    const revival = await reviveOnTopUp(tx, grant.id);
    if (!revival.revived) continue;
    revived++;
    // F-601-k: told once per suspension undone, unless its end has passed —
    // the planner keeps that one closed, and "active again" would be false.
    if (grant.suspendedAt && runs(grant.endsAt, at)) {
      await emitReactivated(tx, { grantId: grant.id, tenantId: grant.tenantId, userId }, grant.suspendedAt);
    }
  }

  return { scanned: suspended.length, revived };
}
