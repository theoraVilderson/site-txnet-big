// billing-service's client, one module per domain under `./billing/` (FE-1-h).
// This file is the address every caller and every spec's `vi.mock` names, so
// it re-exports them all and assembles `billingApi` from their parts; the
// transport and its header comment are in `./billing/client.ts`.
import { configMoveCalls } from "./billing/config-moves";
import { couponCalls } from "./billing/coupons";
import { depositCalls } from "./billing/deposit";
import { gatewayCalls } from "./billing/gateways";
import { grantCalls } from "./billing/grants";
import { manualPaymentCalls } from "./billing/manual-payments";
import { transferCalls } from "./billing/manual-transfer";
import { panelGroupCalls } from "./billing/panel-groups";
import { renewalCalls } from "./billing/renewal";
import { shopCalls } from "./billing/shop";
import { systemsCalls } from "./billing/systems";
import { walletCalls } from "./billing/wallet";

export type { CursorPage, Paged } from "./billing/client";
export * from "./billing/config-move-jobs";
export * from "./billing/config-actions";
export * from "./billing/config-moves";
export * from "./billing/coupons";
export * from "./billing/deposit";
export * from "./billing/gateways";
export * from "./billing/grant-group-moves";
export * from "./billing/grants";
export * from "./billing/manual-payments";
export * from "./billing/manual-transfer";
export * from "./billing/migration-runs";
export * from "./billing/panel-groups";
export * from "./billing/renewal";
export * from "./billing/reseller-grants";
export * from "./billing/self-move-settings";
export * from "./billing/shop";
export * from "./billing/systems";
export * from "./billing/wallet";

/** Every billing call for the caller's own scope, one object as before the split. */
export const billingApi = {
  ...walletCalls,
  ...depositCalls,
  ...shopCalls,
  ...renewalCalls,
  ...grantCalls,
  ...configMoveCalls,
  ...manualPaymentCalls,
  ...transferCalls,
  ...systemsCalls,
  ...panelGroupCalls,
  ...gatewayCalls,
  ...couponCalls,
};
