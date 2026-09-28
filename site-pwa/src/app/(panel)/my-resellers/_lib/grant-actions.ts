import type { GrantRow } from "@/lib/billing-api";
import { USER_KEYS } from "./users";

/** The strings of a Grant's actions (C-06). */
export const GRANT_KEYS = USER_KEYS.grant;

/**
 * An admin's actions on one of a user's Grants (F-311-w), each billing's
 * `POST …/users/:userId/grants/:grantId/<route>` (`billing/contract.reseller-grants.md`):
 * freeze (F-311-h), days (-i, -z), traffic (-j), reset (-k), gift (-l),
 * speed (-p), devices (-q), the `/sub` link (-n), renew (-d), delete (-m).
 * Issue (-o) is the user's, not a Grant's: {@link issueBody}.
 */
export const GRANT_ACTIONS = ["freeze", "unfreeze", "days", "traffic", "reset", "gift", "speed", "devices", "rotate", "renew", "delete"] as const;
export type GrantAction = (typeof GRANT_ACTIONS)[number];

export const GRANT_ACTION_ROUTES: Record<GrantAction, string> = {
  freeze: "freeze",
  unfreeze: "unfreeze",
  days: "duration",
  traffic: "traffic",
  reset: "traffic/reset",
  gift: "traffic/gift",
  speed: "speed",
  devices: "devices",
  rotate: "rotate-token",
  renew: "renew",
  delete: "delete",
};

/** The actions whose schema requires a `reason`; the others take one optionally. */
export const REASON_REQUIRED = ["days", "traffic", "reset", "gift", "speed", "devices", "delete"] as const satisfies readonly GrantAction[];

/** What the one open form holds; each action reads only its own fields. */
export interface GrantActionDraft {
  reason: string;
  /** Days, GB, Mbps or devices — the one number the action takes; a renewal's GB. */
  amount: string;
  /** A renewal's days. */
  days: string;
  /** A freeze's last day, `YYYY-MM-DD` in the admin's own time; empty = until unfrozen. */
  until: string;
  /** A delete's refund, `null` until the admin answers it (user, 2026-09-26). */
  refund: boolean | null;
  /** Minted once per opened form: a double click renews or issues once. */
  requestId: string;
}

export const emptyDraft = (): GrantActionDraft => ({ reason: "", amount: "", days: "", until: "", refund: null, requestId: crypto.randomUUID() });

const MAX_REASON = 500;
const MAX_GB = 100_000;
const GIB = 1024 ** 3;

/** A Persian or Arabic-Indic digit typed on a phone reads as its Latin one. */
function latin(raw: string): string {
  return raw.trim().replace(/[۰-۹٠-٩]/g, (d) => String((d.charCodeAt(0) & 0xf) % 10));
}

/** A number typed, or `null` for anything that is not one. Empty is `null` too. */
function numberOf(raw: string): number | null {
  const s = latin(raw);
  if (s === "" || !/^[-+]?\d*\.?\d+$/.test(s)) return null;
  return Number(s);
}

const wholeIn = (n: number | null, min: number, max: number): n is number => n !== null && Number.isInteger(n) && n >= min && n <= max;

/** A reason as the schema takes it: trimmed, 1..500, or `undefined` for none. */
function reasonOf(raw: string): string | undefined | null {
  const why = raw.trim();
  if (why.length > MAX_REASON) return null;
  return why.length === 0 ? undefined : why;
}

/** The start of a `YYYY-MM-DD` day in the admin's own time, or `null`. */
function dayStart(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The body, exactly, or `null` where the action's schema would refuse it.
 * Every schema is `.strict()`: a field the action does not take, a zero, a
 * missing reason or an unanswered refund is a 400 and nothing is done — so the
 * confirm button stays off rather than sending one.
 */
export function grantActionBody(action: GrantAction, d: GrantActionDraft, now: Date = new Date()): Record<string, unknown> | null {
  const reason = reasonOf(d.reason);
  if (reason === null) return null;
  if ((REASON_REQUIRED as readonly string[]).includes(action) && reason === undefined) return null;
  const why = reason === undefined ? {} : { reason };
  const n = numberOf(d.amount);

  switch (action) {
    case "freeze": {
      if (d.until === "") return why;
      const until = dayStart(d.until);
      return until && until.getTime() > now.getTime() ? { until: until.toISOString(), ...why } : null;
    }
    case "unfreeze":
    case "rotate":
    case "reset":
      return why;
    case "days":
      return wholeIn(n, -3650, 3650) && n !== 0 ? { days: n, ...why } : null;
    case "traffic":
      return n !== null && Math.abs(n) <= MAX_GB && Math.round(n * GIB) !== 0 ? { gb: n, ...why } : null;
    case "gift":
      return n !== null && n <= MAX_GB && Math.round(n * GIB) > 0 ? { gb: n, ...why } : null;
    case "speed":
      if (latin(d.amount) === "") return { mbps: null, ...why };
      return wholeIn(n, 1, 100_000) ? { mbps: n, ...why } : null;
    case "devices":
      if (latin(d.amount) === "") return { limit: null, ...why };
      return wholeIn(n, 1, 1000) ? { limit: n, ...why } : null;
    case "delete":
      return d.refund === null ? null : { refund: d.refund, ...why };
    case "renew": {
      const typedGb = latin(d.amount) !== "";
      const typedDays = latin(d.days) !== "";
      const days = numberOf(d.days);
      if (typedGb && (n === null || n < 0 || n > MAX_GB)) return null;
      if (typedDays && !wholeIn(days, 0, 3650)) return null;
      // Typed, but zero of both: billing's `nothing_to_renew`.
      if ((typedGb || typedDays) && !(n ?? 0) && !(days ?? 0)) return null;
      return { requestId: d.requestId, ...(typedGb ? { gb: n } : {}), ...(typedDays ? { days } : {}), ...why };
    }
  }
}

/** An issue's body (F-311-o), or `null` with no variant picked. */
export function issueBody(variantId: string, requestId: string, rawReason: string): Record<string, unknown> | null {
  const reason = reasonOf(rawReason);
  if (!variantId || reason === null) return null;
  return { variantId, requestId, ...(reason === undefined ? {} : { reason }) };
}

/**
 * What a Grant offers. Every act but the link waits for a live Grant
 * (`active` / `suspended`) — billing refuses the rest as `grant_closed`,
 * `grant_not_renewable` or `grant_not_active` — and the link is reset in
 * any state (its contract: "status is not a gate"). Traffic and its reset
 * move a limited prepaid bag, a gift a metered one; a permanent Grant has no
 * end to move. Anything subtler (a quota-stopped Grant is not frozen) is
 * billing's to refuse, with its sentence.
 */
export function grantActionsOf(row: Pick<GrantRow, "status" | "endsAt" | "billingMode" | "trafficUnlimited">): GrantAction[] {
  if (row.status !== "active" && row.status !== "suspended") return ["rotate"];
  const prepaidBag = row.billingMode === "prepaid" && !row.trafficUnlimited;
  const offered: (GrantAction | false)[] = [
    row.status === "active" ? "freeze" : "unfreeze",
    row.endsAt !== null && "days",
    prepaidBag && "traffic",
    prepaidBag && "reset",
    row.billingMode === "metered" && "gift",
    "speed",
    "devices",
    "rotate",
    "renew",
    "delete",
  ];
  return offered.filter((a): a is GrantAction => a !== false);
}

/**
 * Every reason billing answers a Grant action with and no i18n key of its
 * own: the controller's `GRANT_ACTION_STATUS` and the speed cap's two. The
 * spec reads both from the backend, so a reason added there has no sentence
 * here until one is written.
 */
export type GrantRefusal = keyof typeof GRANT_KEYS.refusal;
export const GRANT_REFUSAL_KEYS: Record<GrantRefusal, string> = GRANT_KEYS.refusal;

export function grantRefusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in GRANT_REFUSAL_KEYS ? GRANT_REFUSAL_KEYS[reason as GrantRefusal] : null;
}
