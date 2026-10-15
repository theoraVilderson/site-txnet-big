import { PanelDriftEventType, Prisma } from '@prisma/client';

import { DriftResolution } from './panel-registration.schema';
import { PANEL_RETEST } from './panel-retest';

/** The event as an acknowledgement reads it. */
type AcknowledgedEvent = { eventType: PanelDriftEventType; seenAddresses: string[] };

/** The panel write an acknowledgement carries (null: none), or why the choice does not fit the event. */
export type AcknowledgeWrite =
  | { refused: 'resolution_required' | 'resolution_not_for_event' }
  | { panel: Prisma.PanelUncheckedUpdateManyInput | null };

/**
 * What acknowledging `event` with `resolution` writes on its panel, in the
 * acknowledgement's own transaction (F-027-fa). Desired state only:
 * `network-service` acts on it on the next pass (ADR-0071).
 *
 *  - `identity_lost` takes a choice. `rebuilt` clears the anchor, so the next
 *    pass plants a new one (`network/contract.registration.md` rule 13) and
 *    the convergence recreates every config; `address_fixed` keeps it, so the
 *    next pass checks the same anchor again.
 *  - `address_moved` trusts what the collector saw and sends the panel back to
 *    the connection test, which records what it dials
 *    (`network/contract.address.md` rule 6).
 *  - Every other type takes no choice: the event alone resumes the panel. A
 *    choice it cannot mean is refused, never dropped.
 */
export function acknowledgeWrite(event: AcknowledgedEvent, resolution: DriftResolution | undefined): AcknowledgeWrite {
  if (event.eventType === PanelDriftEventType.identity_lost) {
    if (!resolution) return { refused: 'resolution_required' };
    return { panel: resolution === 'rebuilt' ? { anchorTag: null, anchorUuid: null, anchorRemoteId: null } : null };
  }
  if (resolution) return { refused: 'resolution_not_for_event' };
  if (event.eventType === PanelDriftEventType.address_moved) {
    return { panel: { knownAddresses: event.seenAddresses, ...PANEL_RETEST } };
  }
  return { panel: null };
}
