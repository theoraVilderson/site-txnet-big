import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConfirmationMode,
  FeeCalcMode,
  FeeType,
  GatewayCategory,
  PaymentProviderName,
  Prisma,
  RateRoundingMode,
} from '@prisma/client';
import { tenantTransaction, operatingCurrencyOf, platformCurrencyOf, isPlatformTenant, refusedAudienceGroup } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../../config/env.validation';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InvalidDepositPresets, normalizePresets } from '../deposit/deposit-presets';
import type { GatewaySource } from '../gateway/gateway-merchant';
import { GATEWAY_SECRET_NAMES, type GatewaySecretName, PROVIDER_FIELDS } from '../gateway/provider-fields';
import { checkManualShape, MANUAL_SETTING_SELECT, type ManualSettingInput, type ManualSettingRow, manualSettingView, saveManualSetting } from '../manual/manual-setting';
import { GatewayAdminRefused } from './gateway-admin.refusal';
import { assertGatewayMoneyPlaces, callbackAddress, dec, taxRate } from './gateway-fields';
import { gatewayView, type GatewayView, presetStrings, str } from './gateway-view';

/** What the vault writer says about one secret. Never a value. */
export type GatewaySecretState = { configured: boolean; version: number | null; rotatedAt: Date | string | null };
export type GatewaySecretsState = Record<GatewaySecretName, GatewaySecretState>;
export type GatewaySecretTarget = { tenantId: string; source: GatewaySource; gatewayId: string };
export type GatewaySecretValues = Partial<Record<GatewaySecretName, string>>;

/**
 * The write side of a gateway's secrets, which is `tenant-service`'s (F-102-a, F-018-ab):
 * `billing` loads the vault read-only (ADR-0039). An interface so the rules
 * here are provable without a process on the other end; `VaultSecretClient` is
 * the implementation.
 */
export interface GatewaySecretWriter {
  set(target: GatewaySecretTarget, values: GatewaySecretValues, actorId: string): Promise<GatewaySecretsState>;
  state(target: GatewaySecretTarget): Promise<GatewaySecretsState>;
  revoke(target: GatewaySecretTarget): Promise<GatewaySecretsState>;
}
export const GATEWAY_SECRET_WRITER = Symbol('GATEWAY_SECRET_WRITER');

/** Who is acting, as the gate proved it. Never taken from a body. */
/** `permissions`: the caller's keys in the tenant it acts in, which decide the groups it may aim at (ADR-0143). */
export type GatewayActor = { adminId: string; tenantId: string; ip: string; permissions: readonly string[] };
export type GatewayRef = { source: GatewaySource; id: string };

/** Every editable column, as it travels: decimals as strings (C-02), enums as their names. */
export type GatewayFields = {
  displayName?: string;
  providerName?: string;
  gatewayCategory?: string;
  isActive?: boolean;
  /** `null` is no limit on that side. */
  minAcceptAmount?: string | null;
  maxAcceptAmount?: string | null;
  feeCalculationMode?: string;
  feeType?: string;
  feeValue?: string;
  feeFloor?: string | null;
  feeCeiling?: string | null;
  useLiveRate?: boolean;
  staticRate?: string | null;
  percentageModifier?: string;
  fixedAmountModifier?: string;
  minRate?: string | null;
  maxRate?: string | null;
  roundingStep?: string | null;
  roundingMode?: string;
  /** Platform gateways only. */
  description?: string | null;
  supportedCurrencies?: string[];
  confirmationMode?: string;
  /**
   * Tenant gateways only, and only the platform owner may send it (F-104-ak):
   * a reason blocks the gateway, `null` lifts the block.
   */
  blockedReason?: string | null;
  /** Quick amounts on the top-up page; empty inherits the tenant's default (F-092-v). */
  depositPresets?: string[];
  /** Tax on a top-up through this gateway, 0..100; `null` inherits the tenant's default (ADR-0076). */
  taxRatePercent?: string | null;
  /** The callback address sent to the provider; `null` = the tenant's panel domain (F-092-w). */
  callbackUrl?: string | null;
  /** A `manual_transfer` gateway's kind, mode, proof and window (F-803-c); required on its create. */
  manual?: ManualSettingInput;
};
export type CreateGatewayInput = GatewayFields & GatewaySecretValues & { source: GatewaySource; tenantId?: string };
export type UpdateGatewayInput = GatewayFields & GatewaySecretValues;

/** A tenant's default quick amounts (F-092-v), and what they are in (ADR-0098 part 3, F-116-h2). */
export type DepositPresetList = { presets: string[]; currencyCode: string };

const DECIMAL_COLUMNS = [
  'minAcceptAmount',
  'maxAcceptAmount',
  'feeValue',
  'feeFloor',
  'feeCeiling',
  'staticRate',
  'percentageModifier',
  'fixedAmountModifier',
  'minRate',
  'maxRate',
  'roundingStep',
  'taxRatePercent',
] as const;
const PLAIN_COLUMNS = ['displayName', 'isActive', 'useLiveRate'] as const;
const ENUM_COLUMNS = { providerName: PaymentProviderName, gatewayCategory: GatewayCategory, feeCalculationMode: FeeCalcMode, feeType: FeeType, roundingMode: RateRoundingMode } as const;
const PLATFORM_ONLY = ['description', 'supportedCurrencies', 'confirmationMode'] as const;
const REQUIRED_ON_CREATE = ['displayName', 'providerName', 'gatewayCategory', 'feeCalculationMode', 'feeType', 'feeValue'] as const;
const SECRET_KEYS = GATEWAY_SECRET_NAMES;
/** A gateway row with its manual setting (F-803-c): every view and audit snapshot shows it. */
const WITH_MANUAL = { manualSetting: { select: MANUAL_SETTING_SELECT } } as const;

const NOT_CONFIGURED: GatewaySecretsState = {
  merchantId: { configured: false, version: null, rotatedAt: null },
  secretKey: { configured: false, version: null, rotatedAt: null },
  webhookSecret: { configured: false, version: null, rotatedAt: null },
};

type Row = Record<string, unknown>;
type Tx = Prisma.TransactionClient;
/** `billing.gateway_usage`: every payment and grant that names the gateway, in any tenant. */
type GatewayUsage = { payments: number; open_payments: number; grants: number };

/**
 * Managing payment gateways (F-102-b, D-31): create, change and delete the
 * platform's `payment_gateway` rows and every tenant's `tenant_gateway_config`
 * rows. Linking a gateway to a tenant is not here — that is the grant, and it
 * stays `SettlementService`'s (ADR-0041).
 *
 * **Who may touch what.** The platform owner: every row. Any other tenant: its
 * own `tenant_gateway_config` rows and nothing else. A row outside a tenant's
 * reach is answered as `gateway_not_found`, so the surface never confirms that a
 * competitor's gateway exists.
 *
 * **The pool follows the caller (ADR-0053, F-102-f-b).** The platform owner
 * works across tenants, which its own `app.tenant_id` cannot see, so only it is
 * served on the cross-tenant pool; any other tenant runs in a
 * `tenantTransaction` on the app pool, where strict RLS stands behind this
 * file's own checks. {@link isOwner} decides, {@link within} hands out the pool.
 * The one thing a tenant admin needs from other tenants — the payments and
 * grants that name its lent gateway, on delete — goes through two SECURITY
 * DEFINER functions that check the gateway is the caller's own
 * (`20260917000200_gateway_release`), never through the cross-tenant pool.
 *
 * **Secrets never pass through a column, an answer or an audit row.** They are
 * relayed to {@link GatewaySecretWriter} and the audit row records only which
 * of them changed. The deprecated `merchantId` / `*Encrypted` columns are
 * never selected and never written with a value (invariant 8).
 *
 * **A tenant's gateway is its own; the block is the platform owner's**
 * (F-104-ak, the user's call 2026-10-08). Switched on, a tenant gateway is
 * offered (`deposit-pricing.ts`) — no approval, and no reset when its secret or
 * provider changes. The platform owner alone may block one, with a reason, and
 * lift it; a blocked gateway is offered to nobody and cannot be deleted, since
 * deleting and adding it again would lift the block.
 */
@Injectable()
export class GatewayAdminService {
  private readonly logger = new Logger(GatewayAdminService.name);

  constructor(
    /** The caller's own tenant, bound by RLS: who is asking, and every tenant admin's work. */
    private readonly prisma: PrismaService,
    /** Every tenant's gateway rows, by policy — the platform owner's only. See the class comment. */
    private readonly all: CrossTenantPrismaService,
    @Inject(GATEWAY_SECRET_WRITER) private readonly secrets: GatewaySecretWriter,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  /** The pool for this caller: the cross-tenant one for the platform owner, a `tenantTransaction` for anyone else. */
  private within<T>(owner: boolean, fn: (db: Tx) => Promise<T>): Promise<T> {
    return owner ? this.all.$transaction(fn) : tenantTransaction(this.prisma, fn);
  }

  /**
   * The caller's own default quick amounts (F-092-v) — a gateway with a list of
   * its own overrides them. Always the caller's tenant: a tenant's price list
   * is its own business, the platform owner's included.
   */
  async presets(actor: GatewayActor): Promise<DepositPresetList> {
    return tenantTransaction(this.prisma, async (db) => {
      const row = await db.depositSetting.findUnique({ where: { tenantId: actor.tenantId } });
      // No row yet: the list is empty, and a first save writes it in the tenant's currency.
      return { presets: presetStrings(row?.presets), currencyCode: row?.currencyCode ?? (await operatingCurrencyOf(db, actor.tenantId)) };
    });
  }

  async setPresets(actor: GatewayActor, values: string[]): Promise<DepositPresetList> {
    const presets = this.presetDecimals(values);
    const saved = await tenantTransaction(this.prisma, async (tx) => {
      const setting = await tx.depositSetting.findUnique({ where: { tenantId: actor.tenantId } });
      await assertGatewayMoneyPlaces(tx, setting?.currencyCode ?? (await operatingCurrencyOf(tx, actor.tenantId)), { depositPresets: presets });
      const before = presetStrings(setting?.presets);
      const row = await tx.depositSetting.upsert({
        where: { tenantId: actor.tenantId },
        create: { tenantId: actor.tenantId, currencyCode: await operatingCurrencyOf(tx, actor.tenantId), presets, updatedByUserId: actor.adminId },
        update: { presets, updatedByUserId: actor.adminId },
      });
      await tx.adminAuditLog.create({
        data: {
          tenantId: actor.tenantId,
          adminId: actor.adminId,
          action: 'deposit_presets_update',
          targetEntityType: 'config',
          targetEntityId: actor.tenantId,
          oldValue: { presets: before },
          newValue: { presets: presetStrings(presets) },
          adminIpAddress: actor.ip,
        },
      });
      return row;
    });
    return { presets: presetStrings(presets), currencyCode: saved.currencyCode };
  }

  /**
   * The caller's default tax on a top-up (ADR-0076, F-104-ag) — a gateway with
   * a rate of its own overrides it; `null` is no tax. The caller's tenant only,
   * like the quick amounts it shares a row with.
   */
  async tax(actor: GatewayActor): Promise<string | null> {
    const row = await tenantTransaction(this.prisma, (db) => db.depositSetting.findUnique({ where: { tenantId: actor.tenantId } }));
    return str(row?.taxRatePercent);
  }

  async setTax(actor: GatewayActor, value: string | null): Promise<string | null> {
    const taxRatePercent = taxRate(value);
    await tenantTransaction(this.prisma, async (tx) => {
      const before = str((await tx.depositSetting.findUnique({ where: { tenantId: actor.tenantId } }))?.taxRatePercent);
      // `update` names the rate alone: the quick amounts on the same row are not this write's.
      await tx.depositSetting.upsert({
        where: { tenantId: actor.tenantId },
        create: { tenantId: actor.tenantId, currencyCode: await operatingCurrencyOf(tx, actor.tenantId), taxRatePercent, updatedByUserId: actor.adminId },
        update: { taxRatePercent, updatedByUserId: actor.adminId },
      });
      await tx.adminAuditLog.create({
        data: {
          tenantId: actor.tenantId,
          adminId: actor.adminId,
          action: 'deposit_tax_update',
          targetEntityType: 'config',
          targetEntityId: actor.tenantId,
          oldValue: { taxRatePercent: before },
          newValue: { taxRatePercent: str(taxRatePercent) },
          adminIpAddress: actor.ip,
        },
      });
    });
    return str(taxRatePercent);
  }

  /** Every gateway the caller may manage, platform rows first. */
  async list(actor: GatewayActor, filter: { tenantId?: string } = {}): Promise<GatewayView[]> {
    const owner = await this.isOwner(actor);
    const [platform, tenant] = await this.within(owner, async (db) => [
      owner && !filter.tenantId ? await db.paymentGateway.findMany({ include: WITH_MANUAL, orderBy: { createdAt: 'asc' }, take: 200 }) : [],
      await db.tenantGatewayConfig.findMany({
        // A tenant's filter is ignored rather than refused: it can only ever mean its own rows.
        where: { tenantId: owner ? filter.tenantId : actor.tenantId },
        include: WITH_MANUAL,
        orderBy: { createdAt: 'asc' },
        take: 200,
      }),
    ]);

    // F-102-g: one read for every listed gateway's groups. A tenant's own rows
    // only, or every tenant's for the platform owner — the same scope as the list.
    const audience = await this.within(owner, (db) =>
      db.gatewayAudience.findMany({
        where: { tenantId: owner ? filter.tenantId : actor.tenantId },
        select: { gatewayId: true, tenantGatewayConfigId: true, groupId: true },
      }),
    );
    const groupsOf = (source: GatewaySource, id: string) =>
      audience.filter((a) => (source === 'platform' ? a.gatewayId : a.tenantGatewayConfigId) === id).map((a) => a.groupId);

    const out: GatewayView[] = [];
    for (const row of platform as Row[]) {
      const id = row['id'] as string;
      out.push(gatewayView('platform', row, await this.stateOrNull(this.target({ source: 'platform', id }, row, actor)), groupsOf('platform', id)));
    }
    for (const row of tenant as Row[]) {
      const id = row['id'] as string;
      out.push(gatewayView('tenant', row, await this.stateOrNull(this.target({ source: 'tenant', id }, row, actor)), groupsOf('tenant', id)));
    }
    return out;
  }

  async create(actor: GatewayActor, input: CreateGatewayInput): Promise<GatewayView> {
    const owner = await this.isOwner(actor);
    let tenantId: string | null = null;

    if (input.source === 'platform') {
      if (!owner) throw new GatewayAdminRefused('not_platform_owner', 'a platform gateway');
    } else {
      tenantId = input.tenantId ?? actor.tenantId;
      if (tenantId !== actor.tenantId && !owner) throw new GatewayAdminRefused('not_platform_owner', "another tenant's gateway");
    }

    for (const field of REQUIRED_ON_CREATE) {
      if (input[field] === undefined || input[field] === null || input[field] === '') throw new GatewayAdminRefused('missing_field', field);
    }
    if (input.blockedReason !== undefined && !owner) throw new GatewayAdminRefused('block_is_platform_owners');
    this.assertRanges(input);
    checkManualShape(input, input.manual);
    const providerColumns = this.providerRules(input);

    const data = { ...this.columns(input, input.source), ...providerColumns };
    data['isActive'] ??= false;
    if (input.source === 'platform') {
      data['supportedCurrencies'] ??= [];
      // Deprecated and never read (D-25); the column is still NOT NULL.
      data['merchantId'] = '';
    } else {
      data['tenantId'] = tenantId;
      Object.assign(data, this.block(input.blockedReason, actor));
    }

    const created = await this.within(owner, async (tx) => {
      if (tenantId && tenantId !== actor.tenantId) {
        const exists = await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
        if (!exists) throw new GatewayAdminRefused('tenant_not_found', tenantId);
      }
      if (tenantId && PROVIDER_FIELDS[input.providerName as PaymentProviderName].onePerTenant) {
        const duplicate = await tx.tenantGatewayConfig.findFirst({
          where: { tenantId, providerName: input.providerName as PaymentProviderName },
          select: { id: true },
        });
        if (duplicate) throw new GatewayAdminRefused('provider_already_configured', input.providerName);
      }
      // Its limits, fees and presets are in its owner's currency (F-116-b): the
      // platform's for a platform gateway, the tenant's for its own. Set here,
      // under the cast, because `data` is assembled untyped.
      data['currencyCode'] = tenantId ? await operatingCurrencyOf(tx, tenantId) : await platformCurrencyOf(tx);
      await assertGatewayMoneyPlaces(tx, data['currencyCode'] as string, data);
      const row = (input.source === 'platform'
        ? await tx.paymentGateway.create({ data: data as Prisma.PaymentGatewayUncheckedCreateInput })
        : await tx.tenantGatewayConfig.create({ data: data as Prisma.TenantGatewayConfigUncheckedCreateInput })) as unknown as Row;
      const ref = { source: input.source, id: row['id'] as string };
      row['manualSetting'] = await saveManualSetting(tx, { ...ref, ownerTenantId: this.target(ref, row, actor).tenantId, providerName: row['providerName'] }, input.manual);
      await tx.adminAuditLog.create({
        data: {
          tenantId: tenantId ?? actor.tenantId,
          adminId: actor.adminId,
          action: 'gateway_create',
          targetEntityType: 'gateway',
          targetEntityId: row['id'] as string,
          oldValue: Prisma.DbNull,
          newValue: { source: input.source, ...this.snapshot(row), secretsChanged: this.secretsNamed(input) },
          adminIpAddress: actor.ip,
        },
      });
      return row;
    });

    const ref = { source: input.source, id: created['id'] as string };
    const credentials = await this.writeSecrets(this.target(ref, created, actor), input, actor);
    this.logger.log(`gateway ${input.source}:${ref.id} created by ${actor.adminId}`);
    return gatewayView(input.source, created, credentials);
  }

  /**
   * Who a gateway is offered to (F-102-g): the set of its owner's user groups,
   * replaced whole; `[]` = everyone again. The owner is the row's tenant — the
   * platform owner for a platform gateway — so the platform owner setting a
   * reseller's gateway picks that reseller's groups, never its own. A group
   * not the owner's is `group_not_found`, a new one the caller may not pick
   * `audience_not_allowed` (ADR-0143), before anything is written; the composite
   * key refuses a stranger's again. One `gateway_update` audit row, in the owner's tenant.
   */
  async setAudience(actor: GatewayActor, ref: GatewayRef, groupIds: string[]): Promise<{ userGroupIds: string[] }> {
    const owner = await this.isOwner(actor);
    const ids = [...new Set(groupIds)];
    await this.within(owner, async (tx) => {
      const row = await this.load(tx, ref, actor, owner);
      const ownerTenantId = ref.source === 'platform' ? actor.tenantId : (row['tenantId'] as string);
      const before = await this.audienceOf(tx, ref);
      const refused = await refusedAudienceGroup(tx, actor.permissions, ids, { kept: before, tenantId: ownerTenantId });
      if (refused) throw new GatewayAdminRefused(refused.reason, refused.groupId);
      const column = ref.source === 'platform' ? 'gatewayId' : 'tenantGatewayConfigId';
      await tx.gatewayAudience.deleteMany({ where: { [column]: ref.id } });
      if (ids.length > 0) {
        await tx.gatewayAudience.createMany({ data: ids.map((groupId) => ({ tenantId: ownerTenantId, groupId, [column]: ref.id })) });
      }
      await tx.adminAuditLog.create({
        data: {
          tenantId: ownerTenantId,
          adminId: actor.adminId,
          action: 'gateway_update',
          targetEntityType: 'gateway',
          targetEntityId: ref.id,
          oldValue: { userGroupIds: before },
          newValue: { source: ref.source, userGroupIds: ids },
          adminIpAddress: actor.ip,
        },
      });
    });
    this.logger.log(`gateway ${ref.source}:${ref.id} audience set by ${actor.adminId}`);
    return { userGroupIds: ids };
  }

  async update(actor: GatewayActor, ref: GatewayRef, patch: UpdateGatewayInput): Promise<GatewayView> {
    const owner = await this.isOwner(actor);
    const secretsChanged = this.secretsNamed(patch);

    const updated = await this.within(owner, async (tx) => {
      const row = await this.load(tx, ref, actor, owner);

      if (patch.blockedReason !== undefined && (!owner || ref.source === 'platform')) {
        throw new GatewayAdminRefused('block_is_platform_owners');
      }
      this.assertRanges({ ...this.snapshot(row), ...patch });
      await assertGatewayMoneyPlaces(tx, row['currencyCode'] as string, { ...this.snapshot(row), ...patch });
      checkManualShape({ ...this.snapshot(row), ...patch }, patch.manual, row['providerName'] as string);
      const providerColumns = this.providerRules({ ...this.snapshot(row), ...patch });

      if (ref.source === 'tenant' && patch.providerName !== undefined && patch.providerName !== row['providerName'] && PROVIDER_FIELDS[patch.providerName as PaymentProviderName].onePerTenant) {
        const duplicate = await tx.tenantGatewayConfig.findFirst({
          where: { tenantId: row['tenantId'] as string, providerName: patch.providerName as PaymentProviderName },
          select: { id: true },
        });
        if (duplicate && duplicate.id !== ref.id) throw new GatewayAdminRefused('provider_already_configured', patch.providerName);
      }

      const data = { ...this.columns(patch, ref.source), ...providerColumns };
      if (ref.source === 'tenant') Object.assign(data, this.block(patch.blockedReason, actor));

      const before = this.snapshot(row);
      let next: Row = row;
      if (Object.keys(data).length > 0) {
        next = (ref.source === 'platform'
          ? await tx.paymentGateway.update({ where: { id: ref.id }, data: data as Prisma.PaymentGatewayUncheckedUpdateInput })
          : await tx.tenantGatewayConfig.update({ where: { id: ref.id }, data: data as Prisma.TenantGatewayConfigUncheckedUpdateInput })) as unknown as Row;
      }
      const owned = { ...ref, ownerTenantId: this.target(ref, row, actor).tenantId, providerName: next['providerName'] };
      next = { ...next, manualSetting: await saveManualSetting(tx, owned, patch.manual) };
      const after = this.snapshot(next);
      const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
      await tx.adminAuditLog.create({
        data: {
          tenantId: (row['tenantId'] as string | undefined) ?? actor.tenantId,
          adminId: actor.adminId,
          action: 'gateway_update',
          targetEntityType: 'gateway',
          targetEntityId: ref.id,
          oldValue: Object.fromEntries(changed.map((k) => [k, before[k]])) as Prisma.InputJsonValue,
          newValue: { source: ref.source, ...Object.fromEntries(changed.map((k) => [k, after[k]])), secretsChanged },
          adminIpAddress: actor.ip,
        },
      });
      return { next, userGroupIds: await this.audienceOf(tx, ref) };
    });

    const target = this.target(ref, updated.next, actor);
    const credentials = secretsChanged.length > 0 ? await this.writeSecrets(target, patch, actor) : await this.stateOrNull(target);
    this.logger.log(`gateway ${ref.source}:${ref.id} updated by ${actor.adminId}`);
    return gatewayView(ref.source, updated.next, credentials, updated.userGroupIds);
  }

  /**
   * Delete a gateway (ADR-0041 §6). A row nothing points at is deleted; one a
   * payment or a grant points at is deactivated, and its live grants withdrawn
   * — with an audit row in each borrower's tenant — because the payments taken
   * through it must stay explicable. A gateway with a payment still open, in any
   * tenant, is not deleted at all: deactivate it first (the user's call,
   * 2026-09-17).
   *
   * **The door closes before anything else** (F-104-t). Counting the open
   * payments and revoking the secrets are two steps, and between them the
   * gateway was still selectable: a top-up started in that window is paid into a
   * gateway whose webhook secret is gone a moment later, so the webhook door
   * answers 401 and reconciliation gets `CredentialUnavailable` — a payer who
   * has paid, creditable only by a manual confirm. So `isActive` is switched off
   * and committed in the same transaction as the count, before any secret is
   * touched; the count is then taken again on a fresh transaction, and a payment
   * that raced in refuses the delete with the gateway left deactivated and its
   * secret intact — it can still settle, and the delete can be asked for again
   * once it has. Only then are the secrets revoked, so a failure part-way still
   * leaves a gateway that cannot charge, never one that can.
   *
   * Other tenants' payments and grants are reached through
   * `billing.gateway_usage` / `billing.withdraw_gateway_grants`, on whichever
   * pool serves the caller; both refuse a gateway that is not the caller's.
   */
  async remove(actor: GatewayActor, ref: GatewayRef): Promise<{ id: string; source: GatewaySource; mode: 'deleted' | 'deactivated'; grantsWithdrawn: number }> {
    const owner = await this.isOwner(actor);
    const lookbackSec = this.config.get('RECONCILIATION_LOOKBACK_SEC', { infer: true });

    // The count and the switch-off commit together: past here nothing new can be
    // started on the gateway, whichever way the rest of the call ends.
    const row = await this.within(owner, async (db) => {
      const row = await this.load(db, ref, actor, owner);
      if (row['blockedAt']) throw new GatewayAdminRefused('gateway_blocked', ref.id);
      const usage = await this.usage(db, ref, lookbackSec);
      if (usage.open_payments > 0) throw new GatewayAdminRefused('gateway_has_open_payments', `${ref.id}: ${usage.open_payments} open`);
      if (ref.source === 'platform') await db.paymentGateway.update({ where: { id: ref.id }, data: { isActive: false } });
      else await db.tenantGatewayConfig.update({ where: { id: ref.id }, data: { isActive: false } });
      return row;
    });

    // Anything that raced the switch-off is seen now, while the secrets are all
    // still there: the gateway stays deactivated and that payer can still settle.
    const usage = await this.within(owner, async (db) => {
      const usage = await this.usage(db, ref, lookbackSec);
      if (usage.open_payments > 0) await this.auditRemoval(db, actor, ref, row, { mode: 'deactivated', openPayments: usage.open_payments });
      return usage;
    });
    if (usage.open_payments > 0) {
      this.logger.log(`gateway ${ref.source}:${ref.id} deactivated, not deleted: ${usage.open_payments} payment(s) started while deleting`);
      throw new GatewayAdminRefused('gateway_has_open_payments', `${ref.id}: ${usage.open_payments} open`);
    }

    await this.secrets.revoke(this.target(ref, row, actor));

    const used = usage.payments > 0 || usage.grants > 0;
    const grantsWithdrawn = await this.within(owner, async (tx) => {
      let withdrawn = 0;
      if (used) {
        [{ withdrawn }] = await tx.$queryRaw<Array<{ withdrawn: number }>>`
          SELECT billing.withdraw_gateway_grants(${ref.source}::text, ${ref.id}::uuid, ${actor.adminId}::uuid, ${actor.ip}::text) AS withdrawn`;
      } else if (ref.source === 'platform') {
        await tx.paymentGateway.delete({ where: { id: ref.id } });
      } else {
        await tx.tenantGatewayConfig.delete({ where: { id: ref.id } });
      }
      await this.auditRemoval(tx, actor, ref, row, { mode: used ? 'deactivated' : 'deleted', payments: usage.payments, grantsWithdrawn: withdrawn });
      return withdrawn;
    });

    this.logger.log(`gateway ${ref.source}:${ref.id} ${used ? 'deactivated' : 'deleted'} by ${actor.adminId}`);
    return { id: ref.id, source: ref.source, mode: used ? 'deactivated' : 'deleted', grantsWithdrawn };
  }

  /**
   * The door. Read on the application pool, inside the caller's own scope, so
   * the answer is about the tenant the gate forwarded — `tenant.tenant` has no
   * RLS policy, which is what lets this connection answer it (as in
   * `SettlementService.assertOperator`).
   */
  /** The groups one gateway is offered to (F-102-g); empty = everyone. */
  private async audienceOf(db: Tx, ref: GatewayRef): Promise<string[]> {
    const column = ref.source === 'platform' ? 'gatewayId' : 'tenantGatewayConfigId';
    return (await db.gatewayAudience.findMany({ where: { [column]: ref.id }, select: { groupId: true } })).map((a) => a.groupId);
  }

  /**
   * `work` on a gateway this caller may manage, on the pool that serves it,
   * with the gateway's owner — the platform owner for a platform gateway. How
   * a manual gateway's destinations (F-803-c) share this file's door.
   */
  async onGateway<T>(actor: GatewayActor, ref: GatewayRef, work: (tx: Tx, row: Row, ownerTenantId: string) => Promise<T>): Promise<T> {
    const owner = await this.isOwner(actor);
    return this.within(owner, async (tx) => {
      const row = await this.load(tx, ref, actor, owner);
      return work(tx, row, this.target(ref, row, actor).tenantId);
    });
  }

  private async isOwner(actor: GatewayActor): Promise<boolean> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
    return isPlatformTenant(tenant?.tenantType);
  }

  /** The row, if the caller may manage it. Anything else is not found — including before the read, for a platform row. */
  private async load(db: Tx, ref: GatewayRef, actor: GatewayActor, owner: boolean): Promise<Row> {
    if (ref.source === 'platform') {
      if (!owner) throw new GatewayAdminRefused('gateway_not_found', ref.id);
      const row = await db.paymentGateway.findUnique({ where: { id: ref.id }, include: WITH_MANUAL });
      if (!row) throw new GatewayAdminRefused('gateway_not_found', ref.id);
      return row as unknown as Row;
    }
    const row = (await db.tenantGatewayConfig.findUnique({ where: { id: ref.id }, include: WITH_MANUAL })) as unknown as Row | null;
    if (!row || (!owner && row['tenantId'] !== actor.tenantId)) throw new GatewayAdminRefused('gateway_not_found', ref.id);
    return row;
  }

  /** Every payment and grant that names the gateway, in any tenant — counts only, and only for the caller's own gateway. */
  private async usage(db: Tx, ref: GatewayRef, lookbackSec: number): Promise<GatewayUsage> {
    const [usage] = await db.$queryRaw<GatewayUsage[]>`
      SELECT payments, open_payments, grants
        FROM billing.gateway_usage(${ref.source}::text, ${ref.id}::uuid, ${lookbackSec}::integer)`;
    return usage;
  }

  /** The one `gateway_delete` row, in the gateway's own tenant — written however the removal ended. */
  private async auditRemoval(db: Tx, actor: GatewayActor, ref: GatewayRef, row: Row, outcome: Prisma.InputJsonObject): Promise<void> {
    await db.adminAuditLog.create({
      data: {
        tenantId: (row['tenantId'] as string | undefined) ?? actor.tenantId,
        adminId: actor.adminId,
        action: 'gateway_delete',
        targetEntityType: 'gateway',
        targetEntityId: ref.id,
        oldValue: { source: ref.source, ...this.snapshot(row) },
        newValue: outcome,
        adminIpAddress: actor.ip,
      },
    });
  }

  /** Whose vault holds this gateway's secrets: the row's tenant, or the platform owner (the caller, proved by `load`). */
  private target(ref: GatewayRef, row: Row, actor: GatewayActor): GatewaySecretTarget {
    return { tenantId: ref.source === 'platform' ? actor.tenantId : (row['tenantId'] as string), source: ref.source, gatewayId: ref.id };
  }

  private async writeSecrets(target: GatewaySecretTarget, input: GatewaySecretValues, actor: GatewayActor): Promise<GatewaySecretsState> {
    const values: GatewaySecretValues = {};
    for (const k of SECRET_KEYS) if (typeof input[k] === 'string') values[k] = input[k];
    if (Object.keys(values).length === 0) return NOT_CONFIGURED;
    return this.secrets.set(target, values, actor.adminId);
  }

  private async stateOrNull(target: GatewaySecretTarget): Promise<GatewaySecretsState | null> {
    try {
      return await this.secrets.state(target);
    } catch (e) {
      this.logger.warn(`gateway ${target.source}:${target.gatewayId}: secret state unavailable (${(e as Error).message})`);
      return null;
    }
  }

  private secretsNamed(input: GatewaySecretValues): string[] {
    return SECRET_KEYS.filter((k) => typeof input[k] === 'string');
  }

  /** The block columns a `blockedReason` asks for: a reason blocks, `null` lifts; absent changes nothing. */
  private block(reason: string | null | undefined, actor: GatewayActor): Row {
    if (reason === undefined) return {};
    if (reason === null) return { blockedAt: null, blockedReason: null, blockedByAdminId: null };
    const why = reason.trim();
    if (!why) throw new GatewayAdminRefused('missing_field', 'blockedReason');
    return { blockedAt: new Date(), blockedReason: why, blockedByAdminId: actor.adminId };
  }

  /** The columns a patch names, converted. Only named columns: a secret key is not one, and never becomes one. */
  private columns(input: GatewayFields, source: GatewaySource): Row {
    const data: Row = {};
    if (input.depositPresets !== undefined) data['depositPresets'] = this.presetDecimals(input.depositPresets);
    if (input.callbackUrl !== undefined) data['callbackUrl'] = callbackAddress(input.callbackUrl);
    for (const k of PLAIN_COLUMNS) if (input[k] !== undefined) data[k] = input[k];
    for (const k of DECIMAL_COLUMNS) if (input[k] !== undefined) data[k] = dec(input[k]);
    for (const [k, values] of Object.entries(ENUM_COLUMNS)) {
      const v = input[k as keyof typeof ENUM_COLUMNS];
      if (v === undefined) continue;
      if (!(v in values)) throw new GatewayAdminRefused('missing_field', k);
      data[k] = v;
    }
    if (source === 'platform') {
      for (const k of PLATFORM_ONLY) if (input[k] !== undefined) data[k] = input[k];
      if (data['confirmationMode'] !== undefined && !((data['confirmationMode'] as string) in ConfirmationMode)) {
        throw new GatewayAdminRefused('missing_field', 'confirmationMode');
      }
    }
    return data;
  }

  /** Every public column of a row, JSON-safe. The one shape an audit row or an answer is built from. */
  private snapshot(row: Row): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of [...PLAIN_COLUMNS, ...Object.keys(ENUM_COLUMNS), 'blockedReason', ...PLATFORM_ONLY]) {
      if (row[k] !== undefined) out[k] = row[k];
    }
    for (const k of DECIMAL_COLUMNS) if (row[k] !== undefined) out[k] = str(row[k]);
    if (row['depositPresets'] !== undefined) out['depositPresets'] = presetStrings(row['depositPresets']);
    if (row['callbackUrl'] !== undefined) out['callbackUrl'] = str(row['callbackUrl']);
    if (row['manualSetting'] !== undefined) out['manual'] = manualSettingView(row['manualSetting'] as ManualSettingRow | null);
    return out;
  }

  /** A list as stored, or the refusal that names why it cannot be. */
  private presetDecimals(values: string[]): Prisma.Decimal[] {
    try {
      return normalizePresets(values).map((v) => new Prisma.Decimal(v));
    } catch (e) {
      if (e instanceof InvalidDepositPresets) throw new GatewayAdminRefused('invalid_presets', e.message);
      throw e;
    }
  }

  /**
   * What the gateway's provider requires of its settings (F-104-e), checked on
   * the row as it will be. A `telegram_stars` gateway is priced by its own USD
   * value per Star: a positive `staticRate`, and the live rate forced off.
   * Answers the columns that rule sets. Secrets are not checked here.
   */
  private providerRules(v: GatewayFields): Row {
    const fields = PROVIDER_FIELDS[v.providerName as PaymentProviderName];
    if (!fields?.staticRateRequired) return {};
    const rate = dec(v.staticRate);
    if (!rate || !rate.greaterThan(0)) throw new GatewayAdminRefused('missing_field', 'staticRate');
    return v.useLiveRate === false ? {} : { useLiveRate: false };
  }

  private assertRanges(v: GatewayFields | Record<string, unknown>): void {
    const pairs: Array<[string, string]> = [
      ['minAcceptAmount', 'maxAcceptAmount'],
      ['feeFloor', 'feeCeiling'],
      ['minRate', 'maxRate'],
    ];
    const r = v as Record<string, unknown>;
    for (const [lo, hi] of pairs) {
      const a = dec(r[lo]);
      const b = dec(r[hi]);
      if ((a && a.isNegative()) || (b && b.isNegative())) throw new GatewayAdminRefused('invalid_range', lo);
      if (a && b && a.greaterThan(b)) throw new GatewayAdminRefused('invalid_range', `${lo} > ${hi}`);
    }
    for (const k of ['feeValue', 'staticRate', 'roundingStep']) {
      const d = dec(r[k]);
      if (d && d.isNegative()) throw new GatewayAdminRefused('invalid_range', k);
    }
    taxRate(r['taxRatePercent']);
  }

}
