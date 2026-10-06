import { STALE_AFTER_SECONDS } from '../traffic/collection-health';

/**
 * Is a panel's stored health current? (F-027-em, ADR-0122)
 *
 * `panel.panelState` is written only by a running collector, so on its own
 * it cannot tell a fresh `healthy` from one written days ago by a collector
 * that has since died — the dev incident of 2026-10-06. Every reader of a
 * panel's health goes through this, so the page, and anything after it,
 * says the same thing:
 *
 * - **on hold** — the outage is ours: no collector heartbeat for
 *   `STALE_AFTER_SECONDS` (the threshold `NetworkCollectorSilent` fires at),
 *   or the last pass ruled our own reach down and this panel has not been
 *   judged since. Its stored state is shown as unknown, never as the panel's.
 * - **not checked** — the collector runs and has not judged this panel for
 *   as long (the vault will not open it, say). A panel refusing us is not
 *   asked during its cool-off, and that is not this.
 * - **current** — what it stores is what it last answered.
 */

/** `network.CollectorEgress`: the last pass's ruling on our own reach. */
export type CollectorEgress = 'ok' | 'down' | 'dns_down' | 'suspect';

/** The freshest `network.collector_heartbeat` row, or null when none was ever written. */
export type CollectorBeat = { passAt: Date; egress: CollectorEgress; egressSince: Date } | null;

export const HELD_REASONS = ['collector_stopped', 'collector_never_ran', 'egress_down', 'egress_suspect', 'dns_down'] as const;
export type HeldReason = (typeof HELD_REASONS)[number];
export type PanelHealthView = 'current' | 'on_hold' | 'not_checked';

export type PanelHealthJudgement = { view: PanelHealthView; heldBy: { reason: HeldReason; since: Date | null } | null };

type PanelInput = { reviewState: string; panelState: string; panelCheckedAt: Date | null };

const EGRESS_REASON: Record<Exclude<CollectorEgress, 'ok'>, HeldReason> = {
  down: 'egress_down',
  suspect: 'egress_suspect',
  dns_down: 'dns_down',
};

/**
 * A pass stamps the panels it judged before it ends and rules on our reach
 * at its end, so a panel judged in the very pass the outage was found in is
 * stamped a little before `egressSince`. One and a half bulk passes of grace.
 */
const RULING_GRACE_MS = 90_000;

const COLLECTED = new Set(['accepted', 'accepted_low_trust']);

export function judgePanelHealth(panel: PanelInput, beat: CollectorBeat, now: Date): PanelHealthJudgement {
  if (!COLLECTED.has(panel.reviewState)) return { view: 'current', heldBy: null };
  if (beat === null) return { view: 'on_hold', heldBy: { reason: 'collector_never_ran', since: null } };

  const stale = (at: Date) => now.getTime() - at.getTime() > STALE_AFTER_SECONDS * 1000;
  if (stale(beat.passAt)) return { view: 'on_hold', heldBy: { reason: 'collector_stopped', since: beat.passAt } };

  const checked = panel.panelCheckedAt;
  if (beat.egress !== 'ok' && (checked === null || checked.getTime() < beat.egressSince.getTime() - RULING_GRACE_MS)) {
    return { view: 'on_hold', heldBy: { reason: EGRESS_REASON[beat.egress], since: beat.egressSince } };
  }
  if (panel.panelState !== 'throttled_or_blocked' && (checked === null || stale(checked))) {
    return { view: 'not_checked', heldBy: null };
  }
  return { view: 'current', heldBy: null };
}
