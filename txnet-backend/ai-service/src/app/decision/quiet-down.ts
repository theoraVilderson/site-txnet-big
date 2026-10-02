import type { AiActionType } from '@prisma/client';

/**
 * F-1506 / ADR-0109 point 8: no pitch while the subject is in the middle of a
 * problem. An open ticket holds every type until it closes — support is
 * already talking to them. For 72 hours after a failed payment every type but
 * `checkout_help` is held: that one is the help for the failure (point 9), so
 * the failure that triggers it never silences it.
 *
 * Outage and connection-quality drop are the catalog's other two conditions;
 * both need network-layer data the engine may not read (point 6), so neither
 * is a rule here.
 */

export const QUIET_AFTER_FAILED_PAYMENT_MS = 72 * 3_600_000;

/** The one type a failed payment does not silence. */
const HELP_FOR_FAILED_PAYMENT: AiActionType = 'checkout_help';

export type QuietInputs = { openTicket: boolean; lastFailedPaymentAt: Date | null };

export type QuietDownVerdict = { pass: true } | { pass: false; suppressedBy: 'quiet_down'; retryAt: Date | null };

export function quietDownVerdict(inputs: QuietInputs, actionType: AiActionType, now: Date): QuietDownVerdict {
  if (inputs.openTicket) return { pass: false, suppressedBy: 'quiet_down', retryAt: null };
  if (inputs.lastFailedPaymentAt && actionType !== HELP_FOR_FAILED_PAYMENT) {
    const reopensAt = inputs.lastFailedPaymentAt.getTime() + QUIET_AFTER_FAILED_PAYMENT_MS;
    if (reopensAt > now.getTime()) return { pass: false, suppressedBy: 'quiet_down', retryAt: new Date(reopensAt) };
  }
  return { pass: true };
}
