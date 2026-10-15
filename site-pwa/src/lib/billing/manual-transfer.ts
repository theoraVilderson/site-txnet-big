// A manual-transfer gateway — card-to-card, a wallet, a later kind (F-803, billing/contract.manual-transfer.md).

/** The provider a manual gateway is stored under (D-60 part 1): the one place it is spelled (C-18). */
export const MANUAL_PROVIDER = "manual_transfer";
/** The gateway category that goes with {@link MANUAL_PROVIDER}, always together (`manual_setting_mismatch`). */
export const MANUAL_CATEGORY = "manual";

/** Billing's `ConfirmationMode` (C-09): who settles a payment through the gateway. */
export const CONFIRMATION_MODES = ["automatic", "manual_admin_required"] as const;
export type ConfirmationMode = (typeof CONFIRMATION_MODES)[number];
/** The mode every manual gateway has until a watcher exists (F-803-f; contract principle 7). */
export const CONFIRMED_BY_PERSON: ConfirmationMode = "manual_admin_required";

/** The payer's window, in minutes — billing's `WINDOW_MINUTES` (the migration's CHECK and default). */
export const WINDOW_MINUTES = { min: 10, max: 1440, default: 30 } as const;
/** Destinations one gateway may hold — billing's `MAX_DESTINATIONS`. */
export const MAX_DESTINATIONS = 50;
/** A destination's rotation weight bounds (F-807, stored and unread until then). */
export const DESTINATION_WEIGHT = { min: 1, max: 100, default: 1 } as const;

/** Whether a gateway is a manual one, by its provider (C-18). */
export const isManualProvider = (providerName: string | null | undefined): boolean => providerName === MANUAL_PROVIDER;

/**
 * Whether a gateway settles itself: any non-manual gateway, and a manual one
 * whose mode is `automatic` (none until F-803-f). A list that carries no mode
 * (the tenant top-up's) is gateways that settle themselves.
 */
export const settlesItself = (g: { confirmationMode?: ConfirmationMode | null }): boolean => g.confirmationMode !== CONFIRMED_BY_PERSON;

/** A field value as billing stores it in `manual_destination.fields` or a snapshot. */
export type TransferFieldValue = string | number;

/** A manual gateway's own settings, on every gateway admin view (`manual`, F-803-c); `null` on any other. */
export interface ManualSetting {
  kind: string;
  confirmationMode: ConfirmationMode;
  requiredProof: string[];
  windowMinutes: number;
  destinations: number;
  activeDestinations: number;
}

/** The writable part of {@link ManualSetting}: required whole on create, partial on update. */
export type ManualSettingBody = Partial<Pick<ManualSetting, "kind" | "confirmationMode" | "requiredProof" | "windowMinutes">>;

/** A card or wallet a manual gateway's payer is shown, as the seller's editor reads it — private fields included. */
export interface ManualDestination {
  id: string;
  label: string;
  fields: Record<string, TransferFieldValue>;
  isActive: boolean;
  sortOrder: number;
  weight: number;
  /** Minor units of the charge currency; `null` is no cap. */
  dailyCapMinor: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DestinationBody = Partial<Pick<ManualDestination, "label" | "fields" | "isActive" | "sortOrder" | "weight" | "dailyCapMinor">>;

/**
 * What `deposit/start` answers for a manual gateway (F-803-d), and `GET
 * …/transfer` re-reads: the public destination fields frozen at start, the
 * exact amount in the charge currency's minor units, and the window.
 */
export interface TransferInstructions {
  kind: string;
  destination: Record<string, TransferFieldValue>;
  amountMinor: string;
  currencyCode: string;
  decimals: number;
  windowEndsAt: string;
  requiredProof: string[];
  confirmationMode: ConfirmationMode;
}
