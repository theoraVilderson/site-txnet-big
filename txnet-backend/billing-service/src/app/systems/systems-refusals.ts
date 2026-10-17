import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { InboundHeldElsewhere } from './member-inbounds';
import { PanelAlreadyRegistered } from './panel-address';
import { PanelScopeRefused } from './panel-scope';
import { SystemsRefused, SystemsRejection } from './systems-read';

/** The refusals that are a state already reached, not something absent: 409. */
const CONFLICTS: ReadonlySet<SystemsRejection> = new Set([
  'already_acknowledged',
  'already_resolved',
  'already_member',
  'already_draining',
  'no_other_member',
  'member_has_configs',
  'inbound_not_sellable',
  'not_for_transport',
  'panel_already_registered',
  'not_for_driver',
  'panel_in_group',
  'panel_has_configs',
  'panel_retired',
  'panel_not_retired',
  'group_has_members',
  'group_in_use',
  'inbound_has_configs',
  'not_a_seller',
  'already_releasing',
  'request_reused',
]);

/** The refusals that are a body the event cannot take (F-027-fa): 400. */
const BAD_REQUESTS: ReadonlySet<SystemsRejection> = new Set(['resolution_required', 'resolution_not_for_event', 'cost_in_closed_month', 'selection_too_large']);

/**
 * The service's refusals as HTTP: the scope is a 403, a panel, group or event
 * outside it a 404. A holder travels as `facts` ids — the envelope drops every
 * other field and a fact is never free text, so the page names it from its own
 * scoped lists (F-027-ci). Exported for the spec that pins that.
 */
export async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof PanelScopeRefused) throw new ForbiddenException({ reason: e.reason, message: e.message });
    if (e instanceof SystemsRefused) {
      if (e instanceof PanelAlreadyRegistered) {
        throw new ConflictException({ reason: e.reason, message: e.message, facts: e.panel ? { panelId: e.panel.id } : undefined });
      }
      if (e instanceof InboundHeldElsewhere) {
        // `groups`: every group losing it, each a release job's to move or empty (F-027-es).
        const facts = { remoteId: e.remoteId, groupId: e.group.id, configs: e.configs, groups: e.groups };
        throw new ConflictException({ reason: e.reason, message: e.message, facts });
      }
      if (CONFLICTS.has(e.reason)) throw new ConflictException({ reason: e.reason, message: e.message });
      if (BAD_REQUESTS.has(e.reason)) throw new BadRequestException({ reason: e.reason, message: e.message });
      throw new NotFoundException({ reason: e.reason, message: e.message });
    }
    throw e;
  }
}
