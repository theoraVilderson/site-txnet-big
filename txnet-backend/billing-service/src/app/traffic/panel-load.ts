import { ConfigProtocol, InboundAudience, PanelGroupMemberRole, Prisma } from '@prisma/client';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import type { InboundPlacementTarget } from './config-actions';
import { LIVE_CONFIG, MemberFacts, moveTargets, placementSettings } from './group-plan';
import { PLACEABLE_PANEL_FIELDS, placeableMember } from './panel-placeable';
import { sellingInbounds } from './selling-settings';

/**
 * A panel as placement reads it — its picks, its settings, and how full it is
 * (network `contract.inbounds.md`). One home for the purchase's fulfilment
 * (`GroupFulfilmentService`) and the move (`ConfigActionsService.move`,
 * ADR-0160 decision 10), so a move places exactly as a sale would.
 */

/** An inbound a buyer may be placed on (network `contract.inbounds.md` rule 2), before who sells it. */
export const PLACEABLE_INBOUND = { enabled: true, goneAt: null, protocol: { not: null } } satisfies Prisma.PanelInboundWhereInput;

/** What every group of the panel sells: `every_group`, picked and placeable (F-027-ep). */
export const EVERY_GROUP_INBOUND = { sold: true, ...PLACEABLE_INBOUND, audience: InboundAudience.every_group } satisfies Prisma.PanelInboundWhereInput;

/**
 * A member's panel as fulfilment reads it: its health, how it places, its cap,
 * and its `every_group` inbounds (network `contract.inbounds.md` rules 2, 3a) —
 * the unpicked, disabled, gone and listed ones are never loaded here.
 */
const MEMBER_PANEL_FIELDS = {
  ...PLACEABLE_PANEL_FIELDS,
  inboundPlacement: true,
  maxClients: true,
  inboundsPerBuyer: true,
  inbounds: { where: EVERY_GROUP_INBOUND, select: { remoteId: true, protocol: true, maxClients: true } },
} satisfies Prisma.PanelSelect;

/**
 * The member's own layer of the selling settings (F-027-cg; null = the
 * panel's) and its listed inbounds, sold beside the every-group ones
 * (F-027-ep), each with the group's share of it (F-027-eq).
 */
export const MEMBER_FIELDS = {
  panelId: true,
  role: true,
  inboundPlacement: true,
  maxClients: true,
  inboundsPerBuyer: true,
  inbounds: { select: { maxClients: true, inbound: { select: { remoteId: true, protocol: true, maxClients: true, enabled: true, goneAt: true } } } },
  // Inbounds a running release job is taking from this group: placed on by nobody new (F-027-es).
  releases: { select: { inboundRemoteId: true } },
  panel: { select: MEMBER_PANEL_FIELDS },
} satisfies Prisma.PanelGroupMemberSelect;

export type MemberRow = Prisma.PanelGroupMemberGetPayload<{ select: typeof MEMBER_FIELDS }>;

/**
 * A panel as a member of `groupId` — the membership's own layer when it is
 * one — else as a panel alone: its own layer, its `every_group` inbounds, and
 * no group's caps (a Grant sold without a group, ADR-0160). Null: no such panel.
 */
export async function panelAsMember(tx: Prisma.TransactionClient, panelId: string, groupId: string | null): Promise<MemberRow | null> {
  const member = groupId ? await tx.panelGroupMember.findUnique({ where: { groupId_panelId: { groupId, panelId } }, select: MEMBER_FIELDS }) : null;
  if (member) return member;
  const panel = await tx.panel.findUnique({ where: { id: panelId }, select: MEMBER_PANEL_FIELDS });
  return panel && { panelId, role: PanelGroupMemberRole.primary, inboundPlacement: null, maxClients: null, inboundsPerBuyer: null, inbounds: [], releases: [], panel };
}

/**
 * Each member's picked inbounds with how full they are (`contract.inbounds.md`
 * rule 5): every config and Grant, and `groupId`'s own among them, for the
 * group's shares (F-027-eq; none when `groupId` is null). The count is every
 * tenant's, so it is read on the cross-tenant pool — **after** a transaction
 * lock on each placeable panel, in panel-id order: a second placement on the
 * same panel (the sweep, the purchase consumer, a move) waits for this one to
 * commit and then counts its rows, so two buyers never take an inbound's last
 * seat together.
 */
export async function membersWithLoad(tx: Prisma.TransactionClient, crossTenant: CrossTenantPrismaService, groupId: string | null, members: MemberRow[]): Promise<MemberFacts[]> {
  const panelIds = members.filter(placeableMember).map((m) => m.panelId).sort();
  for (const id of panelIds) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`panel_inbound:${id}`}))`;
  type Load = { panelId: string; inboundRemoteId: string | null; total: number; clients: bigint; users: bigint; groupClients: bigint; groupUsers: bigint };
  const load = panelIds.length === 0 ? [] : await crossTenant.$queryRaw<Load[]>`
    SELECT c."panelId"::text AS "panelId", c."inboundRemoteId", GROUPING(c."inboundRemoteId")::int AS total,
           count(*) AS clients, count(DISTINCT c."grantId") AS users,
           count(*) FILTER (WHERE g."panelGroupId" = ${groupId}::uuid) AS "groupClients",
           count(DISTINCT c."grantId") FILTER (WHERE g."panelGroupId" = ${groupId}::uuid) AS "groupUsers"
      FROM "network"."config" c
      LEFT JOIN "entitlement"."grant" g ON g."id" = c."grantId"
     WHERE c."panelId" = ANY(${panelIds}::uuid[]) AND c."desiredRemote" = 'present' AND c."drainedAt" IS NULL
     GROUP BY GROUPING SETS ((c."panelId", c."inboundRemoteId"), (c."panelId"))`;
  // `total = 1` is the grouping set without the inbound: the panel's own row, its `users`.
  const panelRow = (id: string) => load.find((r) => r.panelId === id && r.total === 1);
  return members.map((m) => {
    const inboundRow = (remoteId: string) => load.find((r) => r.panelId === m.panelId && r.total === 0 && r.inboundRemoteId === remoteId);
    return {
      panelId: m.panelId,
      role: m.role,
      panel: {
        ...m.panel,
        ...placementSettings(m),
        users: Number(panelRow(m.panelId)?.users ?? 0),
        groupUsers: Number(panelRow(m.panelId)?.groupUsers ?? 0),
        // The membership's listed inbounds plus the every-group ones (F-027-ep).
        inbounds: sellingInbounds(m).map((i) => ({
          ...i,
          clients: Number(inboundRow(i.remoteId)?.clients ?? 0),
          groupClients: Number(inboundRow(i.remoteId)?.groupClients ?? 0),
        })),
      },
    };
  });
}

/**
 * What a move puts on its target (ADR-0160 decision 10). `null`: the target
 * sells the config's own protocol, so the new row keeps it and network's pass
 * takes the lowest `every_group` inbound of it (`desiredSQL`), as before.
 * Otherwise the inbounds a sale would be placed on there, under the same
 * panel lock; empty means nothing can be, and the caller refuses before
 * anything retires.
 */
export async function movePlacements(
  tx: Prisma.TransactionClient,
  crossTenant: CrossTenantPrismaService | null,
  input: { grantId: string; protocol: ConfigProtocol; toPanelId: string },
): Promise<InboundPlacementTarget[] | null> {
  const grant = await tx.grant.findUnique({ where: { id: input.grantId }, select: { panelGroupId: true } });
  const groupId = grant?.panelGroupId ?? null;
  const member = await panelAsMember(tx, input.toPanelId, groupId);
  if (!member) return [];
  if (member.panel.inbounds.some((i) => i.protocol === input.protocol)) return null;
  if (!crossTenant) throw new Error('a move that places on its target needs the cross-tenant pool; ConfigActionsService was built without it');
  const [facts] = await membersWithLoad(tx, crossTenant, groupId, [member]);
  const held = await tx.config.findMany({ where: { grantId: input.grantId, panelId: input.toPanelId, ...LIVE_CONFIG }, select: { inboundRemoteId: true } });
  return moveTargets(input.grantId, facts, held.map((c) => c.inboundRemoteId));
}
