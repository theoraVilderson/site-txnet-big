import { Injectable, Logger } from '@nestjs/common';
import { InboundAudience, Prisma } from '@prisma/client';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { byRemoteId } from '../traffic/selling-settings';
import { panelScopeOf, SystemsActor } from './panel-scope';
import { SystemsRefused } from './systems-read';

/**
 * An inbound a group would stop selling while its Grants' configs are on it
 * (ADR-0127 decision 6): the first such group and its count, so the owner can
 * move or empty them first (F-027-es names every group).
 */
export class InboundHeldElsewhere extends SystemsRefused {
  constructor(
    readonly remoteId: string,
    readonly group: { id: string; name: string },
    readonly configs: number,
  ) {
    super('inbound_has_configs');
  }
}

/** Who sells one inbound: every group of its panel, or the groups listed. */
export type InboundAudienceInput = { audience: typeof InboundAudience.every_group } | { audience: typeof InboundAudience.listed; groups: string[] };

/** One inbound a set of groups stops selling. */
type Loss = { remoteId: string; groupIds: string[] };

/**
 * Who sells an inbound (F-027-ep, ADR-0127 decision 1, network
 * `contract.inbounds.md` rule 3a): `every_group` — every membership of the
 * panel, while `sold` — or `listed`, exactly the memberships listing it. Two
 * writes reach it: one membership's whole set of listings (`assign`), and one
 * inbound's audience (`setAudience`).
 *
 * Both run under the transaction lock fulfilment takes on the panel
 * (`panel_inbound:<id>`), so no placement lands between the check and the
 * write. Adding a seller is always allowed; a group that would **lose** an
 * inbound its Grants' live configs are on is 409 `inbound_has_configs`
 * (decision 6) — releasing one is the admin's choice, never a side effect.
 * The audience is written before a listing and after the last one goes, as
 * the triggers require.
 *
 * On the cross-tenant pool, as `PanelGroupsService`: a platform group's rows
 * carry `tenantId` null. Every query carries the scope.
 */
@Injectable()
export class MemberInboundsService {
  private readonly logger = new Logger(MemberInboundsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
  ) {}

  /**
   * The membership's listings become exactly `remoteIds`. A named
   * `every_group` inbound becomes `listed` to this group alone, so every other
   * member loses it; a listing left out is lost by this group. An inbound
   * whose last listing goes stays `listed`, to nobody: giving it back to every
   * group is `setAudience`, never a side effect.
   */
  async assign(actor: SystemsActor, groupId: string, panelId: string, remoteIds: string[]) {
    const scope = await panelScopeOf(this.prisma, actor);
    const group = await this.crossTenant.panelGroup.findFirst({ where: { id: groupId, tenantId: scope.tenantId }, select: { id: true } });
    if (!group) throw new SystemsRefused('not_found');
    const member = await this.crossTenant.panelGroupMember.findFirst({ where: { groupId: group.id, panelId }, select: { panelId: true } });
    if (!member) throw new SystemsRefused('member_not_found');

    await this.crossTenant.$transaction(async (tx) => {
      await this.lock(tx, panelId);
      const named = await this.sellable(tx, panelId, remoteIds);
      const held = await tx.panelGroupMemberInbound.findMany({ where: { panelId, groupId: group.id }, select: { inboundRemoteId: true } });
      const dropped = held.map((h) => h.inboundRemoteId).filter((r) => !remoteIds.includes(r));
      const widened = named.filter((i) => i.audience === InboundAudience.every_group).map((i) => i.remoteId);
      const others = (await this.memberGroups(tx, panelId)).filter((g) => g !== group.id);
      await this.refuseLosses(tx, panelId, [
        ...widened.map((remoteId) => ({ remoteId, groupIds: others })),
        ...dropped.map((remoteId) => ({ remoteId, groupIds: [group.id] })),
      ]);

      if (widened.length > 0) {
        await tx.panelInbound.updateMany({ where: { panelId, remoteId: { in: widened } }, data: { audience: InboundAudience.listed } });
      }
      await tx.panelGroupMemberInbound.deleteMany({ where: { panelId, groupId: group.id, inboundRemoteId: { notIn: remoteIds } } });
      if (remoteIds.length > 0) {
        await tx.panelGroupMemberInbound.createMany({ data: remoteIds.map((inboundRemoteId) => ({ groupId: group.id, panelId, inboundRemoteId })), skipDuplicates: true });
      }
    });
    this.logger.log(`panel ${panelId} inbounds listed to group ${group.id} set to [${remoteIds.join(', ')}] by ${actor.adminId}`);
    return { groupId: group.id, panelId, inbounds: [...remoteIds].sort(byRemoteId) };
  }

  /**
   * One inbound's sellers: every group of the panel, or exactly `groups` —
   * each a member of this panel. A group in the old set and not the new one
   * loses it; `every_group` takes it from nobody.
   */
  async setAudience(actor: SystemsActor, panelId: string, remoteId: string, input: InboundAudienceInput) {
    const scope = await panelScopeOf(this.prisma, actor);
    const panel = await this.crossTenant.panel.findFirst({ where: { id: panelId, ...scope }, select: { id: true } });
    if (!panel) throw new SystemsRefused('panel_not_found');
    const groups = input.audience === InboundAudience.listed ? [...new Set(input.groups)].sort() : [];

    await this.crossTenant.$transaction(async (tx) => {
      await this.lock(tx, panel.id);
      const inbound = await tx.panelInbound.findUnique({ where: { panelId_remoteId: { panelId: panel.id, remoteId } }, select: { audience: true } });
      if (!inbound) throw new SystemsRefused('inbound_not_found');
      if (input.audience === InboundAudience.every_group) {
        await tx.panelGroupMemberInbound.deleteMany({ where: { panelId: panel.id, inboundRemoteId: remoteId } });
        await tx.panelInbound.updateMany({ where: { panelId: panel.id, remoteId }, data: { audience: InboundAudience.every_group } });
        return;
      }

      await this.sellable(tx, panel.id, [remoteId]);
      const members = await this.memberGroups(tx, panel.id);
      if (groups.some((g) => !members.includes(g))) throw new SystemsRefused('member_not_found');
      const before =
        inbound.audience === InboundAudience.every_group
          ? members
          : (await tx.panelGroupMemberInbound.findMany({ where: { panelId: panel.id, inboundRemoteId: remoteId }, select: { groupId: true } })).map((l) => l.groupId);
      await this.refuseLosses(tx, panel.id, [{ remoteId, groupIds: before.filter((g) => !groups.includes(g)) }]);

      await tx.panelInbound.updateMany({ where: { panelId: panel.id, remoteId }, data: { audience: InboundAudience.listed } });
      await tx.panelGroupMemberInbound.deleteMany({ where: { panelId: panel.id, inboundRemoteId: remoteId, groupId: { notIn: groups } } });
      if (groups.length > 0) {
        await tx.panelGroupMemberInbound.createMany({ data: groups.map((groupId) => ({ groupId, panelId: panel.id, inboundRemoteId: remoteId })), skipDuplicates: true });
      }
    });
    this.logger.log(`panel ${panel.id} inbound ${remoteId} sold by ${input.audience === InboundAudience.listed ? `[${groups.join(', ')}]` : 'every group'}, by ${actor.adminId}`);
    return { panelId: panel.id, remoteId, audience: input.audience, groups };
  }

  /**
   * The group's share of one inbound it lists (F-027-eq, ADR-0127 decision 3):
   * the most of its Grants placed there, null = none. Only a listing has one —
   * an `every_group` inbound, or one this group does not list, is
   * `listing_not_found`. A share below what is placed moves nobody: it stops
   * new placements, as any cap (network `contract.inbounds.md` rule 5). Under
   * the panel's lock, so a fulfilment counts against one value or the other.
   */
  async setShare(actor: SystemsActor, groupId: string, panelId: string, remoteId: string, maxClients: number | null) {
    const scope = await panelScopeOf(this.prisma, actor);
    const group = await this.crossTenant.panelGroup.findFirst({ where: { id: groupId, tenantId: scope.tenantId }, select: { id: true } });
    if (!group) throw new SystemsRefused('not_found');
    const set = await this.crossTenant.$transaction(async (tx) => {
      await this.lock(tx, panelId);
      return tx.panelGroupMemberInbound.updateMany({ where: { groupId: group.id, panelId, inboundRemoteId: remoteId }, data: { maxClients } });
    });
    if (set.count === 0) throw new SystemsRefused('listing_not_found');
    this.logger.log(`panel ${panelId} inbound ${remoteId}: group ${group.id}'s share set to ${maxClients ?? 'none'} by ${actor.adminId}`);
    return { groupId: group.id, panelId, remoteId, maxClients };
  }

  private lock(tx: Prisma.TransactionClient, panelId: string) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`panel_inbound:${panelId}`}))`;
  }

  /** Each named inbound, as one the read found (`inbound_not_found`) and a buyer can be placed on (`inbound_not_sellable`). */
  private async sellable(tx: Prisma.TransactionClient, panelId: string, remoteIds: string[]) {
    if (remoteIds.length === 0) return [];
    const known = await tx.panelInbound.findMany({
      where: { panelId, remoteId: { in: remoteIds } },
      select: { remoteId: true, protocol: true, goneAt: true, audience: true },
    });
    return remoteIds.map((remoteId) => {
      const row = known.find((k) => k.remoteId === remoteId);
      if (!row) throw new SystemsRefused('inbound_not_found');
      if (row.protocol === null || row.goneAt !== null) throw new SystemsRefused('inbound_not_sellable');
      return row;
    });
  }

  private async memberGroups(tx: Prisma.TransactionClient, panelId: string): Promise<string[]> {
    return (await tx.panelGroupMember.findMany({ where: { panelId }, select: { groupId: true } })).map((m) => m.groupId).sort();
  }

  /**
   * Refuses the first (inbound, group) pair whose group's Grants hold a live
   * config (`present`, not drained) there — those buyers would stay on an
   * inbound their group no longer sells. A row placed before F-114-b names no
   * inbound until the pass writes down the one its client is on (network
   * `contract.inbounds.md` rule 7); until then it counts on every inbound of
   * its protocol. One query for every pair.
   */
  private async refuseLosses(tx: Prisma.TransactionClient, panelId: string, losses: Loss[]) {
    const pairs = losses.flatMap((l) => l.groupIds.map((groupId) => ({ remoteId: l.remoteId, groupId })));
    if (pairs.length === 0) return;
    const remoteIds = pairs.map((p) => p.remoteId);
    const groupIds = pairs.map((p) => p.groupId);
    const live = await tx.$queryRaw<{ remoteId: string; groupId: string; groupName: string; configs: bigint }[]>`
      SELECT i."remoteId", pg."id"::text AS "groupId", pg."name" AS "groupName", count(*) AS configs
        FROM unnest(${remoteIds}::text[], ${groupIds}::uuid[]) AS l("remoteId", "groupId")
        JOIN "network"."panel_inbound" i ON i."panelId" = ${panelId}::uuid AND i."remoteId" = l."remoteId"
        JOIN "network"."panel_group" pg ON pg."id" = l."groupId"
        JOIN "network"."config" c ON c."panelId" = i."panelId"
             AND (c."inboundRemoteId" = i."remoteId"
                  OR (c."inboundRemoteId" IS NULL AND c."remoteId" IS NOT NULL AND c."protocol" = i."protocol"))
        JOIN "entitlement"."grant" g ON g."id" = c."grantId" AND g."panelGroupId" = l."groupId"
       WHERE c."desiredRemote" = 'present' AND c."drainedAt" IS NULL
       GROUP BY i."remoteId", pg."id", pg."name"
       ORDER BY i."remoteId", pg."name"`;
    if (live.length > 0) throw new InboundHeldElsewhere(live[0].remoteId, { id: live[0].groupId, name: live[0].groupName }, Number(live[0].configs));
  }
}
