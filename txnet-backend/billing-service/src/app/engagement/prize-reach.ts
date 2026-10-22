import { GrantStatus, Prisma, SpinPrizeType } from '@prisma/client';
import { percentText } from '@txnet-backend/shared-core';

import { takes } from './reward-issuer';

/**
 * The wheel's odds are the user's own (F-707-u, user 2026-10-22): which prize
 * kinds can reach this user's services now. A slot the issuer would refuse —
 * GB with no capped active Grant, days with no active Grant that ends — is out
 * of this user's pick and shown at 0%, the rest re-weighted in proportion.
 * Before, it was drawn and silently became «nothing», so the odds shown were
 * false for exactly those users (an unlimited plan never won GB).
 *
 * The view and the spin both weigh through here, so what is shown is what is
 * drawn. The day's cap and a prize's stock still turn a drawn prize into
 * nothing (invariant 1); that is the tenant's budget, not the user's reach.
 */
export type PrizeReach = ReadonlySet<SpinPrizeType>;

/** Always reachable: a coupon and a free service need no service of the user's; an empty slot gives nothing. */
const ALWAYS: readonly SpinPrizeType[] = [SpinPrizeType.discount_coupon, SpinPrizeType.free_grant, SpinPrizeType.empty];
/** Reachable through an active Grant that can take them — the issuer's `takes`. */
const THROUGH_A_GRANT: readonly SpinPrizeType[] = [SpinPrizeType.bonus_traffic_gb, SpinPrizeType.extra_days];

/** The kinds this user can be given now. */
export async function prizeReachOf(tx: Prisma.TransactionClient, userId: string): Promise<PrizeReach> {
  const active = await tx.grant.findMany({ where: { userId, status: GrantStatus.active }, select: { trafficUnlimited: true, endsAt: true } });
  return new Set([...ALWAYS, ...THROUGH_A_GRANT.filter((kind) => active.some((g) => takes(g, kind)))]);
}

type Slot = { prizeType: SpinPrizeType; probabilityWeight: number };

/** The slots this user's spin may land on; every slot when none is reachable, so a spin still lands as it did. */
export function reachableSlots<T extends Slot>(prizes: T[], reach: PrizeReach): T[] {
  const reachable = prizes.filter((p) => reach.has(p.prizeType) && p.probabilityWeight > 0);
  return reachable.length ? reachable : prizes;
}

/** Each slot's odds for this user, as percent text: an unreachable slot `0.00`, the rest over the reachable weight. */
export function oddsFor<T extends Slot>(prizes: T[], reach: PrizeReach): (p: T) => string {
  const reachable = prizes.filter((p) => reach.has(p.prizeType));
  const total = reachable.reduce((s, p) => s + p.probabilityWeight, 0);
  return (p) => (total > 0 && reach.has(p.prizeType) ? percentText(new Prisma.Decimal(p.probabilityWeight).mul(100).div(total)) : percentText(new Prisma.Decimal(0)));
}
