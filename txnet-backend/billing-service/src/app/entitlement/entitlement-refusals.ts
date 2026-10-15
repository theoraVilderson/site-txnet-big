/**
 * Why a Grant operation was refused, and the refusals that carry figures —
 * apart from `grant.ts` so the checks it calls (`metered-cap.ts`,
 * `purchase-limits.ts`, `user-restrictions.ts`) can throw them without an
 * import cycle. `grant.ts` re-exports every name, so callers import it there.
 */
import type { UserRestrictionKey } from '@txnet-backend/shared-core';

/** Why a Grant operation was refused. Nothing was written. */
export type EntitlementRejection =
  | 'variant_not_found'
  /** Switched off, or `admin_only` for a purchase — or, bought or redeemed, a product whose audience leaves the user out (PT-1-b). */
  | 'variant_not_assignable'
  /** An admin's issue (PT-1-b): the product is sold to chosen groups and the user is a member of none. */
  | 'not_in_audience'
  /** A concurrent issue for the same cause won; retry to read its Grant. */
  | 'already_issued'
  /** Unknown, another tenant's, or — for a token rotation — another user's. Never told apart. */
  | 'grant_not_found'
  | 'illegal_transition'
  | 'grant_not_active'
  /** A `metered` variant with no rate in effect at the sale — or a `vpn.traffic` card the byte engine cannot serve yet (F-118-d): nothing would price its bytes (F-027-p). */
  | 'metered_rate_missing'
  /** The rate in effect is zero: a block priced at nothing cannot be bought, so the Grant would stall (F-027-al). */
  | 'metered_rate_not_positive'
  /** A rate card in effect on a meter nothing serves yet (F-118-e, ADR-0105 decision 7): its use could not be refused, so it is not sold. */
  | 'meter_not_served'
  /** A reseller's package prices none of the Grant's platform meters (F-118-n2, ADR-0105 decision 10): the platform could not bill its usage, so it is not sold. */
  | 'wholesale_rate_missing'
  /** The reseller's billing wallet cannot buy the plan's bag wholesale (F-118-p): nothing is sold, nothing written. */
  | 'wholesale_unfunded'
  /** Renewal (F-027-dg): only an `active` Grant, or one `suspended`, is renewed in place. */
  | 'grant_not_renewable'
  /** Renewal: bytes on a metered Grant (its blocks buy them) or an unlimited one. */
  | 'traffic_not_renewable'
  /** Renewal: neither bytes nor days. */
  | 'nothing_to_renew'
  /** Renewal or unfreeze: the Grant's Quota or end moved between the read and the write; retry. */
  | 'grant_moved'
  /** Unfreeze (F-311-h): the Grant is not frozen — never a suspension for quota, which a top-up lifts. */
  | 'grant_not_frozen'
  /** The user's unfreeze (F-0401-a): a hard freeze, or one an evict left waiting for a panel — only an admin or the sweep lifts it. */
  | 'freeze_not_users'
  /** An admin's change of a frozen Grant's mode (F-0401-d): the mode it already has. */
  | 'freeze_mode_unchanged'
  /** The user's own freeze (F-0401-c): their reseller turned it off (`selfFreezeEnabled`). */
  | 'self_freeze_off'
  /** The user's fourth freeze of a Grant in 24 hours (F-0401-c, `SelfFreezeLimited`): nothing frozen. */
  | 'self_freeze_limit'
  /** Freeze: an unfreeze time that has already come. */
  | 'freeze_until_not_future'
  /** Days (F-311-i): expired, exhausted or cancelled — only a renewal brings it back (§4.4). */
  | 'grant_closed'
  /** Traffic (F-311-j): a metered Grant (its blocks buy its bytes) or an unlimited one has no bag an admin moves. */
  | 'traffic_not_adjustable'
  /** Gift (F-311-l): only a metered, limited Grant takes gifted bytes — a prepaid bag is moved by Traffic. A self-freeze (F-0401-c): only a metered Grant — a frozen prepaid package would buy free days. */
  | 'grant_not_metered'
  /** Traffic: a cut past zero — a Quota is never negative. */
  | 'quota_below_zero'
  /** Traffic reset (F-311-k): nothing used since the last reset — the full bag is already left. */
  | 'nothing_to_reset'
  /** Days: a permanent Grant has no end to move. */
  | 'grant_permanent'
  /** Days: the new end is now or earlier — cutting a service off is a delete (F-311-m). */
  | 'duration_end_not_future'
  /** Days: the new end is the end it has. */
  | 'duration_unchanged'
  /** Admin issue (F-311-o): nothing could deliver it — no handler, no placeable group, no stated traffic. */
  | 'variant_not_deliverable'
  /** Admin issue or renewal: this request id already issued a Grant to another user or variant, or renewed another Grant. */
  | 'request_reused'
  /** Admin renewal (F-311-d): a dated Grant with no copied plan period — the admin types the amount. */
  | 'plan_period_unknown'
  /** Admin renewal: a concurrent repeat of the same request won; retry to read its renewal. */
  | 'already_renewed'
  /** Device limit (F-311-q): the limit the Grant already has, or a lift of none. */
  | 'devices_unchanged'
  /** A purchase past the user's cap of open metered Grants (F-118-ao, `MeteredCapReached`): nothing is sold, nothing written. */
  | 'metered_cap_reached'
  /** A user's buys in a window past its reseller's limit (F-019-t7). */
  | 'purchase_limit_reached'
  /** Past a restriction staff set on this one person (F-030-e, `UserRestricted`). */
  | 'restriction_reached'
  /** The owner's fourth link reset of a Grant in 24 hours (F-114-e-d, `LinkResetLimited`): nothing rotated. */
  | 'link_reset_limit';

export class EntitlementRefused extends Error {
  constructor(
    readonly reason: EntitlementRejection,
    detail = '',
  ) {
    super(`entitlement refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'EntitlementRefused';
  }
}

/** A metered purchase past the cap: the refusal names the cap, so the panel can say "open a ticket". */
export class MeteredCapReached extends EntitlementRefused {
  constructor(
    readonly cap: number,
    readonly open: number,
  ) {
    super('metered_cap_reached', `${open} open, cap ${cap}`);
  }
}

/** The window a purchase limit counts over (F-019-t7). */
export type PurchaseWindow = 'day' | 'week' | 'month';

/** A buy past one window's limit (F-019-t7, `purchase-limits.ts`). The buyer is the one bounded, so the figures are theirs to see. */
export class PurchaseLimitReached extends EntitlementRefused {
  constructor(
    readonly window: PurchaseWindow,
    readonly limit: number,
    readonly bought: number,
  ) {
    super('purchase_limit_reached', `${bought} bought in a ${window}, limit ${limit}`);
  }

  /** As `error.facts`: flat, no text (`sanitizeError`). */
  get facts(): { window: PurchaseWindow; limit: number; bought: number } {
    return { window: this.window, limit: this.limit, bought: this.bought };
  }
}

/**
 * Past a restriction staff set on this one person (F-030-e, governance
 * `USER_RESTRICTIONS`): a count's limit and what they hold, or the barred
 * option they picked. The person is the one bounded, so the figures are theirs.
 */
export class UserRestricted extends EntitlementRefused {
  constructor(
    readonly key: UserRestrictionKey,
    readonly figures: { limit: number; used: number } | { category: string },
  ) {
    super('restriction_reached', `${key} ${JSON.stringify(figures)}`);
  }

  /** As `error.facts`: flat, no text (`sanitizeError`). */
  get facts(): { key: UserRestrictionKey } & ({ limit: number; used: number } | { category: string }) {
    return { key: this.key, ...this.figures };
  }
}
