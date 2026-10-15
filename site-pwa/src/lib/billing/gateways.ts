// Payment gateways: the caller's own or a named reseller's, and the platform's links (ADR-0041).
import { call } from "./client";
import type { DestinationBody, ManualDestination, ManualSetting, ManualSettingBody } from "./manual-transfer";

/**
 * Where a gateway call goes: the ambient surface, which configures the
 * caller's **own** tenant, or the one that names a reseller in the path
 * (F-066-w3, `billing/contract.gateways.md`). The two are shaped identically,
 * `:source/:id` included, so one client serves both.
 *
 * The panel's gateway screens pick by surface, never by who is signed in: a
 * reseller's owner signs in to the platform owner's tenant (ADR-0059), so the
 * ambient path would configure the platform's gateways while answering 200.
 */
export const gatewayApiPrefix = (tenantId: string | null) =>
  tenantId === null ? "/gateways" : `/tenants/${encodeURIComponent(tenantId)}/gateways`;

/** The tenant's default quick amounts, and the currency they are in (F-116-h2). */
export interface DepositPresets {
  presets: string[];
  currencyCode: string;
}

/** The calls both gateway surfaces answer. `GatewaysView` takes one of these, not `billingApi`. */
export interface GatewayAdminApi {
  list(): Promise<AdminGateway[]>;
  create(body: CreateGatewayBody): Promise<AdminGateway>;
  update(source: GatewaySource, id: string, body: UpdateGatewayBody): Promise<AdminGateway>;
  remove(source: GatewaySource, id: string): Promise<GatewayRemoved>;
  presets(): Promise<DepositPresets>;
  setPresets(presets: string[]): Promise<DepositPresets>;
  /** The tenant's default tax on a top-up (F-104-ag); `null` is no tax. */
  tax(): Promise<{ taxRatePercent: string | null }>;
  setTax(taxRatePercent: string | null): Promise<{ taxRatePercent: string | null }>;
  /** Who it is offered to (F-102-g): the owner's groups, replaced whole; `[]` = everyone. */
  setAudience(source: GatewaySource, id: string, userGroupIds: string[]): Promise<{ userGroupIds: string[] }>;
  /** A manual gateway's cards or wallets (F-803-c), in their sort order, private fields included. */
  destinations(source: GatewaySource, id: string): Promise<ManualDestination[]>;
  /** `fields` is checked by the gateway's kind: `invalid_destination` names each refused field in `error.facts`. */
  createDestination(source: GatewaySource, id: string, body: DestinationBody & { label: string; fields: ManualDestination["fields"] }): Promise<ManualDestination>;
  updateDestination(source: GatewaySource, id: string, destinationId: string, body: DestinationBody): Promise<ManualDestination>;
  /** `deactivated` once a payment showed it — its snapshot and review need the row. */
  removeDestination(source: GatewaySource, id: string, destinationId: string): Promise<{ id: string; mode: "deleted" | "deactivated" }>;
}

/**
 * The gateway calls for one surface: `null` for the caller's own tenant
 * (F-102-d), a tenant id for the reseller the path names (F-066-w4). Billing
 * still decides everything — this only chooses which tenant is being asked
 * about.
 */
export function gatewayAdminApi(tenantId: string | null): GatewayAdminApi {
  const at = gatewayApiPrefix(tenantId);
  const row = (source: GatewaySource, id: string) => `${at}/${source}/${encodeURIComponent(id)}`;
  return {
    list: () => call<AdminGateway[]>(at, { method: "GET" }),
    create: (body) => call<AdminGateway>(at, { method: "POST", body: JSON.stringify(body) }),
    update: (source, id, body) => call<AdminGateway>(row(source, id), { method: "PATCH", body: JSON.stringify(body) }),
    remove: (source, id) => call<GatewayRemoved>(row(source, id), { method: "DELETE" }),
    presets: () => call<DepositPresets>(`${at}/presets`, { method: "GET" }),
    setPresets: (presets) => call<DepositPresets>(`${at}/presets`, { method: "PUT", body: JSON.stringify({ presets }) }),
    tax: () => call<{ taxRatePercent: string | null }>(`${at}/tax`, { method: "GET" }),
    setTax: (taxRatePercent) =>
      call<{ taxRatePercent: string | null }>(`${at}/tax`, { method: "PUT", body: JSON.stringify({ taxRatePercent }) }),
    setAudience: (source, id, userGroupIds) =>
      call<{ userGroupIds: string[] }>(`${row(source, id)}/audience`, { method: "PUT", body: JSON.stringify({ userGroupIds }) }),
    destinations: (source, id) => call<ManualDestination[]>(`${row(source, id)}/destinations`, { method: "GET" }),
    createDestination: (source, id, body) =>
      call<ManualDestination>(`${row(source, id)}/destinations`, { method: "POST", body: JSON.stringify(body) }),
    updateDestination: (source, id, destinationId, body) =>
      call<ManualDestination>(`${row(source, id)}/destinations/${encodeURIComponent(destinationId)}`, { method: "PATCH", body: JSON.stringify(body) }),
    removeDestination: (source, id, destinationId) =>
      call<{ id: string; mode: "deleted" | "deactivated" }>(`${row(source, id)}/destinations/${encodeURIComponent(destinationId)}`, { method: "DELETE" }),
  };
}

/** The caller's own gateways — what `billingApi`'s six gateway calls have always been. */
export const ambientGatewayApi = gatewayAdminApi(null);

/** Which table a gateway row is in — the pair `source` + `id` names a row (D-25). */
export type GatewaySource = "platform" | "tenant";

/** The secrets a gateway can carry (F-102-a, F-104-c) — billing's `GATEWAY_SECRET_NAMES`. */
export type GatewaySecretName = "merchantId" | "secretKey" | "webhookSecret";

/** Whether one secret is stored. There is no field that could carry its value. */
export interface GatewaySecretState {
  configured: boolean;
  version: number | null;
  rotatedAt: string | null;
}

/** A gateway as `GET /gateways` answers it (`billing` F-102-c). Decimals are strings (C-02). */
export interface AdminGateway {
  source: GatewaySource;
  id: string;
  /** The owning tenant; `null` for a platform gateway. */
  tenantId: string | null;
  displayName: string;
  providerName: string;
  gatewayCategory: string;
  isActive: boolean;
  /** The platform owner's block (F-104-ak); `null` when not blocked, and always for a platform gateway. */
  blocked: { at: string; reason: string } | null;
  description: string | null;
  supportedCurrencies: unknown;
  confirmationMode: string | null;
  /** `null` is no limit on that side. */
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
  /** This gateway's own quick amounts; empty inherits the tenant's default (F-092-v). */
  depositPresets: string[];
  /** The callback address sent to the provider; `null` = the tenant's panel domain (F-092-w). */
  callbackUrl: string | null;
  /** Tax on a top-up through this gateway, a percentage; `null` inherits the tenant's default (ADR-0076). */
  taxRatePercent: string | null;
  /** The gateway's own currency: what its limits, fixed fee, fixed modifier and presets are in (F-116-h2). */
  currencyCode: string;
  /** `null` when billing could not ask the vault; the row is still manageable. */
  credentials: Record<GatewaySecretName, GatewaySecretState> | null;
  /** The secrets its provider needs that are not stored: saved, maybe active, and cannot take a payment yet (F-104-e). `null` with `credentials`. */
  missingSecrets: GatewaySecretName[] | null;
  createdAt: string;
  updatedAt: string;
  /** The owner's user groups it is offered to; empty = everyone (F-102-g). */
  userGroupIds: string[];
  /** A manual gateway's kind, mode, proof, window and destination counts (F-803-c); `null` for any other. */
  manual: ManualSetting | null;
}

type GatewayFieldsBody = {
  displayName?: string;
  providerName?: string;
  gatewayCategory?: string;
  isActive?: boolean;
  minAcceptAmount?: string | null;
  maxAcceptAmount?: string | null;
  feeCalculationMode?: string;
  feeType?: string;
  feeValue?: string;
  feeFloor?: string | null;
  feeCeiling?: string | null;
  /** Platform owner, tenant gateway, edit only (F-104-ak): a reason blocks it, `null` lifts the block. */
  blockedReason?: string | null;
  depositPresets?: string[];
  callbackUrl?: string | null;
  /** `null` inherits the tenant's default tax (ADR-0076). */
  taxRatePercent?: string | null;
  /** A Telegram Stars gateway's USD value per Star, with the live rate off (F-104-e). */
  staticRate?: string | null;
  useLiveRate?: boolean;
  /** Write-only. Sent when typed, never read back. */
  merchantId?: string;
  secretKey?: string;
  webhookSecret?: string;
  /** A manual gateway's setting (F-803-c): whole on create, the changed keys on update. */
  manual?: ManualSettingBody;
};

export type CreateGatewayBody = GatewayFieldsBody & { source: GatewaySource; tenantId?: string };

export type UpdateGatewayBody = GatewayFieldsBody;

export interface GatewayRemoved {
  id: string;
  source: GatewaySource;
  mode: "deleted" | "deactivated";
  grantsWithdrawn: number;
}

/** Every reason `/settlement/*` can refuse with (`settlement.service.ts` `SettlementRejection`). */
export type SettlementRejection =
  | "not_platform_owner"
  | "gateway_not_found"
  | "tenant_not_found"
  | "grant_to_owner"
  | "gateway_not_grantable"
  | "already_granted"
  | "grant_not_found"
  | "already_withdrawn"
  | "amount_not_positive"
  | "exceeds_outstanding";

/** A link of one gateway to one borrowing tenant (`audit/contract.settlement.md`). */
export interface GatewayGrant {
  id: string;
  tenantId: string;
  gatewayId: string | null;
  tenantGatewayConfigId: string | null;
  isActive: boolean;
  note: string | null;
  grantedAt: string;
  withdrawnAt: string | null;
}

export type CreateGatewayGrantBody = {
  tenantId: string;
  gatewayId?: string;
  tenantGatewayConfigId?: string;
  note?: string;
};

/** Gateway calls for the caller's own tenant — spread into `billingApi` (`lib/billing-api.ts`). */
export const gatewayCalls = {
  // The six gateway calls are {@link ambientGatewayApi}'s, kept here under
  // their old names for the pages that ask about the caller's own tenant and
  // nothing else (the coupon form's gateway picker). A screen that configures
  // a named reseller takes a `GatewayAdminApi` instead.
  async adminGateways(): Promise<AdminGateway[]> {
    return ambientGatewayApi.list();
  },

  /** Every link (grant) the platform has made. Platform owner only; anyone else is refused 403. */
  async gatewayGrants(): Promise<GatewayGrant[]> {
    return call<GatewayGrant[]>("/settlement/grants", { method: "GET" });
  },

  /** Link a gateway to a tenant that does not own it (ADR-0041). */
  async createGatewayGrant(body: CreateGatewayGrantBody): Promise<{ id: string }> {
    return call<{ id: string }>("/settlement/grants", { method: "POST", body: JSON.stringify(body) });
  },

  /** Unlink: the grant is withdrawn, never deleted. */
  async withdrawGatewayGrant(id: string): Promise<{ id: string }> {
    return call<{ id: string }>(`/settlement/grants/${encodeURIComponent(id)}/withdraw`, { method: "POST" });
  },
};
