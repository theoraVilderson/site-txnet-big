import { Injectable, Logger } from '@nestjs/common';
import { PanelGroupMemberRole, Prisma } from '@prisma/client';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { DRAIN_TTL_MULTIPLE } from '../traffic/group-drain';
import { effectiveSellingSettings, SellingLayerValues } from '../traffic/selling-settings';
import { panelScopeOf, SystemsActor } from './panel-scope';
import { SystemsRefused } from './systems-read';

export type PanelGroupInput = {
  name?: string;
  minHealthyPanels?: number;
  subscriptionTtlSeconds?: number;
};

/** A member's own layer of the selling settings (F-027-cg); null clears one, absent leaves it. */
export type MemberSellingInput = SellingLayerValues;

export type PanelGroupMemberInput = MemberSellingInput & { panelId: string };

/** The panel's layer, beneath each member's. */
const PANEL_SELLING_FIELDS = { inboundPlacement: true, maxClients: true, priority: true, weight: true } satisfies Prisma.PanelSelect;

/** A member's panel, field by field: `panelApiCredentials` is on the same row. */
const MEMBER_FIELDS = {
  groupId: true,
  panelId: true,
  inboundPlacement: true,
  maxClients: true,
  priority: true,
  weight: true,
  role: true,
  drainingSince: true,
  createdAt: true,
  // The inbounds it sells instead of the pool (F-027-ch); none = the pool.
  inbounds: { select: { inboundRemoteId: true } },
  panel: { select: { name: true, panelState: true, reviewState: true, lastHealthyAt: true, ...PANEL_SELLING_FIELDS } },
} satisfies Prisma.PanelGroupMemberSelect;

const GROUP_FIELDS = {
  id: true,
  name: true,
  strategy: true,
  minHealthyPanels: true,
  subscriptionTtlSeconds: true,
  createdAt: true,
  updatedAt: true,
  // Ordered by effective priority in `wireGroup`: a member's own may be unset.
  members: { select: MEMBER_FIELDS, orderBy: { createdAt: 'asc' } },
  _count: { select: { variants: true } },
} satisfies Prisma.PanelGroupSelect;

type MemberRow = Prisma.PanelGroupMemberGetPayload<{ select: typeof MEMBER_FIELDS }>;
type GroupRow = Prisma.PanelGroupGetPayload<{ select: typeof GROUP_FIELDS }>;

/**
 * Panel groups on the systems surface (F-027-bw, network `contract.groups.md`):
 * where a `network_access` variant's Grants are placed. The owner lists,
 * creates and edits the **platform's** groups, adds and removes members, and
 * drains one. Tenant groups are a later row: the scope below is where they
 * would open.
 *
 * Desired state only, as everything on this surface: fulfilment places on the
 * group as it reads it on the next tick, and the drain sweep takes it from
 * `role = drain` (rules 11, 13-15). Every group is `mirror`; nothing here sets
 * a strategy that has no fulfilment (rule 7).
 *
 * **On the cross-tenant pool.** `panel_group`'s `tenant_isolation` policy has
 * `WITH CHECK ("tenantId" = current_tenant_id())`, which a platform row
 * (`tenantId` null) never passes, so the app pool can read these rows but not
 * write them. Every query carries the scope's `tenantId`, so the wider policy
 * reaches no tenant's group; the triggers (`panel_group_member_fits`) still
 * hold a platform group to platform panels.
 */
@Injectable()
export class PanelGroupsService {
  private readonly logger = new Logger(PanelGroupsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
  ) {}

  /** Every group in scope, by name, with its members and their panels' health. */
  async groups(actor: SystemsActor) {
    const scope = await this.groupScopeOf(actor);
    const rows = await this.crossTenant.panelGroup.findMany({ where: scope, select: GROUP_FIELDS, orderBy: { name: 'asc' } });
    return rows.map(wireGroup);
  }

  async create(actor: SystemsActor, input: PanelGroupInput & { name: string }) {
    const scope = await this.groupScopeOf(actor);
    const row = await this.crossTenant.panelGroup.create({ data: { ...input, tenantId: scope.tenantId }, select: GROUP_FIELDS });
    this.logger.log(`panel group ${row.id} created by ${actor.adminId}`);
    return wireGroup(row);
  }

  /**
   * A change reaches what is placed next; configs already placed keep theirs
   * (rule 9). Which inbounds, and so which protocols, is the panels' own pick
   * (F-114-b, `contract.inbounds.md`), not the group's.
   */
  async update(actor: SystemsActor, groupId: string, input: PanelGroupInput) {
    const scope = await this.groupScopeOf(actor);
    const { count } = await this.crossTenant.panelGroup.updateMany({ where: { id: groupId, ...scope }, data: input });
    if (count === 0) throw new SystemsRefused('not_found');
    this.logger.log(`panel group ${groupId} edited by ${actor.adminId}`);
    return wireGroup(await this.groupInScope(scope, groupId));
  }

  /** A panel in scope, once. It enters as `primary`; fulfilment places on it once it is accepted and healthy. */
  async addMember(actor: SystemsActor, groupId: string, input: PanelGroupMemberInput) {
    const [scope, panelScope] = await this.scopes(actor);
    const group = await this.groupInScope(scope, groupId);
    // An archived panel (F-027-bz) takes no group; the trigger `panel_group_member_panel_not_retired` holds it too.
    const panel = await this.prisma.panel.findFirst({ where: { id: input.panelId, ...panelScope, retiredAt: null }, select: { id: true } });
    if (!panel) throw new SystemsRefused('panel_not_found');

    try {
      const row = await this.crossTenant.panelGroupMember.create({
        data: { groupId: group.id, panelId: panel.id, tenantId: scope.tenantId, ...sellingData(input) },
        select: MEMBER_FIELDS,
      });
      this.logger.log(`panel ${panel.id} added to group ${group.id} by ${actor.adminId}`);
      return wireMember(row);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new SystemsRefused('already_member');
      throw e;
    }
  }

  /**
   * A member's own selling settings (F-027-cg, ADR-0090 decision 2): set one
   * to override its panel for this group, null to inherit again. Server facts
   * never reach here (the schema is `.strict()`). Like every group change, it
   * reaches what is placed next; placed configs keep theirs (rule 22).
   */
  async updateMember(actor: SystemsActor, groupId: string, panelId: string, input: MemberSellingInput) {
    const scope = await this.groupScopeOf(actor);
    const group = await this.groupInScope(scope, groupId);
    const where = { groupId: group.id, panelId };
    const { count } = await this.crossTenant.panelGroupMember.updateMany({ where, data: sellingData(input) });
    if (count === 0) throw new SystemsRefused('member_not_found');
    const member = await this.crossTenant.panelGroupMember.findFirst({ where, select: MEMBER_FIELDS });
    if (!member) throw new SystemsRefused('member_not_found');
    this.logger.log(`panel ${panelId} selling settings in group ${group.id} edited by ${actor.adminId}`);
    return wireMember(member);
  }

  /**
   * Removing a member that still carries a live config of the group's Grants
   * would leave those configs outside every drain, served for good. So the
   * `DELETE` itself holds the drain sweep's condition (rule 15, less the role),
   * and a member it does not remove is `member_has_configs`: drain it instead.
   */
  async removeMember(actor: SystemsActor, groupId: string, panelId: string) {
    const scope = await this.groupScopeOf(actor);
    const group = await this.groupInScope(scope, groupId);

    const removed = await this.crossTenant.$executeRaw`DELETE FROM "network"."panel_group_member" m
       WHERE m."groupId" = ${group.id}::uuid AND m."panelId" = ${panelId}::uuid
         AND NOT EXISTS (
               SELECT 1 FROM "network"."config" c
                 JOIN "entitlement"."grant" g ON g."id" = c."grantId"
                 JOIN "catalog"."product_variant" v ON v."id" = g."variantId"
                WHERE c."panelId" = m."panelId" AND v."panelGroupId" = m."groupId" AND c."status" <> 'retired')`;
    if (removed === 0) {
      const member = await this.crossTenant.panelGroupMember.findFirst({ where: { groupId: group.id, panelId }, select: { panelId: true } });
      throw new SystemsRefused(member ? 'member_has_configs' : 'member_not_found');
    }
    this.logger.log(`panel ${panelId} removed from group ${group.id} by ${actor.adminId}`);
    return { groupId: group.id, panelId, removed: true as const };
  }

  /**
   * Set a member to `drain` (rules 13-15): it takes no new Grants, `/sub`
   * stops serving its lines where the Grant has another, and the sweep
   * retires its configs and then the member. The clock is the database's
   * (`panel_group_member_drain_clock`); a second drain is `already_draining`
   * and never restarts it. `waitSeconds` is the least the sweep will wait from
   * `drainingSince` — longer for a Grant whose replacement is served later.
   */
  async drain(actor: SystemsActor, groupId: string, panelId: string) {
    const scope = await this.groupScopeOf(actor);
    const group = await this.groupInScope(scope, groupId);

    const where = { groupId: group.id, panelId };
    const { count } = await this.crossTenant.panelGroupMember.updateMany({
      where: { ...where, role: { not: PanelGroupMemberRole.drain } },
      data: { role: PanelGroupMemberRole.drain },
    });
    const member = await this.crossTenant.panelGroupMember.findFirst({ where, select: MEMBER_FIELDS });
    if (!member) throw new SystemsRefused('member_not_found');
    if (count === 0) throw new SystemsRefused('already_draining');

    this.logger.log(`panel ${panelId} draining from group ${group.id}, by ${actor.adminId}`);
    return { ...wireMember(member), waitSeconds: DRAIN_TTL_MULTIPLE * group.subscriptionTtlSeconds };
  }

  /**
   * Delete a group (F-027-ca). One with members is `group_has_members` — remove
   * or drain them first — and one a variant names is `group_in_use`: the FK is
   * `RESTRICT` (groups rule 4), and the variant would be left with nowhere to
   * deliver. The delete itself meets both keys, so a member or a variant added
   * meanwhile refuses it too.
   */
  async remove(actor: SystemsActor, groupId: string) {
    const scope = await this.groupScopeOf(actor);
    const refusal = (g: GroupRow) => (g.members.length > 0 ? 'group_has_members' : g._count.variants > 0 ? 'group_in_use' : null);
    const reason = refusal(await this.groupInScope(scope, groupId));
    if (reason) throw new SystemsRefused(reason);

    try {
      const { count } = await this.crossTenant.panelGroup.deleteMany({ where: { id: groupId, ...scope } });
      if (count === 0) throw new SystemsRefused('not_found');
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003')) throw e;
      throw new SystemsRefused(refusal(await this.groupInScope(scope, groupId)) ?? 'group_in_use');
    }
    this.logger.log(`panel group ${groupId} deleted by ${actor.adminId}`);
    return { id: groupId, removed: true as const };
  }

  /** The groups an actor may manage: the platform's, for the owner (ADR-0080 decision 2). */
  private async groupScopeOf(actor: SystemsActor) {
    return (await this.scopes(actor))[0];
  }

  private async scopes(actor: SystemsActor) {
    const panelScope = await panelScopeOf(this.prisma, actor);
    return [{ tenantId: panelScope.tenantId }, panelScope] as const;
  }

  private async groupInScope(scope: { tenantId: string | null }, groupId: string) {
    const group = await this.crossTenant.panelGroup.findFirst({ where: { id: groupId, ...scope }, select: GROUP_FIELDS });
    if (!group) throw new SystemsRefused('not_found');
    return group;
  }
}

/** Only the keys the body named: absent leaves a layer's value, null clears it. */
function sellingData(input: MemberSellingInput) {
  const { inboundPlacement, maxClients, priority, weight } = input;
  return Object.fromEntries(Object.entries({ inboundPlacement, maxClients, priority, weight }).filter(([, v]) => v !== undefined)) as MemberSellingInput;
}

/**
 * The member's own values as stored (null = inherited), and `effective`:
 * each setting's value for this group and the layer it came from. `inbounds`
 * are the ones assigned to it (F-027-ch); `[]` = it sells the panel's pool.
 */
function wireMember({ panel, inbounds, ...m }: MemberRow) {
  return {
    ...m,
    inbounds: inbounds.map((i) => i.inboundRemoteId).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
    panelName: panel.name,
    panelState: panel.panelState,
    reviewState: panel.reviewState,
    lastHealthyAt: panel.lastHealthyAt,
    effective: effectiveSellingSettings(m, panel),
  };
}

function wireGroup({ members, _count, ...g }: GroupRow) {
  const wired = members.map(wireMember).sort((a, b) => a.effective.priority.value - b.effective.priority.value);
  return { ...g, variantCount: _count.variants, members: wired };
}
