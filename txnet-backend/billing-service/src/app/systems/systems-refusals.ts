import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { BackendI18nKeys, ResellerLimitReached } from '@txnet-backend/shared-core';

import { ConfigMoveJobRefused } from '../payment/gift/config-move-job';
import { moveJobRefusal } from '../payment/gift/reseller-config-move-job.controller';
import { GRANT_REGROUP_STATUS, GrantRegroupRefused } from '../traffic/grant-regroup';
import { InboundHeldElsewhere } from './member-inbounds';
import { PanelAlreadyRegistered } from './panel-address';
import { PanelCredentialRefused, PanelCredentialUnavailable } from './panel-credential.client';
import { PanelResubmitRefused } from './panel-registration';
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
const BAD_REQUESTS: ReadonlySet<SystemsRejection> = new Set(['resolution_required', 'resolution_not_for_event', 'cost_in_closed_month', 'cost_finer_than_currency', 'selection_too_large']);

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
    if (e instanceof ResellerLimitReached) throw limitReached(e);
    // A Grant moved to another group, and its job (F-027-et): the reseller surface's statuses.
    if (e instanceof GrantRegroupRefused) {
      const Exception = GRANT_REGROUP_STATUS[e.reason] === 404 ? NotFoundException : ConflictException;
      throw new Exception({ reason: e.reason, message: e.message });
    }
    if (e instanceof ConfigMoveJobRefused) throw moveJobRefusal(e);
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

/** The routes that write a login or a secret: the scope as 403, the vault seam's refusals relayed, its silence a 502. */
export async function relayingVault<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof PanelScopeRefused) throw new ForbiddenException({ reason: e.reason, message: e.message });
    if (e instanceof PanelResubmitRefused) throw new ConflictException({ reason: e.reason, message: e.message });
    if (e instanceof ResellerLimitReached) throw limitReached(e);
    if (e instanceof PanelCredentialRefused) throw new HttpException({ reason: e.reason, message: e.message }, e.status);
    if (e instanceof PanelCredentialUnavailable) {
      throw new BadGatewayException({ reason: 'credentials_unavailable', message: 'the credential vault could not be reached' });
    }
    throw e;
  }
}

/** A reseller past its own limit (`panels_max`, BYO-1-a): 409 with its figures, for the page to name. */
function limitReached(e: ResellerLimitReached): ConflictException {
  return new ConflictException({ i18nKey: BackendI18nKeys.errors.billing.resellerLimitReached, reason: e.reason, message: e.message, facts: e.facts });
}
