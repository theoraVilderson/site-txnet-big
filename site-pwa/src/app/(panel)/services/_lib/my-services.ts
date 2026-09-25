import {
  AlertCircle,
  BatteryWarning,
  CheckCircle2,
  Clock,
  PauseCircle,
  TimerOff,
  type LucideIcon,
} from "lucide-react";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { RealtimeEvents } from "@/generated/wire";
import { GRANT_STATUSES, type GrantRow, type GrantStatus } from "@/lib/billing-api";

const S = FrontendI18nKeys.common.myServices;

export { GRANT_STATUSES };
export type { GrantStatus };

/** An icon, a theme class and the key of a translated label — the financial page's shape. */
export interface GrantTone {
  icon: LucideIcon;
  className: string;
  /** A `common` namespace key (C-06). The caller translates it. */
  labelKey: string;
}

/**
 * The colours a service is read by (F-502-s).
 *
 * **Every status billing can answer has a row here**, because billing never
 * filters the list (`domains/billing/contract.gift.md`): a key is lost from an
 * expired Grant as easily as a live one, so the dead statuses are exactly the
 * rows a user comes to this page for. A status with no row is a blank pill,
 * which is why the spec reads the union out of `entitlement.prisma`.
 *
 * Every colour is a theme token, never a raw palette class — three themes ship
 * and a hard-coded `emerald-500` is legible in one of them by luck
 * (`financial/_lib/tones.ts` has the longer version of this note). Gold is a
 * tone here and never a control (user, 2026-09-13).
 */
export const GRANT_TONES: Record<GrantStatus, GrantTone> = {
  pending: {
    icon: Clock,
    className: "border-gold/20 bg-gold-bg text-gold",
    labelKey: S.status.pending,
  },
  active: {
    icon: CheckCircle2,
    className: "border-primary/20 bg-leaf-bg text-primary",
    labelKey: S.status.active,
  },
  suspended: {
    icon: PauseCircle,
    className: "border-gold/20 bg-gold-bg text-gold",
    labelKey: S.status.suspended,
  },
  exhausted: {
    icon: BatteryWarning,
    className: "border-gold/20 bg-gold-bg text-gold",
    labelKey: S.status.exhausted,
  },
  expired: {
    icon: TimerOff,
    className: "border-card-border bg-bg-inner text-text-secondary",
    labelKey: S.status.expired,
  },
  cancelled: {
    icon: AlertCircle,
    className: "border-error-border bg-error-bg text-error",
    labelKey: S.status.cancelled,
  },
};

/**
 * What a service is called on this page: its variant's published name in the
 * viewer's language, else the SKU, else `null` — and the caller then shows
 * "unnamed service".
 *
 * There is no source-language fallback here, unlike the catalog page's
 * `catalogText`: the list answers no `sourceLang` (`billing/contract.gift.md`),
 * and a SKU a user can quote to support is a better second-best than a
 * language they may not read. A Grant issued without a catalog item
 * (`variant: null`) has neither.
 */
export function serviceName(texts: Record<string, string>, row: Pick<GrantRow, "variant">): string | null {
  if (!row.variant) return null;
  const name = texts[row.variant.nameKey];
  return name && name !== "" ? name : row.variant.sku;
}

/** A capability a Grant holds: its key, and its published name or `null`. */
export interface CapabilityName {
  key: string;
  name: string | null;
}

/** `t_<hex>.` when a catalog text key is a tenant's own, else `""` — `catalogTextKey`'s prefix. */
const TENANT_PREFIX = /^catalog\.(t_[0-9a-f]{32}\.)?/;

/**
 * What each of a Grant's `featureKeys` is called on this page (F-114-f-c): the
 * capability's published name in the viewer's language, or `null` and the
 * caller shows the key.
 *
 * A capability is the platform's or its product's tenant's own
 * (`catalog/invariants.md` 9), and its text lives under that owner's prefix
 * (`catalog.[t_<hex>.]capability.<key>.name`). The Grant does not answer a
 * tenant, so the product's own `nameKey` says whose it is — the same prefix
 * `catalogTextKey` wrote there. A key is unique among what one tenant sees, so
 * at most one of the two lookups can hit; another tenant's text under the same
 * key is never read. With no variant only the platform's are named.
 */
export function capabilityNames(
  texts: Record<string, string>,
  row: Pick<GrantRow, "featureKeys" | "variant">,
): CapabilityName[] {
  const own = row.variant ? (TENANT_PREFIX.exec(row.variant.nameKey)?.[1] ?? "") : "";
  const prefixes = own ? [own, ""] : [""];
  return row.featureKeys.map((key) => {
    for (const p of prefixes) {
      const name = texts[`catalog.${p}capability.${key}.name`];
      if (name) return { key, name };
    }
    return { key, name: null };
  });
}

/**
 * The Grant a purchase's end names, off the buyer's `user:` channel — or
 * `null` for anything else on it (F-111-f). Delivered and refunded both count:
 * either way the `pending` row is over, and what it became is billing's to say
 * (`automation/contract.outbox.md`, "A purchase's end, told"). Nothing else in
 * the payload is read, so a refund's amount is never this page's to print.
 */
export function readGrantSettled(payload: unknown): { grantId: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.type !== RealtimeEvents.grantDelivered && p.type !== RealtimeEvents.grantRefunded) return null;
  return typeof p.grantId === "string" && p.grantId !== "" ? { grantId: p.grantId } : null;
}
