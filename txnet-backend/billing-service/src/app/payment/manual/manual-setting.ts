import { ConfirmationMode, FeeCalcMode, GatewayCategory, PaymentProviderName, Prisma } from '@prisma/client';

import { GatewayAdminRefused } from '../gateway-admin/gateway-admin.refusal';
import type { GatewaySource } from '../gateway/gateway-merchant';
import type { DestinationFields, ManualMethod } from './manual-method';
import { manualMethod, parseDestination } from './manual-methods';

/**
 * A manual gateway's own settings, as gateway admin writes them (F-803-c,
 * contract.manual-transfer.md "Gateway admin"): the `manual` body of a
 * gateway's create and update, checked here and saved in the same transaction
 * and audit row as the gateway itself (principle 1 — not a second system).
 */

/** The `manual` body as it travels; every key optional on update. */
export type ManualSettingInput = { kind?: string; confirmationMode?: string; requiredProof?: string[]; windowMinutes?: number };

/** A setting's values, settled: what `manual_gateway_setting` stores. */
export type ManualSettingValues = { kind: string; confirmationMode: string; requiredProof: string[]; windowMinutes: number };

/** The gateway columns the manual rules read, as the row will be. */
type GatewayShape = { providerName?: string; gatewayCategory?: string; feeCalculationMode?: string };

/** The window the payer has, in minutes — the migration's CHECK and default (F-803-a). */
export const WINDOW_MINUTES = { min: 10, max: 1440, default: 30 } as const;

/** Destinations one gateway may hold: a seller rotates a handful of cards, never hundreds (C-28). */
export const MAX_DESTINATIONS = 50;

/**
 * A gateway row that may be offered, as far as the manual rule goes: any
 * other provider, or a manual one with an active destination (F-803-c) — one
 * with nothing to pay into is never shown, a manager testing included.
 */
export const HAS_DESTINATION_IF_MANUAL = {
  OR: [{ providerName: { not: PaymentProviderName.manual_transfer } }, { manualSetting: { destinations: { some: { isActive: true } } } }],
};

/** Whether a gateway is a manual one (D-60): the one place the provider is compared (C-18). */
export function isManualProvider(providerName: unknown): boolean {
  return providerName === PaymentProviderName.manual_transfer;
}

/**
 * Provider `manual_transfer`, category `manual` and a `manual` body go
 * together (principle 1). `providerBefore` is the stored provider on an
 * update: a gateway never becomes or stops being manual, which would leave a
 * setting with no gateway to serve or a gateway with no setting. An automatic
 * fee is refused — no provider is there to quote one.
 */
export function checkManualShape(gateway: GatewayShape, manual: ManualSettingInput | undefined, providerBefore?: string): void {
  const isManual = isManualProvider(gateway.providerName);
  if (isManual !== (gateway.gatewayCategory === GatewayCategory.manual)) {
    throw new GatewayAdminRefused('manual_setting_mismatch', 'provider manual_transfer and category manual go together');
  }
  if (providerBefore !== undefined && isManual !== isManualProvider(providerBefore)) {
    throw new GatewayAdminRefused('manual_setting_mismatch', 'a gateway does not change to or from manual_transfer');
  }
  if (!isManual && manual !== undefined) throw new GatewayAdminRefused('manual_setting_mismatch', 'a manual body on a gateway that is not manual_transfer');
  if (isManual && manual === undefined && providerBefore === undefined) throw new GatewayAdminRefused('missing_field', 'manual');
  if (isManual && gateway.feeCalculationMode === FeeCalcMode.automatic) {
    throw new GatewayAdminRefused('automatic_unavailable', 'feeCalculationMode: a manual gateway has no provider to quote a fee');
  }
}

/** The kind a setting names, registered — or the refusal naming it. */
export function methodOf(kind: string | undefined): ManualMethod {
  if (!kind) throw new GatewayAdminRefused('missing_field', 'manual.kind');
  const method = manualMethod(kind);
  if (!method) throw new GatewayAdminRefused('invalid_manual_setting', `manual.kind ${kind} is not a registered kind`);
  return method;
}

/**
 * `automatic` only when every active destination has a watcher that can see
 * a transfer to it (principle 4) — and at least one does, or nothing would be
 * watched. No kind has a watcher yet, so today it is always refused (principle 7).
 */
export function assertAutomaticPossible(method: ManualMethod, confirmationMode: string, active: readonly DestinationFields[]): void {
  if (confirmationMode !== ConfirmationMode.automatic) return;
  if (active.length === 0 || active.some((fields) => method.watcherFor(fields) === null)) {
    throw new GatewayAdminRefused('automatic_unavailable', 'confirmationMode: an active destination has no watcher');
  }
}

/** `before` patched by `patch`, every value checked; `active` is the active destinations' fields. */
export function settleManualSetting(before: ManualSettingValues | null, patch: ManualSettingInput, active: readonly DestinationFields[]): ManualSettingValues {
  const method = methodOf(patch.kind ?? before?.kind);
  const next: ManualSettingValues = {
    kind: method.kind,
    confirmationMode: patch.confirmationMode ?? before?.confirmationMode ?? ConfirmationMode.manual_admin_required,
    requiredProof: [...new Set(patch.requiredProof ?? before?.requiredProof ?? [])],
    windowMinutes: patch.windowMinutes ?? before?.windowMinutes ?? WINDOW_MINUTES.default,
  };
  const declared = new Set(method.proofFields.map((f) => f.id));
  const foreign = next.requiredProof.find((id) => !declared.has(id));
  if (foreign) throw new GatewayAdminRefused('invalid_manual_setting', `manual.requiredProof ${foreign} is not a ${method.kind} proof field`);
  if (!Number.isInteger(next.windowMinutes) || next.windowMinutes < WINDOW_MINUTES.min || next.windowMinutes > WINDOW_MINUTES.max) {
    throw new GatewayAdminRefused('invalid_manual_setting', `manual.windowMinutes must be ${WINDOW_MINUTES.min}..${WINDOW_MINUTES.max}`);
  }
  if (!(next.confirmationMode in ConfirmationMode)) throw new GatewayAdminRefused('invalid_manual_setting', 'manual.confirmationMode');
  assertAutomaticPossible(method, next.confirmationMode, active);
  return next;
}

/** A destination's fields as its kind checked them, or `invalid_destination` naming every refused field. */
export function checkedDestination(method: ManualMethod, input: unknown): DestinationFields {
  const parsed = parseDestination(method, input);
  // `in`, not `.ok`: this project's non-strict tsconfig does not narrow on a boolean tag.
  if ('refusals' in parsed) throw new GatewayAdminRefused('invalid_destination', method.kind, parsed.refusals);
  return parsed.fields;
}

/** The setting's row, with what its view and its checks need. Bounded by {@link MAX_DESTINATIONS}. */
export const MANUAL_SETTING_SELECT = {
  id: true,
  kind: true,
  confirmationMode: true,
  requiredProof: true,
  windowMinutes: true,
  destinations: { select: { isActive: true, fields: true }, take: MAX_DESTINATIONS },
} satisfies Prisma.ManualGatewaySettingSelect;
export type ManualSettingRow = Prisma.ManualGatewaySettingGetPayload<{ select: typeof MANUAL_SETTING_SELECT }>;

/** What a gateway view says of its manual setting (F-803-g reads it); `null` for any other gateway. */
export type ManualSettingView = ManualSettingValues & { destinations: number; activeDestinations: number };

export function manualSettingView(row: ManualSettingRow | null | undefined): ManualSettingView | null {
  if (!row) return null;
  const { kind, confirmationMode, requiredProof, windowMinutes, destinations } = row;
  return { kind, confirmationMode, requiredProof, windowMinutes, destinations: destinations.length, activeDestinations: destinations.filter((d) => d.isActive).length };
}

/** A gateway's setting row is found by the gateway column its table uses (F-803-a: exactly one is set). */
export function settingWhere(ref: { source: GatewaySource; id: string }): Prisma.ManualGatewaySettingWhereInput {
  return ref.source === 'platform' ? { gatewayId: ref.id } : { tenantGatewayConfigId: ref.id };
}

/** The fields a stored destination holds — validated JSON object by the migration's CHECK. */
export const fieldsOf = (fields: Prisma.JsonValue): DestinationFields => fields as DestinationFields;

/**
 * Writes the `manual` body of a manual gateway's create or update, inside the
 * gateway's own transaction, and answers the row as it now is (`null` for a
 * gateway that is not manual). `ownerTenantId` is the gateway's owner — the
 * platform owner for a platform gateway — which the trigger holds too. A kind
 * is fixed once destinations exist: their fields were checked by it.
 */
export async function saveManualSetting(
  tx: Prisma.TransactionClient,
  gateway: { source: GatewaySource; id: string; ownerTenantId: string; providerName: unknown },
  patch: ManualSettingInput | undefined,
): Promise<ManualSettingRow | null> {
  if (!isManualProvider(gateway.providerName)) return null;
  const before = await tx.manualGatewaySetting.findFirst({ where: settingWhere(gateway), select: MANUAL_SETTING_SELECT });
  if (patch === undefined && before) return before;
  // Before the settle: a new kind would refuse the old proof ids first, and hide why.
  if (before && patch?.kind !== undefined && patch.kind !== before.kind && before.destinations.length > 0) throw new GatewayAdminRefused('kind_in_use', gateway.id);
  const active = (before?.destinations ?? []).filter((d) => d.isActive).map((d) => fieldsOf(d.fields));
  const next = settleManualSetting(before, patch ?? {}, active);
  const data = { ...next, confirmationMode: next.confirmationMode as ConfirmationMode };
  if (before) return tx.manualGatewaySetting.update({ where: { id: before.id }, data, select: MANUAL_SETTING_SELECT });
  const column = gateway.source === 'platform' ? { gatewayId: gateway.id } : { tenantGatewayConfigId: gateway.id };
  return tx.manualGatewaySetting.create({ data: { ...data, ...column, tenantId: gateway.ownerTenantId }, select: MANUAL_SETTING_SELECT });
}
