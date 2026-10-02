/**
 * F-1503 / ADR-0109 point 8, the step after candidates: a candidate whose
 * confidence is below the tenant's threshold (`ai.setting`, default 0.6) is
 * dropped. One irrelevant suggestion costs more than ten good ones not given.
 *
 * Both sides are compared at `action.confidence`'s precision (4 places), so
 * the decision is the one the stored row shows, never a float artefact.
 */

export type ThresholdVerdict = { pass: true } | { pass: false; suppressedBy: 'confidence_threshold' };

const SCALE = 10_000;

export function thresholdVerdict(confidence: number, threshold: number): ThresholdVerdict {
  const below = !Number.isFinite(confidence) || Math.round(confidence * SCALE) < Math.round(threshold * SCALE);
  return below ? { pass: false, suppressedBy: 'confidence_threshold' } : { pass: true };
}
