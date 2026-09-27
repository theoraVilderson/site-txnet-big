import type { GrantStatus, UserConfigRow } from "@/lib/billing-api";

/**
 * Whether a service is moving data, and where a purchase is on its way to
 * ready (F-307-u). Pure: the row's figures and a clock in, a verdict out.
 */

/**
 * How long after its last charged traffic a Grant still reads "in use":
 * two and a half bulk collection passes (`collect.DefaultInterval` is 60 s).
 * Traffic that keeps flowing is charged every pass and pushed at most every
 * 30 s, so a live service is re-stamped well inside this; one that stopped is
 * idle within three minutes of stopping.
 */
export const LIVE_WINDOW_MS = 150_000;

/**
 * `live` while the last traffic is inside {@link LIVE_WINDOW_MS}; `idleMs` is
 * how long ago it was, or `null` when the Grant never moved a byte. A stamp a
 * little ahead of this clock (the server's runs ahead) counts as now.
 */
export function activityOf(lastTrafficAt: string | null, now: Date): { live: boolean; idleMs: number | null } {
  if (!lastTrafficAt) return { live: false, idleMs: null };
  const at = new Date(lastTrafficAt).getTime();
  if (Number.isNaN(at)) return { live: false, idleMs: null };
  const idleMs = Math.max(0, now.getTime() - at);
  return { live: idleMs < LIVE_WINDOW_MS, idleMs };
}

/** "How long ago" in its largest whole unit; under a minute is `now`. */
export function agoOf(ms: number): { unit: "now" | "minutes" | "hours" | "days"; n: number } {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return { unit: "now", n: 0 };
  if (minutes < 60) return { unit: "minutes", n: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hours", n: hours };
  return { unit: "days", n: Math.floor(hours / 24) };
}

export type Level = "ok" | "low" | "critical";

/** A meter's colour from the share still left: under a quarter runs low, under a tenth is nearly out. */
export function levelOf(leftShare: number): Level {
  if (leftShare < 0.1) return "critical";
  if (leftShare < 0.25) return "low";
  return "ok";
}

/** Percent left for a person: whole, never 100 once a byte is used, never 0 while one is left. */
export function percentLeft(leftShare: number): number {
  if (leftShare <= 0) return 0;
  if (leftShare >= 1) return 100;
  return Math.min(99, Math.max(1, Math.floor(leftShare * 100)));
}

/**
 * Where a purchase is (F-111-f, F-111-l): `server` while entitlement is
 * delivering it; `links` once delivered while every config is still waiting
 * for its first captured lines; `null` when there is nothing to wait for —
 * a line to connect with exists, the configs were not read, or the Grant is
 * in no state that is on its way anywhere. A config whose panel gives no lines
 * (`linksCapturedAt` set) is an answer, not a wait.
 */
export function buildStage(status: GrantStatus, configs: UserConfigRow[] | null): "server" | "links" | null {
  if (status === "pending") return "server";
  if (status !== "active" || !configs || configs.length === 0) return null;
  return configs.every((c) => c.lines.length === 0 && c.linksCapturedAt === null) ? "links" : null;
}
