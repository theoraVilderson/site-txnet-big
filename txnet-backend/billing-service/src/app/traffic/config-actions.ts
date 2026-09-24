import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ActorType, ConfigProtocol, ConfigStatus, DesiredRemote, EnforcementState, GrantStatus, Prisma } from '@prisma/client';

import { CeilingAllocatorService } from './ceiling-allocator';

/**
 * The second matching key (network F-027-aa): written into the client's label
 * on every panel family that has one, so a rename on the panel does not orphan
 * the config's usage. Ours and global (`@unique`, invariant 17), and random
 * rather than derived from the `uuid`, because a regenerate rotates the
 * credential and the tag has to survive it. A move is a new row and a new tag.
 */
const claimTag = (): string => `txn-${randomUUID().replace(/-/g, '')}`;

/** Who asked. `actorId` is the user, the admin, or the job's own id for `system`. */
export type ConfigActor = { actorType: ActorType; actorId: string };

/**
 * Why an action wrote nothing — declared once as a tuple (C-09), because the
 * panel names each to the user (F-027-ac) and its spec reads this list.
 */
export const CONFIG_ACTION_REJECTIONS = [
  'grant_not_found',
  'grant_not_active',
  'panel_not_found',
  'config_not_found',
  'config_retired',
  'regenerate_limit_reached',
  'config_changed',
  'same_panel',
  'actor_not_allowed',
] as const;
export type ConfigActionRejection = (typeof CONFIG_ACTION_REJECTIONS)[number];

export class ConfigActionRefused extends Error {
  constructor(
    readonly reason: ConfigActionRejection,
    detail = '',
  ) {
    super(`config action refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'ConfigActionRefused';
  }
}

type ConfigRow = {
  id: string;
  tenantId: string;
  userId: string;
  grantId: string;
  panelId: string;
  protocol: ConfigProtocol;
  status: ConfigStatus;
  regenerateUsedCount: number;
  maxRegenerateCount: number;
};

/**
 * Every action on a config — provision, regenerate, enable, disable, move,
 * retire — as a write to its **desired state** and nothing else (F-027-z,
 * ADR-0075). None of these calls a panel: `network-service`'s convergence pass
 * (`internal/converge/provision.go`) is the only code that does, and it
 * compares the desired state as it is when it looks. A change made twice, or
 * undone before the pass arrives, is therefore simply what the pass finds.
 *
 * Each runs in the caller's transaction, writes one `config_action_log` row,
 * and rebalances the Grant's ceilings in the same transaction: a disabled or
 * retired config leaves the split, and a new one is given its share before
 * the pass creates its client — a client is never created without one.
 *
 * **Retired is not purged.** Both write `desiredRemote = absent`; only
 * `status = retired` (CHECK `config_retired_is_absent`) tells the top-up that
 * revives a Grant (`entitlement/purge.ts`) to leave the row alone. The row is
 * never deleted and `remoteId` is never cleared here — the pass clears it when
 * the panel is read without the client (network invariant 15).
 *
 * **A move is a new row.** The counter cursor, the traffic history and
 * `(panelId, remoteId)` all belong to one panel, so the old row retires and a
 * new one is provisioned on the target with a fresh `uuid` — the old client
 * holds the old one until it is deleted, and `uuid` is unique system-wide.
 */
@Injectable()
export class ConfigActionsService {
  constructor(private readonly allocator: CeilingAllocatorService) {}

  async provision(
    tx: Prisma.TransactionClient,
    input: { grantId: string; panelId: string; protocol: ConfigProtocol | `${ConfigProtocol}`; actor: ConfigActor },
  ): Promise<{ configId: string; uuid: string }> {
    const grant = await tx.grant.findUnique({ where: { id: input.grantId }, select: { id: true, tenantId: true, userId: true, status: true } });
    if (!grant || !this.owns(input.actor, grant.userId)) throw new ConfigActionRefused('grant_not_found', input.grantId);
    if (grant.status !== GrantStatus.active) throw new ConfigActionRefused('grant_not_active', grant.status);
    await this.panelFor(tx, input.panelId, grant.tenantId);

    const made = await this.create(tx, grant, input.panelId, input.protocol as ConfigProtocol, null, input.actor);
    await this.allocator.rebalance(tx, { grantId: grant.id });
    return made;
  }

  /**
   * A panel group's placement (F-027-bl): one row per panel, all under one
   * `credentialGroupId`, and one rebalance for the lot. The caller is
   * `GroupFulfilmentService`, which chose the panels from the group's members
   * — the member triggers already held their tenancy (network
   * `contract.groups.md` rule 2), so no panel is re-checked here.
   *
   * **A `pending` Grant is provisioned**, unlike `provision`: a group's Grant
   * activates on what its panels confirm, so its configs exist first. `/sub`
   * serves nothing of a Grant that is not `active` (F-609).
   */
  async provisionForGroup(
    tx: Prisma.TransactionClient,
    input: { grantId: string; panelIds: string[]; protocol: ConfigProtocol; credentialGroupId: string; actor: ConfigActor },
  ): Promise<{ configId: string; uuid: string }[]> {
    const grant = await tx.grant.findUnique({ where: { id: input.grantId }, select: { id: true, tenantId: true, userId: true, status: true } });
    if (!grant) throw new ConfigActionRefused('grant_not_found', input.grantId);
    if (grant.status !== GrantStatus.active && grant.status !== GrantStatus.pending) throw new ConfigActionRefused('grant_not_active', grant.status);
    if (input.panelIds.length === 0) return [];

    const made: { configId: string; uuid: string }[] = [];
    for (const panelId of input.panelIds) made.push(await this.create(tx, grant, panelId, input.protocol, input.credentialGroupId, input.actor));
    await this.allocator.rebalance(tx, { grantId: grant.id });
    return made;
  }

  private async create(
    tx: Prisma.TransactionClient,
    grant: { id: string; tenantId: string; userId: string },
    panelId: string,
    protocol: ConfigProtocol,
    credentialGroupId: string | null,
    actor: ConfigActor,
  ): Promise<{ configId: string; uuid: string }> {
    const uuid = randomUUID();
    const config = await tx.config.create({
      data: {
        tenantId: grant.tenantId,
        userId: grant.userId,
        grantId: grant.id,
        panelId,
        protocol,
        uuid,
        claimTag: claimTag(),
        credentialGroupId,
        desiredRemote: DesiredRemote.present,
        desiredEnabled: true,
        enforcementState: EnforcementState.pending,
      },
      select: { id: true },
    });
    await this.log(tx, config.id, actor, 'provision');
    return { configId: config.id, uuid };
  }

  /**
   * A new credential on the same row. The limit is held in the write's own
   * `where` on the count it read, so two regenerates racing each other cannot
   * both pass (network invariant 4); the loser is refused, never applied.
   */
  async regenerate(tx: Prisma.TransactionClient, input: { configId: string; actor: ConfigActor }): Promise<{ uuid: string; regenerateUsedCount: number }> {
    const config = await this.live(tx, input.configId, input.actor);
    if (config.regenerateUsedCount >= config.maxRegenerateCount) {
      throw new ConfigActionRefused('regenerate_limit_reached', `${config.regenerateUsedCount}/${config.maxRegenerateCount}`);
    }
    const uuid = randomUUID();
    const moved = await tx.config.updateMany({
      where: { id: config.id, status: config.status, regenerateUsedCount: config.regenerateUsedCount },
      data: { uuid, regenerateUsedCount: { increment: 1 }, enforcementState: EnforcementState.pending },
    });
    if (moved.count === 0) throw new ConfigActionRefused('config_changed', config.id);
    await this.log(tx, config.id, input.actor, 'regenerate');
    return { uuid, regenerateUsedCount: config.regenerateUsedCount + 1 };
  }

  /**
   * An operator's switch, so a user is refused: a user who wants a config gone
   * retires it. A user-level pause would need a status of its own, or the
   * top-up that revives a Grant would silently undo it.
   */
  async disable(tx: Prisma.TransactionClient, input: { configId: string; reason: string; actor: ConfigActor }): Promise<void> {
    if (input.actor.actorType === ActorType.user) throw new ConfigActionRefused('actor_not_allowed', 'disable');
    const config = await this.live(tx, input.configId, input.actor);
    const status = input.actor.actorType === ActorType.admin ? ConfigStatus.disabled_by_admin : ConfigStatus.disabled_by_system;
    await this.write(tx, config, { status, disabledReason: input.reason, desiredEnabled: false });
    await this.log(tx, config.id, input.actor, 'disable');
    await this.allocator.rebalance(tx, { grantId: config.grantId });
  }

  /** Back to `active`. Served again only while the Grant is: a suspended Grant's configs wait for its revive. */
  async enable(tx: Prisma.TransactionClient, input: { configId: string; actor: ConfigActor }): Promise<void> {
    if (input.actor.actorType === ActorType.user) throw new ConfigActionRefused('actor_not_allowed', 'enable');
    const config = await this.live(tx, input.configId, input.actor);
    const grant = await tx.grant.findUnique({ where: { id: config.grantId }, select: { status: true } });
    await this.write(tx, config, { status: ConfigStatus.active, disabledReason: null, desiredEnabled: grant?.status === GrantStatus.active });
    await this.log(tx, config.id, input.actor, 'enable');
    await this.allocator.rebalance(tx, { grantId: config.grantId });
  }

  /** Delete, as desired state: the row stays, the pass deletes the client. */
  async retire(tx: Prisma.TransactionClient, input: { configId: string; actor: ConfigActor }): Promise<void> {
    const config = await this.live(tx, input.configId, input.actor);
    await this.retireRow(tx, config, input.actor, 'retire');
    await this.allocator.rebalance(tx, { grantId: config.grantId });
  }

  /**
   * A drain's retire (network `contract.groups.md` rules 14, 9): a retire
   * marked `drainedAt`, so the row does not hold its panel if the member is
   * re-added to the group. Only the drain sweep calls it.
   */
  async drain(tx: Prisma.TransactionClient, input: { configId: string; actor: ConfigActor }): Promise<void> {
    const config = await this.live(tx, input.configId, input.actor);
    await this.retireRow(tx, config, input.actor, 'drain', { drainedAt: new Date() });
    await this.allocator.rebalance(tx, { grantId: config.grantId });
  }

  async move(
    tx: Prisma.TransactionClient,
    input: { configId: string; toPanelId: string; actor: ConfigActor },
  ): Promise<{ configId: string; uuid: string; retiredConfigId: string }> {
    const config = await this.live(tx, input.configId, input.actor);
    if (config.panelId === input.toPanelId) throw new ConfigActionRefused('same_panel', input.toPanelId);
    await this.panelFor(tx, input.toPanelId, config.tenantId);

    await this.retireRow(tx, config, input.actor, 'move_out');
    // Provisioned for the Grant's owner whoever asked: the new row is theirs,
    // and `provision` rebalances once for both rows.
    const made = await this.provision(tx, {
      grantId: config.grantId,
      panelId: input.toPanelId,
      protocol: config.protocol,
      actor: input.actor,
    });
    return { ...made, retiredConfigId: config.id };
  }

  private async retireRow(tx: Prisma.TransactionClient, config: ConfigRow, actor: ConfigActor, action: string, extra: Prisma.ConfigUpdateManyMutationInput = {}) {
    await this.write(tx, config, {
      ...extra,
      status: ConfigStatus.retired,
      desiredRemote: DesiredRemote.absent,
      desiredEnabled: false,
    });
    await this.log(tx, config.id, actor, action);
  }

  /**
   * One desired-state write, conditional on the status it read: a row another
   * action moved meanwhile is refused rather than overwritten. Every write
   * resets `enforcementState` — it reports how far the pass got towards
   * **this** desired state.
   */
  private async write(tx: Prisma.TransactionClient, config: ConfigRow, data: Prisma.ConfigUpdateManyMutationInput) {
    const moved = await tx.config.updateMany({
      where: { id: config.id, status: config.status },
      data: { ...data, enforcementState: EnforcementState.pending },
    });
    if (moved.count === 0) throw new ConfigActionRefused('config_changed', config.id);
  }

  /** A config the actor may act on and that is not retired. Another user's reads as absent. */
  private async live(tx: Prisma.TransactionClient, configId: string, actor: ConfigActor): Promise<ConfigRow> {
    const config = (await tx.config.findUnique({
      where: { id: configId },
      select: {
        id: true,
        tenantId: true,
        userId: true,
        grantId: true,
        panelId: true,
        protocol: true,
        status: true,
        regenerateUsedCount: true,
        maxRegenerateCount: true,
      },
    })) as ConfigRow | null;
    if (!config || !this.owns(actor, config.userId)) throw new ConfigActionRefused('config_not_found', configId);
    if (config.status === ConfigStatus.retired) throw new ConfigActionRefused('config_retired', configId);
    return config;
  }

  /** A shared panel, or one dedicated to this tenant (`Panel.tenantId`). Anyone else's reads as absent. */
  private async panelFor(tx: Prisma.TransactionClient, panelId: string, tenantId: string) {
    const panel = await tx.panel.findUnique({ where: { id: panelId }, select: { id: true, tenantId: true } });
    if (!panel || (panel.tenantId !== null && panel.tenantId !== tenantId)) throw new ConfigActionRefused('panel_not_found', panelId);
  }

  private owns(actor: ConfigActor, userId: string) {
    return actor.actorType !== ActorType.user || actor.actorId === userId;
  }

  private async log(tx: Prisma.TransactionClient, configId: string, actor: ConfigActor, action: string) {
    await tx.configActionLog.create({ data: { configId, actorType: actor.actorType, actorId: actor.actorId, action } });
  }
}
