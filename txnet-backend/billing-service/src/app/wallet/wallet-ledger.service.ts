/**
 * The wallet ledger moved to `shared-core` with F-019-h (ADR-0061): a
 * reseller purchase in `tenant-service` debits a user's wallet in the same
 * transaction that creates the reseller. This path stays so no caller changes.
 * Wallet holds (F-118-a) sit beside it there, and are re-exported here too.
 */
export type { LedgerEntry } from '@txnet-backend/shared-core';
export type { CaptureEntry, HoldEntry, ReleaseEntry } from '@txnet-backend/shared-core';
export {
  HoldExceeded,
  InsufficientFunds,
  InvalidLedgerAmount,
  LedgerCurrencyMismatch,
  WalletHoldService,
  WalletLedgerService,
  WalletVersionConflict,
} from '@txnet-backend/shared-core';
