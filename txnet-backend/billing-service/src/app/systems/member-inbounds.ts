import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { panelScopeOf, SystemsActor } from './panel-scope';
import { SystemsRefused } from './systems-read';

/**
 * An inbound another group holds or serves, named so the owner can move or
 * drain that group first. `remoteId` and `group` are null when a concurrent
 * assignment won the unique index: the inbound is taken, by whom is not known.
 */
export class InboundHeldElsewhere extends SystemsRefused {
  constructor(
    reason: 'inbound_assigned_elsewhere' | 'inbound_has_configs',
    readonly remoteId: string | null,
    readonly group: { id: string; name: string } | null,
    readonly configs: number | null = null,
  ) {
    super(reason);
  }
}

const byRemoteId = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/**
 * Which inbounds one group sells on one panel (F-027-ch, ADR-0090 decision 3,
 * network `contract.inbounds.md` rule 3a). An inbound assigned to a membership
 * leaves the panel's default pool; a membership with none sells the pool.
 *
 * The write is the whole set. Under the same transaction lock fulfilment takes
 * on the panel (`panel_inbound:<id>`), so no placement on the inbound lands
 * between the check and the write; the unique `(panelId, inboundRemoteId)`
 * holds "one group at most" against a second assignment racing this one.
 * Unassigning is always allowed and moves nobody (rule 6).
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

  async assign(actor: SystemsActor, groupId: string, panelId: string, remoteIds: string[]) {
    const scope = await panelScopeOf(this.prisma, actor);
    const group = await this.crossTenant.panelGroup.findFirst({ where: { id: groupId, tenantId: scope.tenantId }, select: { id: true } });
    if (!group) throw new SystemsRefused('not_found');
    const member = await this.crossTenant.panelGroupMember.findFirst({ where: { groupId: group.id, panelId }, select: { panelId: true } });
    if (!member) throw new SystemsRefused('member_not_found');

    try {
      await this.crossTenant.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`panel_inbound:${panelId}`}))`;
        if (remoteIds.length > 0) await this.admissible(tx, group.id, panelId, remoteIds);
        await tx.panelGroupMemberInbound.deleteMany({ where: { groupId: group.id, panelId, inboundRemoteId: { notIn: remoteIds } } });
        if (remoteIds.length > 0) {
          await tx.panelGroupMemberInbound.createMany({
            data: remoteIds.map((inboundRemoteId) => ({ groupId: group.id, panelId, inboundRemoteId })),
            skipDuplicates: true,
          });
        }
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new InboundHeldElsewhere('inbound_assigned_elsewhere', null, null);
      throw e;
    }
    this.logger.log(`panel ${panelId} inbounds in group ${group.id} set to [${remoteIds.join(', ')}] by ${actor.adminId}`);
    return { groupId: group.id, panelId, inbounds: [...remoteIds].sort(byRemoteId) };
  }

  /**
   * Each named inbound: one the read found (`inbound_not_found`) a buyer can be
   * placed on (`inbound_not_sellable`), held by no other membership
   * (`inbound_assigned_elsewhere`) and carrying no live config of another
   * group's Grants (`inbound_has_configs`, with the count) — those buyers would
   * stay on an inbound their group no longer sells. A client whose row does not
   * yet name its inbound may be on any of its protocol, so it counts on each.
   */
  private async admissible(tx: Prisma.TransactionClient, groupId: string, panelId: string, remoteIds: string[]) {
    const known = await tx.panelInbound.findMany({
      where: { panelId, remoteId: { in: remoteIds } },
      select: { remoteId: true, protocol: true, goneAt: true },
    });
    for (const remoteId of remoteIds) {
      const row = known.find((k) => k.remoteId === remoteId);
      if (!row) throw new SystemsRefused('inbound_not_found');
      if (row.protocol === null || row.goneAt !== null) throw new SystemsRefused('inbound_not_sellable');
    }

    const held = await tx.panelGroupMemberInbound.findMany({
      where: { panelId, groupId: { not: groupId }, inboundRemoteId: { in: remoteIds } },
      select: { inboundRemoteId: true, member: { select: { group: { select: { id: true, name: true } } } } },
    });
    if (held.length > 0) throw new InboundHeldElsewhere('inbound_assigned_elsewhere', held[0].inboundRemoteId, held[0].member.group);

    // A row placed before F-114-b names no inbound until the pass writes down the one its client is on
    // (network `contract.inbounds.md` rule 7); until then it counts against every inbound of its protocol.
    const live = await tx.$queryRaw<{ inboundRemoteId: string; configs: bigint }[]>`
      SELECT i."remoteId" AS "inboundRemoteId", count(*) AS configs
        FROM "network"."panel_inbound" i
        JOIN "network"."config" c ON c."panelId" = i."panelId"
             AND (c."inboundRemoteId" = i."remoteId"
                  OR (c."inboundRemoteId" IS NULL AND c."remoteId" IS NOT NULL AND c."protocol" = i."protocol"))
        JOIN "entitlement"."grant" g ON g."id" = c."grantId"
        JOIN "catalog"."product_variant" v ON v."id" = g."variantId"
       WHERE i."panelId" = ${panelId}::uuid AND i."remoteId" = ANY(${remoteIds}::text[])
         AND c."desiredRemote" = 'present' AND c."drainedAt" IS NULL
         AND v."panelGroupId" IS DISTINCT FROM ${groupId}::uuid
       GROUP BY i."remoteId"
       ORDER BY i."remoteId"`;
    if (live.length > 0) throw new InboundHeldElsewhere('inbound_has_configs', live[0].inboundRemoteId, null, Number(live[0].configs));
  }
}
