import { BadGatewayException, HttpException, NotFoundException } from '@nestjs/common';

import { refusalException } from '../../request/refusal-exception';
import type { GatewaySource } from '../gateway/gateway-merchant';
import { type FieldRefusalDetail, GatewayAdminRefused, type GatewayAdminRejection } from './gateway-admin.refusal';
import { ResellerGatewayRefused, type ResellerGatewayRejection } from './reseller-gateway.service';
import { GatewaySecretsRefused, GatewaySecretsUnavailable } from './vault-secret.client';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const GATEWAY_ADMIN_REFUSAL_STATUS: Record<GatewayAdminRejection, 400 | 403 | 404 | 409> = {
  not_platform_owner: 403,
  block_is_platform_owners: 403,
  gateway_blocked: 409,
  gateway_not_found: 404,
  tenant_not_found: 404,
  provider_already_configured: 409,
  gateway_has_open_payments: 409,
  group_not_found: 404,
  audience_not_allowed: 403,
  invalid_range: 400,
  missing_field: 400,
  invalid_presets: 400,
  invalid_callback: 400,
  manual_setting_mismatch: 400,
  invalid_manual_setting: 400,
  automatic_unavailable: 400,
  kind_in_use: 409,
  invalid_destination: 400,
  destination_not_found: 404,
};

/** Both doors of the named-reseller surface: who may configure this reseller, then the ambient statuses, so one client reads both. */
const STATUS: Record<ResellerGatewayRejection, 400 | 403 | 404 | 409> = {
  // ResellerAccess (invariant 21).
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
  ...GATEWAY_ADMIN_REFUSAL_STATUS,
};

/**
 * The one place gateway management turns a refusal into a status, for every
 * gateway-admin controller (F-102-c, F-066-w3, F-803-c). The reason travels
 * in the body — naming the rule is what the operator needs — and a
 * destination's refused fields as `error.facts`, `{field: reason}` (the
 * envelope's one channel for a refusal's figures, F-111-e). A vault seam that is down is a
 * 502 with no detail: its message is about the other process and is logged
 * there, not shown here.
 */
export async function refusing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof GatewaySecretsRefused) throw new HttpException({ reason: e.reason, message: e.message }, e.status);
    if (e instanceof GatewaySecretsUnavailable) throw new BadGatewayException({ reason: 'secrets_unavailable', message: 'the credential vault could not be reached' });
    if (!(e instanceof GatewayAdminRefused) && !(e instanceof ResellerGatewayRefused)) throw e;
    throw refusalException(STATUS[e.reason], { reason: e.reason, message: e.message, ...(e.refusals ? { facts: factsOf(e.refusals) } : {}) });
  }
}

/** Each refused field as one fact, `{cardNumber: 'checksum'}`, so the editor marks them all at once. */
const factsOf = (refusals: readonly FieldRefusalDetail[]): Record<string, string> => Object.fromEntries(refusals.map((r) => [r.field, r.reason]));

/** A `:source` path segment (D-25): the two gateway tables can share an id, so only the pair names a row. */
export function gatewaySource(value: string): GatewaySource {
  if (value !== 'platform' && value !== 'tenant') throw new NotFoundException();
  return value;
}
