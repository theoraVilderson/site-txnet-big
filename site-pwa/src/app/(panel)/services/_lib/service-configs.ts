import { FrontendI18nKeys } from "@/generated/i18n-keys";
import {
  CONFIG_ACTION_REFUSALS,
  CONFIG_STATUSES,
  DRIFT_STATES,
  type ConfigActionRefusal,
  type ConfigStatus,
  type DriftState,
  type UserConfigRow,
} from "@/lib/billing-api";
import { numberLocale } from "../../_lib/digits";
import { lineLabel } from "./config-lines";

const C = FrontendI18nKeys.common.myServices.configs;

export { CONFIG_ACTION_REFUSALS, CONFIG_STATUSES, DRIFT_STATES };

/** A verdict's label, the sentence that says why, and its theme class. */
export interface DriftVerdict {
  labelKey: string;
  /** `null` only for `synced`: the one verdict with nothing to explain, so the one that is not a button. */
  whyKey: string | null;
  className: string;
}

const QUIET = "border-primary/20 bg-leaf-bg text-primary";
const REPAIRED = "border-card-border bg-bg-inner text-text-secondary";
const WATCH = "border-gold/20 bg-gold-bg text-gold";
const STOPPED = "border-error-border bg-error-bg text-error";

/**
 * Every verdict the convergence loop can give a config (F-027-aa/ab), and why
 * (F-027-ac: "every non-synced verdict is clickable and says why"). The spec
 * reads `DriftState` out of `network.prisma`, so a ninth verdict goes red
 * there instead of rendering as a blank pill nobody can press. Gold is a tone,
 * never a control (user, 2026-09-13).
 */
export const DRIFT_VERDICTS: Record<DriftState, DriftVerdict> = {
  synced: { labelKey: C.verdict.synced.label, whyKey: null, className: QUIET },
  reset: { labelKey: C.verdict.reset.label, whyKey: C.verdict.reset.why, className: REPAIRED },
  renamed: { labelKey: C.verdict.renamed.label, whyKey: C.verdict.renamed.why, className: REPAIRED },
  rebuilt: { labelKey: C.verdict.rebuilt.label, whyKey: C.verdict.rebuilt.why, className: REPAIRED },
  missing: { labelKey: C.verdict.missing.label, whyKey: C.verdict.missing.why, className: WATCH },
  orphan: { labelKey: C.verdict.orphan.label, whyKey: C.verdict.orphan.why, className: WATCH },
  limit_overridden: {
    labelKey: C.verdict.limit_overridden.label,
    whyKey: C.verdict.limit_overridden.why,
    className: WATCH,
  },
  contested: { labelKey: C.verdict.contested.label, whyKey: C.verdict.contested.why, className: STOPPED },
};

export const CONFIG_STATUS_KEYS: Record<ConfigStatus, string> = {
  active: C.status.active,
  frozen: C.status.frozen,
  disabled_by_admin: C.status.disabled_by_admin,
  disabled_by_system: C.status.disabled_by_system,
};

/** A sentence for every reason one config's action can come back refused. */
export const REFUSAL_KEYS: Record<ConfigActionRefusal, string> = {
  grant_not_found: C.refusal.config_not_found,
  grant_not_active: C.refusal.grant_not_active,
  panel_not_found: C.refusal.failed,
  config_not_found: C.refusal.config_not_found,
  config_retired: C.refusal.config_retired,
  regenerate_limit_reached: C.refusal.regenerate_limit_reached,
  config_changed: C.refusal.config_changed,
  same_panel: C.refusal.failed,
  actor_not_allowed: C.refusal.failed,
  failed: C.refusal.failed,
};

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/**
 * Bytes, as billing answers them (a decimal string, because a Grant can pass
 * 2^53), for a person: binary steps, one decimal, Latin digits as every
 * number on the panel (`digits.ts`). `null` stays `null` — no invented zero.
 */
export function formatBytes(bytes: string | null, lang: string): string | null {
  if (bytes === null) return null;
  let value: number;
  try {
    value = Number(BigInt(bytes));
  } catch {
    return bytes;
  }
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const n = new Intl.NumberFormat(numberLocale(lang), { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value);
  return `${n} ${UNITS[unit]}`;
}

/**
 * How long until a suspended Grant's seats are released, in whole days and
 * hours, or `"due"` once the instant has passed — the hourly job acts after it,
 * not at it. `null` when billing answered no instant.
 */
export function purgeCountdown(purgeAt: string | null, now: Date = new Date()): { days: number; hours: number } | "due" | null {
  if (!purgeAt) return null;
  const at = new Date(purgeAt).getTime();
  if (Number.isNaN(at)) return null;
  const left = at - now.getTime();
  if (left <= 0) return "due";
  const hoursLeft = Math.floor(left / 3_600_000);
  return { days: Math.floor(hoursLeft / 24), hours: hoursLeft % 24 };
}

/** Whether the panel has accepted less than the allocator decided — work the loop has not finished. */
export function ceilingQueued(row: Pick<UserConfigRow, "allocatedCeilingBytes" | "appliedCeilingBytes">): boolean {
  return row.allocatedCeilingBytes !== null && row.allocatedCeilingBytes !== row.appliedCeilingBytes;
}

/**
 * What a user calls a config: the name its panel gave its first line (the
 * server's own label, such as "DE Reality"), else its protocol and region —
 * the pair support reads. A config's id is never shown.
 */
export function configName(row: Pick<UserConfigRow, "lines" | "protocol" | "region">): string {
  const fallback = `${row.protocol} · ${row.region}`;
  const first = row.lines[0];
  if (!first) return fallback;
  const name = lineLabel(first);
  // An unnamed line's label is its own scheme or head; the region says more.
  return first.startsWith(name) ? fallback : name;
}

/**
 * A config's search text and a typed query, made comparable: lower case, the
 * Arabic ي/ك as the Persian ی/ک, and Persian or Arabic digits as Latin ones —
 * an Arabic keyboard types "علي", and "۲" is "2" to whoever typed it.
 */
function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a config answers a search (user, 2026-09-26: twenty configs on one
 * service are hard to manage): its buyer's name, the names on its lines, its
 * protocol or its region — the words the user can see on the row. An empty
 * query matches everything. The list is the Grant's whole list, so matching
 * here never shortens a page.
 */
export function matchesConfig(row: Pick<UserConfigRow, "label" | "lines" | "protocol" | "region">, query: string): boolean {
  const q = fold(query);
  if (q === "") return true;
  const names = [row.label ?? "", configName(row), row.protocol, row.region, ...row.lines.map(lineLabel)];
  return names.some((name) => fold(name).includes(q));
}
