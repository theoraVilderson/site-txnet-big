import { ApiError } from "@/lib/api-error";
import type { ConfigMoveTargets, MoveTargetPanel } from "@/lib/billing-api";

/** What a config offers its user on «تغییر سرور» (F-410-d); `hidden` draws nothing. */
export type MoveOffer = { kind: "hidden" } | { kind: "wait"; until: string } | { kind: "open"; panels: MoveTargetPanel[] };

/**
 * The offer from billing's answer (network `contract.config-move.md`
 * "Self-move"), never re-derived: switched off, or no server to go to — a
 * `mirror` Grant is on every one already — is nothing at all; a server to go
 * to inside the wait is the wait. An unread answer is nothing too.
 */
export function moveOfferOf(targets: ConfigMoveTargets | null): MoveOffer {
  if (!targets || !targets.enabled || targets.panels.length === 0) return { kind: "hidden" };
  if (targets.nextMoveAt !== null) return { kind: "wait", until: targets.nextMoveAt };
  return { kind: "open", panels: targets.panels };
}

/**
 * A server as the user may know it — its region, the only thing billing
 * answers of it (F-410-b) — numbered in billing's order when two share one,
 * so the choice is never between two identical words.
 */
export function targetOptions(panels: readonly MoveTargetPanel[]): { value: string; label: string }[] {
  const total = new Map<string, number>();
  for (const p of panels) total.set(p.region, (total.get(p.region) ?? 0) + 1);
  const seen = new Map<string, number>();
  return panels.map((p) => {
    const nth = (seen.get(p.region) ?? 0) + 1;
    seen.set(p.region, nth);
    return { value: p.id, label: (total.get(p.region) ?? 0) > 1 ? `${p.region} ${nth}` : p.region };
  });
}

/** The end of the wait a `move_cooldown` refusal carries (`facts.nextAtMs`), as ISO; any other refusal is `null`. */
export function moveWaitOf(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.reason !== "move_cooldown") return null;
  const { nextAtMs } = e.facts;
  return typeof nextAtMs === "number" && Number.isFinite(nextAtMs) ? new Date(nextAtMs).toISOString() : null;
}
