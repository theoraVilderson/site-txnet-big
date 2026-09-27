import type { GrantStatus, UserConfigRow } from "@/lib/billing-api";

/**
 * Whether a service is moving data, and where a purchase is on its way to
 * ready (F-307-u). Pure: the row's figures and a clock in, a verdict out.
 */

/**
 * How often a Grant in use is told its bytes: measured on dev on 2026-09-27,
 * 43 gaps between `entitlement.grant.usage` events of one Grant — median
 * 40 s, p99 42.5 s. Recompute with the query in contract.service-pulse.md.
 */
export const PUSH_GAP_MS = 40_000;

/**
 * Live while the next push is still due: one gap and ten seconds. Past it the
 * push that traffic would have sent is late — the service has probably
 * stopped, and the row stops saying "in use" (user, 2026-09-27: a service
 * that stopped kept reading live, "don't let it fool the user").
 */
export const LIVE_WINDOW_MS = PUSH_GAP_MS + 10_000;

/** Two pushes missed: the service is idle, not late. */
export const STOPPED_AFTER_MS = 2 * PUSH_GAP_MS + 10_000;

export type ActivityState = "live" | "cooling" | "idle" | "never";

/**
 * Where a Grant is from its last charged traffic: `live` while the next push
 * is due, `cooling` once one is missed (probably stopped — said as such),
 * `idle` after two, `never` when it has moved no byte. `idleMs` is how long
 * ago; a stamp a little ahead of this clock (the server's runs ahead) is now.
 */
export function activityOf(lastTrafficAt: string | null, now: Date): { state: ActivityState; idleMs: number | null } {
  if (!lastTrafficAt) return { state: "never", idleMs: null };
  const at = new Date(lastTrafficAt).getTime();
  if (Number.isNaN(at)) return { state: "never", idleMs: null };
  const idleMs = Math.max(0, now.getTime() - at);
  const state = idleMs < LIVE_WINDOW_MS ? "live" : idleMs < STOPPED_AFTER_MS ? "cooling" : "idle";
  return { state, idleMs };
}

/** When the verdict can next change: the window's edge, else the next whole minute of idleness. */
export function nextChangeIn(state: ActivityState, idleMs: number | null): number | null {
  if (state === "never" || idleMs === null) return null;
  if (state === "live") return LIVE_WINDOW_MS - idleMs;
  if (state === "cooling") return STOPPED_AFTER_MS - idleMs;
  return 60_000 - (idleMs % 60_000);
}

/** "How long ago" in its largest whole unit; under five seconds is `now`. */
export function agoOf(ms: number): { unit: "now" | "seconds" | "minutes" | "hours" | "days"; n: number } {
  if (ms < 5_000) return { unit: "now", n: 0 };
  if (ms < 60_000) return { unit: "seconds", n: Math.floor(ms / 1000) };
  const minutes = Math.floor(ms / 60_000);
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
