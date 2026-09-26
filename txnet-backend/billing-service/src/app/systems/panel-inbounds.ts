import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { effectiveSellingSettings, SellingLayerValues } from '../traffic/selling-settings';
import { panelScopeOf, SystemsActor } from './panel-scope';
import { SystemsRefused } from './systems-read';

/** One inbound's pick. `maxClients` null = no cap. */
export type InboundPickInput = { remoteId: string; sold: boolean; maxClients?: number | null };

/**
 * The panel's layer of the selling settings (F-027-cg; null hands one to the
 * platform default) and any picks, all optional; what is left out keeps its value.
 */
export type PanelInboundsInput = SellingLayerValues & { inbounds?: InboundPickInput[] };

const INBOUND_FIELDS = {
  remoteId: true,
  tag: true,
  protocol: true,
  port: true,
  host: true,
  enabled: true,
  goneAt: true,
  seenAt: true,
  sold: true,
  maxClients: true,
  // The group it is assigned to (F-027-ch); none = the panel's default pool.
  assignment: { select: { member: { select: { group: { select: { id: true, name: true } } } } } },
} satisfies Prisma.PanelInboundSelect;

const PANEL_FIELDS = { id: true, inboundPlacement: true, maxClients: true, priority: true, weight: true, inboundsReadAt: true } satisfies Prisma.PanelSelect;

/**
 * A panel's inbounds on the systems surface (F-114-b, network
 * `contract.inbounds.md`): what `network-service` last read from the panel,
 * and the admin's pick of which ones a buyer is placed on, how (`all` |
 * `spread`), and how many users each inbound and the panel take.
 *
 * Desired state only: nothing here calls the panel. A refresh clears
 * `inboundsReadAt`, and the panel's next convergence pass reads its inbounds
 * again. A pick reaches the **next** placement; configs already placed stay
 * where they are (rule 6).
 *
 * On the cross-tenant pool, as `PanelGroupsService`: a platform panel's rows
 * carry `tenantId` null, which the app pool's `WITH CHECK` refuses. Every
 * query carries the scope, so the wider policy reaches no tenant's panel.
 */
@Injectable()
export class PanelInboundsService {
  private readonly logger = new Logger(PanelInboundsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
  ) {}

  /**
   * The panel's selling settings as stored (null = the platform's) and
   * `effective` — each value with its layer, `panel` or `platform` (F-027-cg);
   * its inbounds by id, how full each is, and `assignedTo` — the group it is
   * assigned to, or null for the default pool (F-027-ch).
   */
  async inbounds(actor: SystemsActor, panelId: string) {
    const panel = await this.panelInScope(actor, panelId);
    const [rows, load] = await Promise.all([
      this.crossTenant.panelInbound.findMany({ where: { panelId: panel.id }, select: INBOUND_FIELDS }),
      this.load(panel.id),
    ]);
    const inbounds = rows
      .sort((a, b) => a.remoteId.localeCompare(b.remoteId, 'en', { numeric: true }))
      .map(({ assignment, ...i }) => ({ ...i, assignedTo: assignment?.member.group ?? null, clients: load.byInbound.get(i.remoteId) ?? 0 }));
    const { id, inboundsReadAt, ...settings } = panel;
    return { panelId: id, ...settings, effective: effectiveSellingSettings(null, settings), inboundsReadAt, users: load.users, inbounds };
  }

  /**
   * Writes the placement settings and the picks together. A pick names an
   * inbound the last read found (`inbound_not_found` otherwise), and only one
   * a buyer can be placed on may be sold: not gone, of a protocol we sell
   * (`inbound_not_sellable`). Unselling is always allowed.
   */
  async update(actor: SystemsActor, panelId: string, input: PanelInboundsInput) {
    const panel = await this.panelInScope(actor, panelId);
    const picks = input.inbounds ?? [];
    await this.crossTenant.$transaction(async (tx) => {
      if (picks.length > 0) {
        const known = await tx.panelInbound.findMany({
          where: { panelId: panel.id, remoteId: { in: picks.map((p) => p.remoteId) } },
          select: { remoteId: true, protocol: true, goneAt: true },
        });
        for (const pick of picks) {
          const row = known.find((k) => k.remoteId === pick.remoteId);
          if (!row) throw new SystemsRefused('inbound_not_found');
          if (pick.sold && (row.protocol === null || row.goneAt !== null)) throw new SystemsRefused('inbound_not_sellable');
        }
        for (const pick of picks) {
          await tx.panelInbound.update({
            where: { panelId_remoteId: { panelId: panel.id, remoteId: pick.remoteId } },
            data: { sold: pick.sold, ...(pick.maxClients !== undefined ? { maxClients: pick.maxClients } : {}) },
          });
        }
      }
      const { inboundPlacement, maxClients, priority, weight } = input;
      const settings = Object.fromEntries(Object.entries({ inboundPlacement, maxClients, priority, weight }).filter(([, v]) => v !== undefined));
      if (Object.keys(settings).length > 0) await tx.panel.update({ where: { id: panel.id }, data: settings });
    });
    this.logger.log(`panel ${panel.id} inbounds edited by ${actor.adminId}`);
    return this.inbounds(actor, panel.id);
  }

  /** Ask for a fresh read: the panel's next pass reads its inbounds (`inboundsReadAt` null). */
  async refresh(actor: SystemsActor, panelId: string) {
    const panel = await this.panelInScope(actor, panelId);
    await this.crossTenant.panel.update({ where: { id: panel.id }, data: { inboundsReadAt: null } });
    return { panelId: panel.id, refreshRequested: true as const };
  }

  private async panelInScope(actor: SystemsActor, panelId: string) {
    const scope = await panelScopeOf(this.prisma, actor);
    const panel = await this.crossTenant.panel.findFirst({ where: { id: panelId, ...scope }, select: PANEL_FIELDS });
    if (!panel) throw new SystemsRefused('panel_not_found');
    return panel;
  }

  /** Live configs per inbound and users on the panel — what fulfilment counts against the caps (rule 4). */
  private async load(panelId: string) {
    const rows = await this.crossTenant.$queryRaw<{ inboundRemoteId: string | null; total: number; clients: bigint; users: bigint }[]>`
      SELECT c."inboundRemoteId", GROUPING(c."inboundRemoteId")::int AS total, count(*) AS clients, count(DISTINCT c."grantId") AS users
        FROM "network"."config" c
       WHERE c."panelId" = ${panelId}::uuid AND c."desiredRemote" = 'present' AND c."drainedAt" IS NULL
       GROUP BY GROUPING SETS ((c."inboundRemoteId"), ())`;
    const byInbound = new Map<string, number>();
    for (const r of rows) if (r.total === 0 && r.inboundRemoteId !== null) byInbound.set(r.inboundRemoteId, Number(r.clients));
    return { byInbound, users: Number(rows.find((r) => r.total === 1)?.users ?? 0) };
  }
}
