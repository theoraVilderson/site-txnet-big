/**
 * Why gateway management refused (F-102-b, F-803-c). Its own file so the
 * manual-gateway rules under `payment/manual/` throw the same refusal the
 * service does without importing the service.
 */
export type GatewayAdminRejection =
  | 'not_platform_owner'
  | 'gateway_not_found'
  | 'tenant_not_found'
  | 'block_is_platform_owners'
  | 'gateway_blocked'
  | 'provider_already_configured'
  | 'invalid_range'
  | 'missing_field'
  | 'invalid_presets'
  | 'invalid_callback'
  | 'gateway_has_open_payments'
  /** F-102-g: a group named for a gateway's audience is not its owner's. */
  | 'group_not_found'
  | 'audience_not_allowed'
  /** F-803-c: provider `manual_transfer`, category `manual` and a `manual` body go together or not at all. */
  | 'manual_setting_mismatch'
  /** F-803-c: a `manual` body naming an unknown kind, a proof field the kind lacks, or a window outside 10..1440. */
  | 'invalid_manual_setting'
  /** F-803-c: automatic confirmation needs a watcher for every active destination; a fee quote needs a provider. */
  | 'automatic_unavailable'
  /** F-803-c: the kind of a gateway with destinations is fixed — their fields were checked by it. */
  | 'kind_in_use'
  /** F-803-c: a destination's fields refused by its kind; `refusals` names each. */
  | 'invalid_destination'
  | 'destination_not_found';

/** One refused field of a destination, as the kind named it (F-803-b). */
export type FieldRefusalDetail = { field: string; reason: string };

/** A refusal. Its message names the rule and a row id, never a value. */
export class GatewayAdminRefused extends Error {
  constructor(
    readonly reason: GatewayAdminRejection,
    detail?: string,
    /** For `invalid_destination`: every refused field, so the editor marks them all at once. */
    readonly refusals?: readonly FieldRefusalDetail[],
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'GatewayAdminRefused';
  }
}
