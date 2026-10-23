// The caller's own Grants and their configs — the "my services" page (F-502-s, F-307-u, F-118-j).
import { type Paged, call } from "./client";
import type { ConfigAction, ConfigActionOutcome, ConfigStatus, DriftState } from "./config-actions";

/**
 * The statuses a Grant can be in, as `entitlement.prisma` declares them (C-09).
 * Declared once here because the panel reads them in two places — the pill and
 * the page's sentences — and a second spelling is a blank pill in one of them.
 */
export const GRANT_STATUSES = ["pending", "active", "suspended", "exhausted", "expired", "cancelled"] as const;

export type GrantStatus = (typeof GRANT_STATUSES)[number];

/**
 * One of the caller's own Grants, as `GET /gift/grants` answers it (F-502-r,
 * `billing/contract.gift.md`).
 *
 * **Neither the subscription key nor its hash is in it.** Billing selects its
 * columns explicitly for that reason (D-35): the key exists in the clear only
 * in a redemption's answer and in a reissue's, never in a list. So a row is
 * what a user recognises a service by, and the way back to its key is the
 * reissue route.
 *
 * `nameKey` is the variant's own wording, else its product's — a key, not the
 * translated text, resolved here through the same published `catalog`
 * namespace the catalog page reads. `variant` is `null` for a Grant issued
 * without a catalog item.
 */
export interface GrantRow {
  id: string;
  /** The buyer's own name for it (F-307-x), shown before the catalog's; `null` = unnamed. */
  label: string | null;
  /** Answered for every Grant; `cancelled` and `exhausted` come only on scope `all`. */
  status: GrantStatus;
  startsAt: string;
  /** `null` = permanent. */
  endsAt: string | null;
  featureKeys: string[];
  variant: { id: string; sku: string; nameKey: string } | null;
  /** `metered` Grants buy their bytes in blocks, so `purchasedBytes` is what bounds them (ADR-0072). */
  billingMode: "prepaid" | "metered";
  /** Bytes, as a decimal string: what the panels reported. Measured, not charged. */
  consumedBytes: string;
  /** Bytes, as a decimal string: what has been bought. */
  purchasedBytes: string;
  /** Sold with unlimited traffic (F-111-q): `purchasedBytes` is 0 and bounds nothing (F-111-s). */
  trafficUnlimited: boolean;
  /** A capped prepaid Grant's cap in bytes, rollover included — `/sub`'s `total`; `null` otherwise (F-111-t). */
  trafficCapBytes: string | null;
  /** Set only while suspended (ADR-0075). */
  suspendedAt: string | null;
  /** When the panel seats are released; `null` when nothing is due (not suspended, or a window of 0). */
  purgeAt: string | null;
  /** When traffic last moved, to within one usage push; `null` when it never has (F-307-u). */
  lastTrafficAt: string | null;
  /** An admin, the user or an evict froze it (F-311-h): `suspended`, kept, never purged. */
  frozen: boolean;
  /** When a timed freeze ends by itself; `null` when not frozen or frozen until lifted. */
  frozenUntil: string | null;
  /** Who froze it (F-0401-a): `hard` support, `soft` support leaving it to the user, `self` the user; `null` when not frozen. */
  freezeMode: FreezeMode | null;
  /** Whether the user may lift it themselves — billing's `userMayUnfreeze`, never derived here. */
  userMayUnfreeze: boolean;
}

/** Who may lift a freeze, as `entitlement.prisma` declares `FreezeMode` (C-09); hard beats soft beats self. */
export const FREEZE_MODES = ["hard", "soft", "self"] as const;
export type FreezeMode = (typeof FREEZE_MODES)[number];

/**
 * Which Grants the list answers (user, 2026-09-26): `current` leaves out the
 * ones that will never serve again — `cancelled` and `exhausted` — and `all`
 * lists every one. `hidden` is how many `current` left out (0 on `all`).
 */
export type GrantScope = "current" | "all";

export type GrantsPage = Paged<GrantRow> & { hidden: number };

/**
 * What a new link costs on one Grant (F-118-r): the `vpn.config.regenerate`
 * terms it locked at sale, and how many it has used — the row billing's door
 * prices from (F-118-h). `null` on a Grant sold without one: the count cap.
 */
export interface RegenerateTerms {
  unitSize: string;
  unitPrice: string;
  currencyCode: string;
  mode: string;
  includedQuantity: string;
  afterIncluded: string;
  used: string;
}

/** `GET /traffic/grants/:id/configs` for the user's own Grant. */
export interface UserGrantConfigs {
  grantId: string;
  rows: UserConfigRow[];
  /** Absent from an older billing: read as none. */
  regenerate?: RegenerateTerms | null;
}

/**
 * One config of a Grant, as `GET /traffic/grants/:id/configs` answers it
 * (F-027-ac, `billing/contract.gift.md`). Never its `uuid`: that is the
 * credential, and `/sub` is what hands it out.
 */
export interface UserConfigRow {
  id: string;
  protocol: string;
  status: ConfigStatus;
  region: string;
  /** Bytes as decimal strings; `null` until the allocator gave it a share. */
  allocatedCeilingBytes: string | null;
  /** What the panel confirmed; a gap to `allocated` is work still queued. */
  appliedCeilingBytes: string | null;
  driftState: DriftState;
  enforcementState: "pending" | "partial" | "complete";
  regenerateUsedCount: number;
  maxRegenerateCount: number;
  lastReconciledAt: string | null;
  /** The buyer's own name for it (F-307-g); `null` is the default name. */
  label: string | null;
  /**
   * The config's captured link lines, named by billing as `/sub` names them
   * (ADR-0089) — what `/sub` hands the same user
   * (F-307-a). `[]` with `linksCapturedAt` `null`: not captured since the last
   * new key. `[]` with a time: the panel gives none.
   */
  lines: string[];
  linksCapturedAt: string | null;
}

/** A spending cap's `period` (F-118-i): one budget for the service's life, or one per month from its start date. */
export const SPENDING_CAP_PERIODS = ["none", "monthly"] as const;

export type SpendingCapPeriod = (typeof SPENDING_CAP_PERIODS)[number];

/**
 * The owner's cap on one service's usage (F-118-i, `billing/contract.spending-cap.md`):
 * who it is for, and at most how much its usage may cost. Money is two-place
 * strings in `currencyCode`, the wallet's; `left` is `amount − spent`, never below zero.
 */
export interface SpendingCap {
  grantId: string;
  label: string;
  amount: string;
  currencyCode: string;
  period: SpendingCapPeriod;
  periodStartsAt: string;
  spent: string;
  held: string;
  left: string;
}

/**
 * `GET /traffic/grants/:id/usage` (F-307-b): exactly 30 UTC days, today
 * included, oldest first, a day with no traffic as `"0"`. Bytes are decimal
 * strings; today is what the last rollup saw.
 */
export interface GrantUsage {
  grantId: string;
  from: string;
  to: string;
  days: { date: string; uploadBytes: string; downloadBytes: string }[];
}

/** One billing period of a metered Grant (F-118-ai): instants, bytes as a decimal string, money in the wallet's currency. */
export interface GrantPeriod {
  from: string;
  to: string;
  consumedBytes: string;
  spent: string;
}

/**
 * `GET /traffic/grants/:id/period` (F-118-ai): a metered Grant's month — from
 * the latest anniversary of its start to the next — and the one before
 * (`null` in the first). `coversBytes` is billing's estimate of what is still
 * paid for or payable; `null` when it cannot say.
 */
export interface GrantPeriodView {
  grantId: string;
  current: GrantPeriod;
  previous: GrantPeriod | null;
  currencyCode: string | null;
  coversBytes: string | null;
}

/** `GET /traffic/collection-health` (F-027-w): whether anything is metering the user's configs right now. */
export interface CollectionHealth {
  metering: "healthy" | "unavailable" | "not_metered";
  lastCollectedAt: string | null;
  staleForSeconds: number | null;
  configsAffected: number;
}

/** The caller's Grants and configs — spread into `billingApi` (`lib/billing-api.ts`). */
export const grantCalls = {
  async grants(page: number, pageSize: number, scope: GrantScope, q = ""): Promise<GrantsPage> {
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize), scope });
    // Billing trims `q` and reads a blank one as none (F-307-m); none is not sent.
    if (q.trim() !== "") query.set("q", q.trim());
    return call<GrantsPage>(`/gift/grants?${query}`, { method: "GET" });
  },

  /**
   * The same page, narrowed to the Grants holding a config one of `lines` is
   * (F-307-p) — by its uuid, or its captured line with the name left out.
   * **A body, never a query string:** a line is a credential, and a URL lands
   * in access logs and history. Its own bucket, 60 per 900s per user.
   */
  async grantsByLines(lines: string[], page: number, pageSize: number, scope: GrantScope): Promise<GrantsPage> {
    return call<GrantsPage>("/gift/grants/by-lines", {
      method: "POST",
      body: JSON.stringify({ lines, page, pageSize, scope }),
    });
  },

  /**
   * One Grant's `/sub` link (F-114-e-b, ADR-0085): `https://<tenant subscription
   * domain>/sub/<token>`, the same on every call — billing keeps the token
   * sealed, so the link is asked for whenever it is wanted, never stored here.
   *
   * **The id is the whole request**; another user's Grant and a missing one are
   * the same 404. The two named refusals are 409s: `no_subscription_domain`
   * (the tenant's setup) and `link_not_kept` (a Grant from before the token was
   * kept — one reset keeps it from then on).
   */
  async subscriptionLink(grantId: string): Promise<{ grantId: string; subscriptionUrl: string }> {
    return call<{ grantId: string; subscriptionUrl: string }>(
      `/gift/grants/${encodeURIComponent(grantId)}/subscription-link`,
      { method: "GET" },
    );
  },

  /**
   * "Reset link" (F-502-p, F-114-e-b): a new token for a link that leaked. The
   * old link stops working in billing's transaction, and the answer is the new
   * one. Its own bucket, 5 per 900s, and at most 3 per Grant in 24 hours
   * (F-114-e-d: 429 `link_reset_limit`, `facts: {limit, nextAtMs}`): each call
   * destroys a working link, so a caller that retried on the user's behalf
   * would spend the budget for it.
   */
  async resetSubscriptionLink(grantId: string): Promise<{ grantId: string; subscriptionUrl: string }> {
    return call<{ grantId: string; subscriptionUrl: string }>(
      `/gift/grants/${encodeURIComponent(grantId)}/rotate-token`,
      { method: "POST" },
    );
  },

  /**
   * One Grant's configs, with each one's ceiling and drift verdict (F-027-ac).
   * Another user's Grant is the same 404 as a missing one.
   */
  async grantConfigs(grantId: string): Promise<UserGrantConfigs> {
    return call<UserGrantConfigs>(
      `/traffic/grants/${encodeURIComponent(grantId)}/configs`,
      { method: "GET" },
    );
  },

  /** A Grant's daily bytes over the last 30 days (F-307-b) — the same 404 as `grantConfigs` for another user's Grant. */
  async grantUsage(grantId: string): Promise<GrantUsage> {
    return call<GrantUsage>(`/traffic/grants/${encodeURIComponent(grantId)}/usage`, { method: "GET" });
  },

  /** A metered Grant's billing period (F-118-ai); 404 another user's, 409 a Grant that is not metered. */
  async grantPeriod(grantId: string): Promise<GrantPeriodView> {
    return call<GrantPeriodView>(`/traffic/grants/${encodeURIComponent(grantId)}/period`, { method: "GET" });
  },

  /**
   * One action on one config or up to fifty (F-027-ac). **Always an outcome
   * per config**, never all-or-nothing (user, 2026-09-23): a refused config
   * does not stop the others, and the answer says which it was. A 4xx here is
   * the request itself — a bad body or the limiter — not one config.
   */
  async configAction(action: ConfigAction, configIds: string[]): Promise<{ action: ConfigAction; results: ConfigActionOutcome[] }> {
    return call<{ action: ConfigAction; results: ConfigActionOutcome[] }>("/traffic/configs/actions", {
      method: "POST",
      body: JSON.stringify({ action, configIds }),
    });
  },

  /**
   * Names one of the user's configs, or clears the name with `null`
   * (F-307-g, ADR-0089). Display only: the lines carry it on the next read,
   * and `/sub` on the app's next refresh. Another user's config is a 404.
   */
  async setConfigLabel(configId: string, label: string | null): Promise<{ configId: string; label: string | null }> {
    return call<{ configId: string; label: string | null }>(`/traffic/configs/${encodeURIComponent(configId)}/label`, {
      method: "PUT",
      body: JSON.stringify({ label }),
    });
  },

  /**
   * Names one of the user's services, or clears the name with `null`
   * (F-307-x). Display only: My services, its search and the user's notices
   * show it before the config names. Another user's service is a 404.
   */
  async setGrantLabel(grantId: string, label: string | null): Promise<{ grantId: string; label: string | null }> {
    return call<{ grantId: string; label: string | null }>(`/gift/grants/${encodeURIComponent(grantId)}/label`, {
      method: "PUT",
      body: JSON.stringify({ label }),
    });
  },

  /** One service's spending cap (F-118-i); `cap` is null when none is set. Another user's service is a 404. */
  async spendingCap(grantId: string): Promise<{ grantId: string; cap: SpendingCap | null }> {
    return call<{ grantId: string; cap: SpendingCap | null }>(`/traffic/grants/${encodeURIComponent(grantId)}/cap`, { method: "GET" });
  },

  /**
   * Sets, raises or lowers a service's cap. A new cap or a changed `period`
   * counts from now; a changed amount or label keeps what was spent.
   */
  async setSpendingCap(
    grantId: string,
    body: { label: string; amount: string; period: SpendingCapPeriod },
  ): Promise<{ grantId: string; cap: SpendingCap }> {
    return call<{ grantId: string; cap: SpendingCap }>(`/traffic/grants/${encodeURIComponent(grantId)}/cap`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },

  /** Removes a service's cap: its usage is bounded by the wallet alone again. No cap is a 204 too. */
  async removeSpendingCap(grantId: string): Promise<void> {
    await call<void>(`/traffic/grants/${encodeURIComponent(grantId)}/cap`, { method: "DELETE" });
  },

  /**
   * The user freezes their own pay-as-you-go service (F-0401-c). Refused 403 `self_freeze_off` (the
   * reseller's switch) and 429 `self_freeze_limit`, `facts {limit, nextAtMs}` — 3 a day per service.
   */
  async freezeOwnGrant(grantId: string): Promise<{ grantId: string; freezeMode: FreezeMode; configsDisabled: number }> {
    return call<{ grantId: string; freezeMode: FreezeMode; configsDisabled: number }>(`/gift/grants/${encodeURIComponent(grantId)}/freeze`, { method: "POST" });
  },

  /** Lifts a `soft` or `self` freeze (F-0401-c); a hard one is 403 `freeze_not_users`. */
  async unfreezeOwnGrant(grantId: string): Promise<{ grantId: string; endsAt: string | null; configsRestored: number }> {
    return call<{ grantId: string; endsAt: string | null; configsRestored: number }>(`/gift/grants/${encodeURIComponent(grantId)}/unfreeze`, { method: "POST" });
  },

  /** Whether the collector is reading the user's panels (F-027-w) — the service page's "not cut off" sentence. */
  async collectionHealth(): Promise<CollectionHealth> {
    return call<CollectionHealth>("/traffic/collection-health", { method: "GET" });
  },
};
