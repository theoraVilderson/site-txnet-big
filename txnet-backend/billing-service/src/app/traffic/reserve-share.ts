import { GrantStatus, Prisma, VariantBillingMode, WalletHoldStatus } from '@prisma/client';
import { METER_KEYS } from '@txnet-backend/shared-core';

import { WalletHoldService, WalletLedgerService } from '../wallet/wallet-ledger.service';
import { HAS_VPN_METER } from './vpn-meter';

/**
 * A wallet's fair share per metered VPN Grant (F-118-ag, network
 * `contract.reserve.md` rule 6).
 *
 * The headroom billing holds past a bag — a prepaid Grant's reserve, a
 * postpaid one's floor — is a fixed size (`VPN_RESERVE_BYTES` at the rate).
 * Where the wallet is smaller than the sizes together, the first Grant to be
 * topped held all of it and the next held nothing: a second service stayed
 * `pending`, and a capped one was cut as "top up" with money in the wallet
 * (live run, 2026-09-30). Each such hold is now bounded by an even share of
 * what the owner has for headroom — the free balance plus those holds — so a
 * Grant short of its share takes it back from one holding more.
 *
 * A sibling's reserve is never **spent** here (billing `contract.holds.md`):
 * only the part above its share is released, as a suspension releases one,
 * and the short Grant then holds its own. Money a block already bought is not
 * headroom and is not shared. A postpaid floor counts in the pool but is not
 * released: part of it can be usage served and not yet captured.
 */

const ZERO = new Prisma.Decimal(0);
const HOLDS = new WalletHoldService(new WalletLedgerService());

/** The Grants the lease planner leases headroom to: `vpn-reserve.ts`'s and the planner's own condition. */
export const RESERVED_WHERE = {
  status: { in: [GrantStatus.active, GrantStatus.pending] },
  billingMode: VariantBillingMode.metered,
  ...HAS_VPN_METER,
  trafficUnlimited: false,
} satisfies Prisma.GrantWhereInput;

export type ReserveShare = {
  /** Whole cents: (free balance + the owner's headroom holds) ÷ `count`, rounded down. */
  share: Prisma.Decimal;
  /** The owner's leased VPN Grants, the asking one counted once whatever its status. */
  count: number;
  walletId: string;
  /** Open prepaid reserves of the other Grants — the only holds a share releases. */
  siblings: Array<{ grantId: string; amount: Prisma.Decimal }>;
};

/** The share of one Grant, or null where its owner has no wallet. */
export async function reserveShareOf(tx: Prisma.TransactionClient, grant: { id: string; userId: string }): Promise<ReserveShare | null> {
  const wallet = await tx.wallet.findUnique({ where: { ownerUserId: grant.userId } });
  if (!wallet) return null;
  const leased = (await tx.grant.findMany({ where: { userId: grant.userId, ...RESERVED_WHERE }, select: { id: true } })).map((g) => g.id);
  const count = leased.length + (leased.includes(grant.id) ? 0 : 1);
  // A postpaid Grant's headroom is its vpn.traffic meter's hold (ownerRef = the meter).
  const meters = leased.length
    ? await tx.grantMeter.findMany({ where: { grantId: { in: leased }, meterKey: METER_KEYS.vpnTraffic }, select: { id: true } })
    : [];
  const refs = [...leased, ...meters.map((m) => m.id)];
  const holds = refs.length
    ? await tx.walletHold.findMany({
        where: { walletId: wallet.id, status: WalletHoldStatus.open, ownerRef: { in: refs } },
        select: { ownerRef: true, amount: true },
      })
    : [];
  const pool = holds.reduce((sum, h) => sum.plus(h.amount), wallet.cachedBalance.minus(wallet.heldAmount));
  const share = pool.lte(0) ? ZERO : pool.div(count).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
  const siblings = holds
    .filter((h) => h.ownerRef !== grant.id && leased.includes(h.ownerRef))
    .map((h) => ({ grantId: h.ownerRef, amount: h.amount }));
  return { share, count, walletId: wallet.id, siblings };
}

/**
 * Releases every sibling prepaid reserve above `share` down to it, in the
 * caller's transaction; answers what was released. Nothing above it, nothing written.
 */
export async function releaseAboveShare(tx: Prisma.TransactionClient, userId: string, s: ReserveShare): Promise<Prisma.Decimal> {
  let released = ZERO;
  for (const sibling of s.siblings) {
    const excess = sibling.amount.minus(s.share);
    if (excess.lte(0)) continue;
    await HOLDS.release(tx, { userId, ownerRef: sibling.grantId, amount: excess });
    released = released.plus(excess);
  }
  return released;
}
