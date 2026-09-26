import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { capabilityMatrix } from './capabilities';
import { inScope, panelScopeOf, SystemsActor } from './panel-scope';

export type SystemsRejection =
  | 'not_found'
  | 'already_acknowledged'
  | 'already_resolved'
  // Panel groups (F-027-bw).
  | 'panel_not_found'
  | 'member_not_found'
  | 'already_member'
  | 'already_draining'
  | 'member_has_configs'
  // A panel's inbounds (F-114-b).
  | 'inbound_not_found'
  | 'inbound_not_sellable'
  // A panel's settings (F-027-by).
  | 'not_for_transport'
  // One panel, one address (F-027-cd).
  | 'panel_already_registered'
  // A router's .ovpn (F-307-d).
  | 'not_for_driver'
  // Deleting a panel (F-027-bz).
  | 'panel_in_group'
  | 'panel_has_configs'
  | 'panel_retired'
  | 'panel_not_retired'
  // Deleting a panel group (F-027-ca).
  | 'group_has_members'
  | 'group_in_use'
  // An inbound is the pool's or one group's (F-027-ch).
  | 'inbound_assigned_elsewhere'
  | 'inbound_has_configs';

export class SystemsRefused extends Error {
  constructor(readonly reason: SystemsRejection) {
    super(reason);
    this.name = 'SystemsRefused';
  }
}

export type DriftEventQuery = { state?: 'open' | 'all'; after?: string; limit?: number };

const DRIFT_PAGE = 50;

/**
 * Field by field, never a spread row: `panelApiCredentials` is on the same
 * row, and a list that selected it would hand the vault reference to a page.
 */
const PANEL_FIELDS = {
  id: true,
  name: true,
  driverType: true,
  transport: true,
  role: true,
  region: true,
  // What the edit form starts from (F-027-by). Addresses, not secrets.
  ipAddress: true,
  apiBaseUrl: true,
  clientBaseUrl: true,
  // A router's shared client file (F-307-d): a CA and an address, no key.
  ovpnProfile: true,
  reviewState: true,
  connectionTestedAt: true,
  connectionTestFault: true,
  connectionTestDetail: true,
  // The panel a refused duplicate is (F-027-ce): its id and name, and whose it is to decide whether to name it.
  duplicateOf: { select: { id: true, name: true, ownershipType: true, tenantId: true } },
  panelState: true,
  blockedSince: true,
  lastHealthyAt: true,
  lastSuccessfulCollectionAt: true,
  maxRequestsPerMinute: true,
  // Selected only to answer whether it is set; the reference never leaves.
  panelRadiusSecret: true,
  retiredAt: true,
} satisfies Prisma.PanelSelect;

const DRIFT_FIELDS = {
  id: true,
  panelId: true,
  eventType: true,
  affectedConfigCount: true,
  observedConfigCount: true,
  detectedAt: true,
  collectionHalted: true,
  acknowledgedAt: true,
  acknowledgedByAdminId: true,
  note: true,
} satisfies Prisma.PanelDriftEventSelect;

/**
 * The systems page's reads and its drift action (F-027-as, ADR-0080).
 *
 * Every method opens with {@link panelScopeOf}, and every query carries its
 * answer: a panel outside the scope is absent from a list and `not_found` by
 * id, the same as one that does not exist. Nothing here is computed from a
 * call to `network-service` (ADR-0071): health, budget and the matrix are what
 * its loops last wrote, and a figure that is stale says so by its timestamp.
 *
 * `network.panel` and `network.panel_drift_event` have no RLS policy, so the
 * app pool reads and writes them directly.
 */
@Injectable()
export class SystemsReadService {
  private readonly logger = new Logger(SystemsReadService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every panel in scope: its review, its health and the budget we hold
   * ourselves to on it. `collectionHalted` is the collector's own test — an
   * unacknowledged halting event — so the page and the loop cannot disagree.
   */
  async panels(actor: SystemsActor) {
    const scope = await panelScopeOf(this.prisma, actor);
    const panels = await this.prisma.panel.findMany({ where: scope, select: PANEL_FIELDS, orderBy: { name: 'asc' } });
    const open = await this.prisma.panelDriftEvent.findMany({
      where: { panelId: { in: panels.map((p) => p.id) }, acknowledgedAt: null },
      select: { panelId: true, collectionHalted: true },
    });

    return panels.map((p) => {
      const mine = open.filter((e) => e.panelId === p.id);
      return {
        id: p.id,
        name: p.name,
        driverType: p.driverType,
        transport: p.transport,
        role: p.role,
        region: p.region,
        ipAddress: p.ipAddress,
        apiBaseUrl: p.apiBaseUrl,
        clientBaseUrl: p.clientBaseUrl,
        ovpnProfile: p.ovpnProfile,
        // Archived (F-027-bz): kept for its records, skipped by every loop.
        retiredAt: p.retiredAt,
        // A push panel with no secret never reaches the RADIUS allowlist (F-027-az); null on a pull panel.
        radiusSecretConfigured: p.transport === 'push' ? p.panelRadiusSecret !== null : null,
        review: {
          reviewState: p.reviewState,
          connectionTestedAt: p.connectionTestedAt,
          connectionTestFault: p.connectionTestFault,
          connectionTestDetail: p.connectionTestDetail,
          // Named only inside the reader's scope, as a foreign claim is.
          duplicateOf: p.duplicateOf && inScope(scope, p.duplicateOf) ? { id: p.duplicateOf.id, name: p.duplicateOf.name } : null,
        },
        health: {
          panelState: p.panelState,
          lastHealthyAt: p.lastHealthyAt,
          lastSuccessfulCollectionAt: p.lastSuccessfulCollectionAt,
          collectionHalted: mine.some((e) => e.collectionHalted),
          openDriftEvents: mine.length,
        },
        budget: { maxRequestsPerMinute: p.maxRequestsPerMinute, blockedSince: p.blockedSince },
      };
    });
  }

  /** One panel's questionnaire, every row in order, as the connection test last answered it. */
  async capabilities(actor: SystemsActor, panelId: string) {
    const scope = await panelScopeOf(this.prisma, actor);
    const panel = await this.prisma.panel.findFirst({
      where: { id: panelId, ...scope },
      select: { id: true, transport: true, reviewState: true, connectionTestedAt: true, capabilities: true },
    });
    if (!panel) throw new SystemsRefused('not_found');

    const { capabilities, ...rest } = panel;
    return { ...rest, ...capabilityMatrix(capabilities, panel.transport) };
  }

  /**
   * The drift report: events on panels in scope, newest first, keyset-paged by
   * event id. `state: open` narrows it to the unacknowledged ones.
   */
  async driftEvents(actor: SystemsActor, query: DriftEventQuery) {
    const scope = await panelScopeOf(this.prisma, actor);
    const panels = await this.prisma.panel.findMany({ where: scope, select: { id: true, name: true } });
    const names = new Map(panels.map((p) => [p.id, p.name]));
    const take = query.limit ?? DRIFT_PAGE;

    const rows = await this.prisma.panelDriftEvent.findMany({
      where: { panelId: { in: [...names.keys()] }, ...(query.state === 'open' ? { acknowledgedAt: null } : {}) },
      select: { ...DRIFT_FIELDS, foreignPanelId: true },
      orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
      take,
      ...(query.after ? { cursor: { id: query.after }, skip: 1 } : {}),
    });

    // A `foreign_claim` names the panel whose clients were found (F-027-cf) —
    // only one inside the reader's scope: another tenant's panel is not named.
    return {
      items: rows.map(({ foreignPanelId, ...e }) => ({
        ...e,
        panelName: names.get(e.panelId) ?? null,
        foreignPanel: foreignPanelId && names.has(foreignPanelId) ? { id: foreignPanelId, name: names.get(foreignPanelId) as string } : null,
      })),
      next: rows.length === take ? rows[rows.length - 1].id : null,
    };
  }

  /**
   * Acknowledging a drift event: the decision `collect.Containment.Halted`
   * waits for. It reads `collectionHalted && acknowledgedAt IS NULL`, so this
   * sets `acknowledgedAt` and the panel is read again on the next pass.
   *
   * **Once.** The update is conditional on `acknowledgedAt IS NULL`, so of two
   * concurrent clicks one wins and the other is `already_acknowledged`: who
   * decided, and when, is never rewritten.
   */
  async acknowledge(actor: SystemsActor, eventId: string, input: { note?: string }) {
    const scope = await panelScopeOf(this.prisma, actor);
    const where = { id: eventId, panel: scope };

    const { count } = await this.prisma.panelDriftEvent.updateMany({
      where: { ...where, acknowledgedAt: null },
      data: { acknowledgedAt: new Date(), acknowledgedByAdminId: actor.adminId, ...(input.note ? { note: input.note } : {}) },
    });

    const event = await this.prisma.panelDriftEvent.findFirst({ where, select: DRIFT_FIELDS });
    if (!event) throw new SystemsRefused('not_found');
    if (count === 0) throw new SystemsRefused('already_acknowledged');

    this.logger.log(`drift event ${eventId} on panel ${event.panelId} acknowledged by ${actor.adminId}`);
    return event;
  }
}
