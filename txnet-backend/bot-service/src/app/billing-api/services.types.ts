/**
 * The user's own services as the chat reads them (F-307-y): billing's
 * `GET /api/billing/gift/grants` (`billing/contract.gift.md` "A user's own
 * Grants, listed"), narrowed to what a chat tells.
 */

/** Entitlement's `GrantStatus`; the spec reads the enum from the Prisma schema. */
export type GrantStatus = 'pending' | 'active' | 'suspended' | 'exhausted' | 'expired' | 'cancelled';

/** Who froze a Grant (entitlement `FreezeMode`, F-0401-a); `null` when it is not frozen. */
export type FreezeMode = 'hard' | 'soft' | 'self';

/** One row of the list. Bytes are decimal strings: a Grant's bytes pass 2^53. */
export interface MyService {
  id: string;
  /** The buyer's own name for it (F-307-x), else `null`. */
  label: string | null;
  status: GrantStatus;
  endsAt: string | null;
  /** The catalog's name key and sku; `null` for a Grant issued without a catalog item. */
  variant: { id: string; sku: string; nameKey: string } | null;
  billingMode: 'prepaid' | 'metered';
  consumedBytes: string;
  trafficUnlimited: boolean;
  /** A capped prepaid Grant's cap with its adjustments; `null` for metered, unlimited or no quota (F-111-t). */
  trafficCapBytes: string | null;
  frozen: boolean;
  frozenUntil: string | null;
  freezeMode: FreezeMode | null;
  /** Billing's answer to "may this user lift it" (F-0401-c) — never re-derived from `freezeMode`. */
  userMayUnfreeze: boolean;
}

/** A page of the list; `hidden` counts the ended services the `current` scope leaves out. */
export interface MyServicesPage {
  total: number;
  page: number;
  pageSize: number;
  hidden: number;
  rows: MyService[];
}
