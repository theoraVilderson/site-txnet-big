import { Injectable, Logger } from '@nestjs/common';
import { AdminAction, Prisma } from '@prisma/client';

import type { DestinationFields, ManualMethod } from '../manual/manual-method';
import { assertAutomaticPossible, checkedDestination, fieldsOf, MAX_DESTINATIONS, methodOf, settingWhere } from '../manual/manual-setting';
import { GatewayAdminRefused } from './gateway-admin.refusal';
import { GatewayActor, GatewayAdminService, GatewayRef } from './gateway-admin.service';

type Tx = Prisma.TransactionClient;

/** A destination as it travels: `fields` whole, private ones included — this is the seller's own editor. */
export type DestinationInput = {
  label?: string;
  fields?: Record<string, unknown>;
  isActive?: boolean;
  sortOrder?: number;
  weight?: number;
  /** Minor units of the charge currency, as a string (JSON has no bigint); `null` clears it. */
  dailyCapMinor?: string | null;
};

export type DestinationView = {
  id: string;
  label: string;
  fields: DestinationFields;
  isActive: boolean;
  sortOrder: number;
  weight: number;
  dailyCapMinor: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const DESTINATION_SELECT = {
  id: true,
  label: true,
  fields: true,
  isActive: true,
  sortOrder: true,
  weight: true,
  dailyCapMinor: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ManualDestinationSelect;
type DestinationRow = Prisma.ManualDestinationGetPayload<{ select: typeof DESTINATION_SELECT }>;

const view = (row: DestinationRow): DestinationView => ({ ...row, fields: fieldsOf(row.fields), dailyCapMinor: row.dailyCapMinor?.toString() ?? null });

/** The setting a destination write needs: its id, kind and mode, and every destination's activity and fields. */
type SettingOf = { id: string; method: ManualMethod; confirmationMode: string; destinations: { id: string; isActive: boolean; fields: Prisma.JsonValue }[] };

/**
 * A manual gateway's destinations — the cards and wallets its payer is shown
 * (F-803-c, contract.manual-transfer.md "Gateway admin"). The door is gateway
 * admin's own (`GatewayAdminService.onGateway`): the same scope, pool and
 * `gateway_not_found` for a row the caller may not manage, on both surfaces.
 *
 * Every write is one `admin_audit_log` row in the gateway owner's tenant, in
 * the same transaction. A destination a payment showed is deactivated, never
 * deleted: the payment's snapshot and its review need the row (F-803-a).
 */
@Injectable()
export class ManualDestinationService {
  private readonly logger = new Logger(ManualDestinationService.name);

  constructor(private readonly gateways: GatewayAdminService) {}

  list(actor: GatewayActor, ref: GatewayRef): Promise<DestinationView[]> {
    return this.gateways.onGateway(actor, ref, async (tx) => {
      const setting = await this.settingOf(tx, ref);
      const rows = await tx.manualDestination.findMany({
        where: { settingId: setting.id },
        select: DESTINATION_SELECT,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        take: MAX_DESTINATIONS,
      });
      return rows.map(view);
    });
  }

  async create(actor: GatewayActor, ref: GatewayRef, input: DestinationInput & { label: string }): Promise<DestinationView> {
    const created = await this.gateways.onGateway(actor, ref, async (tx, _row, ownerTenantId) => {
      const setting = await this.settingOf(tx, ref);
      if (setting.destinations.length >= MAX_DESTINATIONS) throw new GatewayAdminRefused('invalid_range', `at most ${MAX_DESTINATIONS} destinations`);
      const fields = checkedDestination(setting.method, input.fields ?? {});
      const isActive = input.isActive ?? true;
      if (isActive) this.assertModeHolds(setting, null, fields);
      const row = await tx.manualDestination.create({
        data: { tenantId: ownerTenantId, settingId: setting.id, label: input.label, fields, isActive, ...this.ordering(input) },
        select: DESTINATION_SELECT,
      });
      await this.audit(tx, actor, ref, ownerTenantId, AdminAction.gateway_manual_destination_create, null, view(row));
      return row;
    });
    this.logger.log(`gateway ${ref.source}:${ref.id} destination ${created.id} created by ${actor.adminId}`);
    return view(created);
  }

  async update(actor: GatewayActor, ref: GatewayRef, destinationId: string, patch: DestinationInput): Promise<DestinationView> {
    const updated = await this.gateways.onGateway(actor, ref, async (tx, _row, ownerTenantId) => {
      const setting = await this.settingOf(tx, ref);
      const before = await this.destinationOf(tx, setting, destinationId);
      const fields = patch.fields === undefined ? fieldsOf(before.fields) : checkedDestination(setting.method, patch.fields);
      if (patch.isActive ?? before.isActive) this.assertModeHolds(setting, destinationId, fields);
      const row = await tx.manualDestination.update({
        where: { id: destinationId },
        data: { label: patch.label, fields: patch.fields === undefined ? undefined : fields, isActive: patch.isActive, ...this.ordering(patch) },
        select: DESTINATION_SELECT,
      });
      await this.audit(tx, actor, ref, ownerTenantId, AdminAction.gateway_manual_destination_update, view(before), view(row));
      return row;
    });
    this.logger.log(`gateway ${ref.source}:${ref.id} destination ${destinationId} updated by ${actor.adminId}`);
    return view(updated);
  }

  /** Deleted when no payment ever showed it; otherwise deactivated, and the answer's `mode` says which. */
  async remove(actor: GatewayActor, ref: GatewayRef, destinationId: string): Promise<{ id: string; mode: 'deleted' | 'deactivated' }> {
    const mode = await this.gateways.onGateway(actor, ref, async (tx, _row, ownerTenantId) => {
      const setting = await this.settingOf(tx, ref);
      const before = await this.destinationOf(tx, setting, destinationId);
      const shown = await tx.paymentTransferDetail.count({ where: { destinationId } });
      const mode = shown > 0 ? 'deactivated' : 'deleted';
      if (shown > 0) await tx.manualDestination.update({ where: { id: destinationId }, data: { isActive: false } });
      else await tx.manualDestination.delete({ where: { id: destinationId } });
      await this.audit(tx, actor, ref, ownerTenantId, AdminAction.gateway_manual_destination_delete, view(before), { mode, payments: shown });
      return mode;
    });
    this.logger.log(`gateway ${ref.source}:${ref.id} destination ${destinationId} ${mode} by ${actor.adminId}`);
    return { id: destinationId, mode };
  }

  /** The gateway's manual setting, or `manual_setting_mismatch`: only a manual gateway has destinations. */
  private async settingOf(tx: Tx, ref: GatewayRef): Promise<SettingOf> {
    const setting = await tx.manualGatewaySetting.findFirst({
      where: settingWhere(ref),
      select: { id: true, kind: true, confirmationMode: true, destinations: { select: { id: true, isActive: true, fields: true }, take: MAX_DESTINATIONS } },
    });
    if (!setting) throw new GatewayAdminRefused('manual_setting_mismatch', `${ref.id} is not a manual gateway`);
    return { ...setting, method: methodOf(setting.kind) };
  }

  private async destinationOf(tx: Tx, setting: SettingOf, destinationId: string): Promise<DestinationRow> {
    const row = await tx.manualDestination.findFirst({ where: { id: destinationId, settingId: setting.id }, select: DESTINATION_SELECT });
    if (!row) throw new GatewayAdminRefused('destination_not_found', destinationId);
    return row;
  }

  /** An automatic gateway stays watchable: every active destination, this one as it will be, has a watcher. */
  private assertModeHolds(setting: SettingOf, replacing: string | null, fields: DestinationFields): void {
    const others = setting.destinations.filter((d) => d.isActive && d.id !== replacing).map((d) => fieldsOf(d.fields));
    assertAutomaticPossible(setting.method, setting.confirmationMode, [...others, fields]);
  }

  /** The order and F-807's rotation columns a write names; absent keys change nothing. */
  private ordering(input: DestinationInput): { sortOrder?: number; weight?: number; dailyCapMinor?: bigint | null } {
    return {
      sortOrder: input.sortOrder,
      weight: input.weight,
      dailyCapMinor: input.dailyCapMinor && BigInt(input.dailyCapMinor),
    };
  }

  private async audit(tx: Tx, actor: GatewayActor, ref: GatewayRef, ownerTenantId: string, action: AdminAction, before: object | null, after: object): Promise<void> {
    await tx.adminAuditLog.create({
      data: {
        tenantId: ownerTenantId,
        adminId: actor.adminId,
        action,
        targetEntityType: 'gateway',
        targetEntityId: ref.id,
        oldValue: before ? (JSON.parse(JSON.stringify(before)) as Prisma.InputJsonValue) : Prisma.DbNull,
        newValue: { source: ref.source, ...(JSON.parse(JSON.stringify(after)) as Prisma.InputJsonObject) },
        adminIpAddress: actor.ip,
      },
    });
  }
}
