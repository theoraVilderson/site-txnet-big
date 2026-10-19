import type { ResellerAccessRejection } from '@txnet-backend/shared-core';

/** Why a person's act on an open payment was refused (F-092-z, F-092-af, F-805-a/b) — `ManualConfirmService`'s, mapped to a status by its controller. */

/**
 * `not_open`: the payment is `success` or `failed` — settled, not a person's to
 * reopen (F-092-af; `not_verifying` before it). `authority_present` and
 * `authority_taken` answer attaching an authority (F-092-af).
 */
export type ManualConfirmRejection =
  | 'payment_not_found'
  | 'not_open'
  | 'authority_present'
  | 'authority_taken'
  /** F-805-a: the transfer's reference was credited to another payment since its proof arrived. */
  | 'duplicate_ref'
  /** F-805-a: `resubmit` on a payment with no proof to return, or one already returned once. */
  | 'cannot_return'
  /** F-805-b: a confirmation with no reference typed, on a payment that is no transfer — only a transfer's payer gave one. */
  | 'reference_required'
  /** F-805-b: no proof names a receipt, or its file is gone. */
  | 'receipt_missing';

export class ManualConfirmRefused extends Error {
  constructor(readonly reason: ManualConfirmRejection, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'ManualConfirmRefused';
  }
}

/** The named-reseller door's refusal (F-093-v); a refusal of the work itself stays {@link ManualConfirmRefused}. */
export class ResellerManualConfirmRefused extends Error {
  constructor(
    readonly reason: ResellerAccessRejection,
    tenantId: string,
  ) {
    super(`${reason}: ${tenantId}`);
    this.name = 'ResellerManualConfirmRefused';
  }
}
