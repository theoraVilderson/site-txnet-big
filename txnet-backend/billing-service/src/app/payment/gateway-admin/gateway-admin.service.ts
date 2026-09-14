import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ConfirmationMode,
  FeeCalcMode,
  FeeType,
  GatewayCategory,
  PaymentProviderName,
  Prisma,
  RateRoundingMode,
  TenantGatewayVerificationStatus,
  TenantType,
} from '@prisma/client';

import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InvalidDepositPresets, normalizePresets } from '../deposit/deposit-presets';
import type { GatewaySource } from '../gateway/gateway-merchant';

/** What the vault writer says about one secret. Never a value. */
export type GatewaySecretState = { configured: boolean; version: number | null; rotatedAt: Date | string | null };
export type GatewaySecretsState = { merchantId: GatewaySecretState; secretKey: GatewaySecretState };
export type GatewaySecretTarget = { tenantId: string; source: GatewaySource; gatewayId: string };
export type GatewaySecretValues = { merchantId?: string; secretKey?: string };

/**
 * The write side of a gateway's secrets, which is `auth-service`'s (F-102-a):
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
export type GatewayActor = { adminId: string; tenantId: string; ip: string };
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
  /** Tenant gateways only, and only the platform owner may set it. */
  verificationStatus?: string;
  /** Quick amounts on the top-up page; empty inherits the tenant's default (F-092-v). */
  depositPresets?: string[];
  /** The callback address sent to the provider; `null` = the tenant's panel domain (F-092-w). */
  callbackUrl?: string | null;
};
export type CreateGatewayInput = GatewayFields & GatewaySecretValues & { source: GatewaySource; tenantId?: string };
export type UpdateGatewayInput = GatewayFields & GatewaySecretValues;

export type GatewayView = {
  source: GatewaySource;
  id: string;
  /** The owning tenant; `null` for a platform gateway, which is the platform owner's by definition. */
  tenantId: string | null;
  displayName: string;
  providerName: string;
  gatewayCategory: string;
  isActive: boolean;
  verificationStatus: string | null;
  description: string | null;
  supportedCurrencies: unknown;
  confirmationMode: string | null;
  minAcceptAmount: string | null;
  maxAcceptAmount: string | null;
  feeCalculationMode: string;
  feeType: string;
  feeValue: string;
  feeFloor: string | null;
  feeCeiling: string | null;
  useLiveRate: boolean;
  staticRate: string | null;
  percentageModifier: string | null;
  fixedAmountModifier: string | null;
  minRate: string | null;
  maxRate: string | null;
  roundingStep: string | null;
  roundingMode: string | null;
  /** This gateway's own quick amounts; empty means it inherits the tenant's default (F-092-v). */
  depositPresets: string[];
  /** The callback address sent to the provider, or `null` for the tenant's panel domain (F-092-w). */
  callbackUrl: string | null;
  /** `null` when the vault writer could not be asked; the list still renders. */
  credentials: GatewaySecretsState | null;
  createdAt: Date;
  updatedAt: Date;
};

export type GatewayAdminRejection =
  | 'not_platform_owner'
  | 'gateway_not_found'
  | 'tenant_not_found'
  | 'verification_is_platform_owners'
  | 'provider_already_configured'
  | 'invalid_range'
  | 'missing_field'
  | 'invalid_presets'
  | 'invalid_callback';

/** A refusal. Its message names the rule and a row id, never a value. */
export class GatewayAdminRefused extends Error {
  constructor(readonly reason: GatewayAdminRejection, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'GatewayAdminRefused';
  }
}

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
] as const;
const PLAIN_COLUMNS = ['displayName', 'isActive', 'useLiveRate'] as const;
const ENUM_COLUMNS = { providerName: PaymentProviderName, gatewayCategory: GatewayCategory, feeCalculationMode: FeeCalcMode, feeType: FeeType, roundingMode: RateRoundingMode } as const;
const PLATFORM_ONLY = ['description', 'supportedCurrencies', 'confirmationMode'] as const;
const REQUIRED_ON_CREATE = ['displayName', 'providerName', 'gatewayCategory', 'feeCalculationMode', 'feeType', 'feeValue'] as const;
const SECRET_KEYS = ['merchantId', 'secretKey'] as const;

const NOT_CONFIGURED: GatewaySecretsState = {
  merchantId: { configured: false, version: null, rotatedAt: null },
  secretKey: { configured: false, version: null, rotatedAt: null },
};

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
/**
 * A callback address as stored: trimmed, absolute, http or https — anything a
 * browser could be sent to that is not a web page (`javascript:`, `data:`) is
 * refused. Empty clears it. Which host it names is the operator's call: it is
 * the one their provider terminal is registered on.
 */
function callbackAddress(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new GatewayAdminRefused('invalid_callback', 'not an absolute address');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || trimmed.length > 500) {
    throw new GatewayAdminRefused('invalid_callback', 'only http(s), at most 500 characters');
  }
  return trimmed;
}

const presetStrings = (v: unknown): string[] => (Array.isArray(v) ? v.map((d) => new Prisma.Decimal(String(d)).toFixed(2)) : []);
const dec = (v: unknown): Prisma.Decimal | null => (v === null || v === undefined || v === '' ? null : new Prisma.Decimal(String(v)));

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
 * **Why the cross-tenant pool, and what stands in for RLS.** The platform owner
 * works across tenants, which its own `app.tenant_id` cannot see — the same
 * reason and the same pool as `SettlementService`. So the boundary is this
 * file: {@link isOwner} is read on the application pool inside the caller's own
 * scope, and every method decides from it before it reads or writes a row.
 *
 * **Secrets never pass through a column, an answer or an audit row.** They are
 * relayed to {@link GatewaySecretWriter} and the audit row records only which
 * of the two changed. The deprecated `merchantId` / `*Encrypted` columns are
 * never selected and never written with a value (invariant 8).
 *
 * **Verification is the platform owner's.** A tenant gateway is offered to
 * payers only once `verified` (`deposit-pricing.ts`). A tenant that changes a
 * verified gateway's secret sends it back to `pending_test_transaction`, and
 * the reset commits *before* the new secret is written, so there is no moment
 * at which a verified gateway charges into an unverified account.
 */
@Injectable()
export class GatewayAdminService {
  private readonly logger = new Logger(GatewayAdminService.name);

  constructor(
    /** The caller's own tenant, bound by RLS — used for one read: who is asking. */
    private readonly prisma: PrismaService,
    /** Every tenant's gateway rows, by policy. See the class comment. */
    private readonly all: CrossTenantPrismaService,
    @Inject(GATEWAY_SECRET_WRITER) private readonly secrets: GatewaySecretWriter,
  ) {}

  /**
   * The caller's own default quick amounts (F-092-v) — a gateway with a list of
   * its own overrides them. Always the caller's tenant: a tenant's price list
   * is its own business, the platform owner's included.
   */
  async presets(actor: GatewayActor): Promise<string[]> {
    const row = await this.all.depositSetting.findUnique({ where: { tenantId: actor.tenantId } });
    return presetStrings(row?.presets);
  }

  async setPresets(actor: GatewayActor, values: string[]): Promise<string[]> {
    const presets = this.presetDecimals(values);
    const before = await this.presets(actor);
    await this.all.$transaction(async (tx) => {
      await tx.depositSetting.upsert({
        where: { tenantId: actor.tenantId },
        create: { tenantId: actor.tenantId, presets, updatedByUserId: actor.adminId },
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
    });
    return presetStrings(presets);
  }

  /** Every gateway the caller may manage, platform rows first. */
  async list(actor: GatewayActor, filter: { tenantId?: string } = {}): Promise<GatewayView[]> {
    const owner = await this.isOwner(actor);
    const platform = owner && !filter.tenantId ? await this.all.paymentGateway.findMany({ orderBy: { createdAt: 'asc' }, take: 200 }) : [];
    const tenant = await this.all.tenantGatewayConfig.findMany({
      // A tenant's filter is ignored rather than refused: it can only ever mean its own rows.
      where: { tenantId: owner ? filter.tenantId : actor.tenantId },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });

    const out: GatewayView[] = [];
    for (const row of platform as Row[]) {
      out.push(this.view('platform', row, await this.stateOrNull(this.target({ source: 'platform', id: row['id'] as string }, row, actor))));
    }
    for (const row of tenant as Row[]) {
      out.push(this.view('tenant', row, await this.stateOrNull(this.target({ source: 'tenant', id: row['id'] as string }, row, actor))));
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
      if (tenantId !== actor.tenantId) {
        if (!owner) throw new GatewayAdminRefused('not_platform_owner', "another tenant's gateway");
        const exists = await this.all.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
        if (!exists) throw new GatewayAdminRefused('tenant_not_found', tenantId);
      }
    }

    for (const field of REQUIRED_ON_CREATE) {
      if (input[field] === undefined || input[field] === null || input[field] === '') throw new GatewayAdminRefused('missing_field', field);
    }
    if (input.verificationStatus !== undefined && !owner) throw new GatewayAdminRefused('verification_is_platform_owners');
    this.assertRanges(input);

    if (tenantId) {
      const duplicate = await this.all.tenantGatewayConfig.findFirst({
        where: { tenantId, providerName: input.providerName as PaymentProviderName },
        select: { id: true },
      });
      if (duplicate) throw new GatewayAdminRefused('provider_already_configured', input.providerName);
    }

    const data = this.columns(input, input.source);
    data['isActive'] ??= false;
    if (input.source === 'platform') {
      data['supportedCurrencies'] ??= [];
      // Deprecated and never read (D-25); the column is still NOT NULL.
      data['merchantId'] = '';
    } else {
      data['tenantId'] = tenantId;
      Object.assign(data, this.verification(input.verificationStatus, actor));
    }

    const created = await this.all.$transaction(async (tx) => {
      const row = (input.source === 'platform'
        ? await tx.paymentGateway.create({ data: data as Prisma.PaymentGatewayUncheckedCreateInput })
        : await tx.tenantGatewayConfig.create({ data: data as Prisma.TenantGatewayConfigUncheckedCreateInput })) as unknown as Row;
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
    return this.view(input.source, created, credentials);
  }

  async update(actor: GatewayActor, ref: GatewayRef, patch: UpdateGatewayInput): Promise<GatewayView> {
    const owner = await this.isOwner(actor);
    const row = await this.load(ref, actor, owner);

    if (patch.verificationStatus !== undefined && (!owner || ref.source === 'platform')) {
      throw new GatewayAdminRefused('verification_is_platform_owners');
    }
    this.assertRanges({ ...this.snapshot(row), ...patch });

    if (ref.source === 'tenant' && patch.providerName !== undefined && patch.providerName !== row['providerName']) {
      const duplicate = await this.all.tenantGatewayConfig.findFirst({
        where: { tenantId: row['tenantId'] as string, providerName: patch.providerName as PaymentProviderName },
        select: { id: true },
      });
      if (duplicate && duplicate.id !== ref.id) throw new GatewayAdminRefused('provider_already_configured', patch.providerName);
    }

    const data = this.columns(patch, ref.source);
    const secretsChanged = this.secretsNamed(patch);
    if (ref.source === 'tenant') {
      if (patch.verificationStatus !== undefined) Object.assign(data, this.verification(patch.verificationStatus, actor));
      if (!owner && secretsChanged.length > 0 && row['verificationStatus'] === TenantGatewayVerificationStatus.verified) {
        data['verificationStatus'] = TenantGatewayVerificationStatus.pending_test_transaction;
        data['verifiedByAdminId'] = null;
      }
    }

    const before = this.snapshot(row);
    const updated = await this.all.$transaction(async (tx) => {
      let next: Row = row;
      if (Object.keys(data).length > 0) {
        next = (ref.source === 'platform'
          ? await tx.paymentGateway.update({ where: { id: ref.id }, data: data as Prisma.PaymentGatewayUncheckedUpdateInput })
          : await tx.tenantGatewayConfig.update({ where: { id: ref.id }, data: data as Prisma.TenantGatewayConfigUncheckedUpdateInput })) as unknown as Row;
      }
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
      return next;
    });

    const target = this.target(ref, updated, actor);
    const credentials = secretsChanged.length > 0 ? await this.writeSecrets(target, patch, actor) : await this.stateOrNull(target);
    this.logger.log(`gateway ${ref.source}:${ref.id} updated by ${actor.adminId}`);
    return this.view(ref.source, updated, credentials);
  }

  /**
   * Delete a gateway (ADR-0041 §6). A row nothing points at is deleted; one a
   * payment or a grant points at is deactivated, and its live grants withdrawn,
   * because the payments taken through it must stay explicable. Either way the
   * secrets are revoked **first**: a failure after that leaves a gateway that
   * cannot charge, never one that can.
   */
  async remove(actor: GatewayActor, ref: GatewayRef): Promise<{ id: string; source: GatewaySource; mode: 'deleted' | 'deactivated'; grantsWithdrawn: number }> {
    const owner = await this.isOwner(actor);
    const row = await this.load(ref, actor, owner);
    const pointing = ref.source === 'platform' ? { gatewayId: ref.id } : { tenantGatewayConfigId: ref.id };

    const payments = await this.all.paymentTransaction.count({ where: pointing });
    const grants = await this.all.paymentGatewayGrant.count({ where: pointing });

    await this.secrets.revoke(this.target(ref, row, actor));

    const used = payments > 0 || grants > 0;
    const withdrawnAt = new Date();
    const grantsWithdrawn = await this.all.$transaction(async (tx) => {
      let withdrawn = 0;
      if (used) {
        if (ref.source === 'platform') await tx.paymentGateway.update({ where: { id: ref.id }, data: { isActive: false } });
        else await tx.tenantGatewayConfig.update({ where: { id: ref.id }, data: { isActive: false } });
        ({ count: withdrawn } = await tx.paymentGatewayGrant.updateMany({
          where: { ...pointing, isActive: true },
          data: { isActive: false, withdrawnAt, withdrawnByAdminId: actor.adminId },
        }));
      } else if (ref.source === 'platform') {
        await tx.paymentGateway.delete({ where: { id: ref.id } });
      } else {
        await tx.tenantGatewayConfig.delete({ where: { id: ref.id } });
      }
      await tx.adminAuditLog.create({
        data: {
          tenantId: (row['tenantId'] as string | undefined) ?? actor.tenantId,
          adminId: actor.adminId,
          action: 'gateway_delete',
          targetEntityType: 'gateway',
          targetEntityId: ref.id,
          oldValue: { source: ref.source, ...this.snapshot(row) },
          newValue: { mode: used ? 'deactivated' : 'deleted', payments, grantsWithdrawn: withdrawn },
          adminIpAddress: actor.ip,
        },
      });
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
  private async isOwner(actor: GatewayActor): Promise<boolean> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
    return tenant?.tenantType === TenantType.platform_owner;
  }

  /** The row, if the caller may manage it. Anything else is not found — including before the read, for a platform row. */
  private async load(ref: GatewayRef, actor: GatewayActor, owner: boolean): Promise<Row> {
    if (ref.source === 'platform') {
      if (!owner) throw new GatewayAdminRefused('gateway_not_found', ref.id);
      const row = await this.all.paymentGateway.findUnique({ where: { id: ref.id } });
      if (!row) throw new GatewayAdminRefused('gateway_not_found', ref.id);
      return row as unknown as Row;
    }
    const row = (await this.all.tenantGatewayConfig.findUnique({ where: { id: ref.id } })) as unknown as Row | null;
    if (!row || (!owner && row['tenantId'] !== actor.tenantId)) throw new GatewayAdminRefused('gateway_not_found', ref.id);
    return row;
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

  private verification(status: string | undefined, actor: GatewayActor): Row {
    if (status === undefined) return {};
    if (!(status in TenantGatewayVerificationStatus)) throw new GatewayAdminRefused('missing_field', 'verificationStatus');
    return {
      verificationStatus: status,
      verifiedByAdminId: status === TenantGatewayVerificationStatus.verified ? actor.adminId : null,
    };
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
    for (const k of [...PLAIN_COLUMNS, ...Object.keys(ENUM_COLUMNS), 'verificationStatus', ...PLATFORM_ONLY]) {
      if (row[k] !== undefined) out[k] = row[k];
    }
    for (const k of DECIMAL_COLUMNS) if (row[k] !== undefined) out[k] = str(row[k]);
    if (row['depositPresets'] !== undefined) out['depositPresets'] = presetStrings(row['depositPresets']);
    if (row['callbackUrl'] !== undefined) out['callbackUrl'] = str(row['callbackUrl']);
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
  }

  private view(source: GatewaySource, row: Row, credentials: GatewaySecretsState | null): GatewayView {
    return {
      source,
      id: row['id'] as string,
      tenantId: source === 'tenant' ? (row['tenantId'] as string) : null,
      displayName: row['displayName'] as string,
      providerName: row['providerName'] as string,
      gatewayCategory: row['gatewayCategory'] as string,
      isActive: Boolean(row['isActive']),
      verificationStatus: source === 'tenant' ? str(row['verificationStatus']) : null,
      description: source === 'platform' ? str(row['description']) : null,
      supportedCurrencies: source === 'platform' ? (row['supportedCurrencies'] ?? []) : null,
      confirmationMode: source === 'platform' ? str(row['confirmationMode']) : null,
      minAcceptAmount: str(row['minAcceptAmount']),
      maxAcceptAmount: str(row['maxAcceptAmount']),
      feeCalculationMode: row['feeCalculationMode'] as string,
      feeType: row['feeType'] as string,
      feeValue: String(row['feeValue']),
      feeFloor: str(row['feeFloor']),
      feeCeiling: str(row['feeCeiling']),
      useLiveRate: row['useLiveRate'] !== false,
      staticRate: str(row['staticRate']),
      percentageModifier: str(row['percentageModifier']),
      fixedAmountModifier: str(row['fixedAmountModifier']),
      minRate: str(row['minRate']),
      maxRate: str(row['maxRate']),
      roundingStep: str(row['roundingStep']),
      roundingMode: str(row['roundingMode']),
      depositPresets: presetStrings(row['depositPresets']),
      callbackUrl: str(row['callbackUrl']),
      credentials,
      createdAt: row['createdAt'] as Date,
      updatedAt: row['updatedAt'] as Date,
    };
  }
}
