import type { SpinResult } from "@/lib/engagement-api";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { numberLocale } from "../../_lib/digits";

/** The page's strings as generated constants (C-06). */
export const WHEEL_KEYS = FrontendI18nKeys.common.wheel;
const K = WHEEL_KEYS;

/**
 * Every reason billing gives for no spin: the recorded `SpinRefusalReason`
 * (a `200`) and the unrecorded `WheelSpinRejection` (a 4xx). The spec reads
 * both unions from the service.
 */
export type SpinRefusal =
  | "account_inactive"
  | "account_too_new"
  | "phone_not_verified"
  | "no_active_service"
  | "paid_too_little"
  | "too_few_orders"
  | "not_in_group"
  | "flagged"
  | "shared_device"
  | "daily_limit"
  | "cooldown"
  | "no_wheel"
  | "no_fingerprint"
  | "spin_in_progress";

export const REFUSAL_KEYS: Record<SpinRefusal, string> = K.refusals;

/** A reason's sentence key; an unknown one (a newer billing) gets none and the caller says the generic thing. */
export function refusalKeyOf(reason: unknown): string | null {
  return typeof reason === "string" && reason in REFUSAL_KEYS ? REFUSAL_KEYS[reason as SpinRefusal] : null;
}

/** The sentence key of a refused call (`no_wheel`, …), from the error body. */
export const refusalKey = (e: unknown) => refusalKeyOf((e as { reason?: unknown } | null)?.reason);

// ------------------------------------------------------------- the animation

/** Whole turns before the wheel settles: enough to read as a spin. */
const TURNS = 5;

/**
 * Slot `i` (1-based) spans `[(i-1)·seg, i·seg)` clockwise from the pointer at
 * the top. The wheel turns clockwise by `rotation` degrees, so the slot under
 * the pointer is the one whose span holds `-rotation`.
 */
export function slotUnderPointer(rotation: number, count: number): number {
  const seg = 360 / count;
  const at = (((-rotation % 360) + 360) % 360);
  return Math.floor(at / seg) + 1;
}

/**
 * Where to animate to from `from` so that slot `position` — the one billing
 * named — stops centred under the pointer, after {@link TURNS} whole turns.
 * The client chooses nothing (ADR-0111 point 4): the same inputs, the same stop.
 */
export function landingRotation(from: number, position: number, count: number): number {
  const seg = 360 / count;
  const target = (360 - (position - 0.5) * seg) % 360;
  const now = ((from % 360) + 360) % 360;
  const delta = (target - now + 360) % 360;
  return from + TURNS * 360 + delta;
}

// ----------------------------------------------------------------- one tap

/**
 * The key of the next tap. After a lost answer (network, timeout) the same
 * key is sent again, so billing answers the spin it may already have made
 * (F-707-d rule 1); after any answer, a new tap is a new spin.
 */
export function nextRequestId(current: string, outcome: "lost" | "answered"): string {
  return outcome === "lost" ? current : crypto.randomUUID();
}

// ------------------------------------------------------------ what is told

/** `"1.50"` -> `"1.5"`, `"3.00"` -> `"3"`: a prize's figure as people say it. */
export const plainNumber = (v: string) => (v.includes(".") ? v.replace(/\.?0+$/, "") : v);

export interface Line {
  key: string;
  values: Record<string, string>;
  /** A refusal's own sentence key, said after the line. */
  reason?: string;
}

/** The sentence for a spin's answer: the prize by its kind, a refusal by its reason, else nothing won. */
export function resultLine(r: SpinResult, texts: Record<string, string> = {}): Line {
  if (r.status !== "awarded") return { key: K.result.refused, values: {}, reason: refusalKeyOf(r.refusalReason) ?? undefined };
  if (!r.prize) return { key: K.result.empty, values: {} };
  const type = r.prize.prizeType;
  const key = type === "empty" ? K.result.empty : K.result[type];
  // GB and days say which service they went to (F-707-y), named as My services names it.
  const s = r.reward?.service;
  const service = (s && (s.label ?? (s.nameKey ? texts[s.nameKey] : undefined) ?? s.sku)) || "";
  return { key, values: type === "empty" ? {} : { value: plainNumber(r.prize.prizeValue), label: r.prize.label, service } };
}

/** A tenant day (`YYYY-MM-DD`) in the reader's calendar, never shifted by their zone. */
export function formatDay(day: string, lang: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  try {
    return new Intl.DateTimeFormat(numberLocale(lang), { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(date);
  } catch {
    return day;
  }
}

/** A slot's odds as the list writes them; one whose prize cannot reach this user's services says so (F-707-v). */
export function oddsLine(p: { oddsPercent: string; reachable: boolean }): Line {
  return { key: p.reachable ? K.odds.chance : K.odds.unreachable, values: { percent: plainNumber(p.oddsPercent) } };
}
