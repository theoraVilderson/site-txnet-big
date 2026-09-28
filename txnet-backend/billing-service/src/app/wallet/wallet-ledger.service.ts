/**
 * The wallet ledger moved to `shared-core` with F-019-h (ADR-0061): a
 * reseller purchase in `tenant-service` debits a user's wallet in the same
 * transaction that creates the reseller. This path stays so no caller changes.
 */
export type { LedgerEntry } from '@txnet-backend/shared-core';
export {
  InsufficientFunds,
  InvalidLedgerAmount,
  LedgerCurrencyMismatch,
  WalletLedgerService,
  WalletVersionConflict,
} from '@txnet-backend/shared-core';
