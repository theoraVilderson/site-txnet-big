import { foldToOneSpelling } from '@txnet-backend/shared-core';

/**
 * A manual top-up method's descriptor (F-803-b, D-60, billing
 * contract.manual-transfer.md "Method kinds"). A kind is one file under
 * `kinds/` and one line in `manual-methods.ts`; nothing else switches on it —
 * no schema change, no route (principle 2).
 */

/** A stored field value: what lands in `manual_destination.fields` or a proof. */
export type FieldValue = string | number;

/** Why one field was refused — the panel says which field and why. */
export type FieldRefusal = 'missing' | 'invalid' | 'checksum' | 'unknown_field';

/** One field's validator: the value as stored, or why not. */
export type FieldCheck = (raw: unknown) => { value: FieldValue } | { refused: Exclude<FieldRefusal, 'missing' | 'unknown_field'> };

/** How the panel renders and collects a field (F-803-g, F-803-i). */
export type FieldType = 'text' | 'digits' | 'integer' | 'image' | 'instant';

export interface ManualField {
  id: string;
  type: FieldType;
  check: FieldCheck;
  /** Absent is refused unless the field is optional (or has a `fallback`). */
  optional?: boolean;
}

export interface DestinationField extends ManualField {
  /** Shown to the payer, and so copied into the payment's snapshot (F-803-d). */
  public: boolean;
  /** A value derived from the other fields when none is given (a card's bank from its BIN). */
  fallback?: (fields: Readonly<Record<string, FieldValue>>) => FieldValue;
}

/** The destination fields, already checked. */
export type DestinationFields = Readonly<Record<string, FieldValue>>;

export interface ManualMethod {
  /** The registry id `manual_gateway_setting.kind` stores — `^[a-z][a-z0-9_]{1,39}$` (CHECK). */
  kind: string;
  destinationFields: readonly DestinationField[];
  /** What a seller may require of the payer; `requiredProof` picks from these ids (D-60 part 4). */
  proofFields: readonly ManualField[];
  /** The proof field that is an external reference, kept once in `transfer_tx_ref` (F-805-a). */
  refProofField: string;
  /** `transfer_tx_ref.network` for this destination: one reference credits once inside it. */
  refNetwork: (fields: DestinationFields) => string;
  /** What the payer is charged in, and its minor-unit places. */
  chargeCurrency: (fields: DestinationFields) => string;
  chargeDecimals: (fields: DestinationFields) => number;
  /** The smallest amount offset a unique amount may add, in minor units (F-804, later). */
  uniqueStep: (fields: DestinationFields) => bigint;
  /** The watcher that can see a transfer to this destination, or null: none yet (F-803-f, later). */
  watcherFor: (fields: DestinationFields) => string | null;
}

/** A trimmed string of `min..max` characters matching `pattern`, after `fold`. */
export function textCheck(o: { pattern: RegExp; max: number; fold?: (text: string) => string }): FieldCheck {
  return (raw) => {
    if (typeof raw !== 'string') return { refused: 'invalid' };
    const value = (o.fold ?? ((t: string) => t))(raw.trim());
    return value.length <= o.max && o.pattern.test(value) ? { value } : { refused: 'invalid' };
  };
}

/** Typed digits in any script, spaces and dashes dropped — what a person copies from a banking app. */
export function foldDigits(text: string): string {
  return foldToOneSpelling(text).replace(/[\s-]/g, '');
}

/** An object-storage key from the proof upload (F-805-a checks it is the tenant's own). */
const STORAGE_KEY_MAX = 512;

/** The receipt screenshot, which every kind may ask for. */
export const RECEIPT_IMAGE: ManualField = {
  id: 'receiptImage',
  type: 'image',
  check: textCheck({ pattern: /^[\w./-]+$/, max: STORAGE_KEY_MAX }),
};

/** When the payer says they paid, as an ISO-8601 instant (C-37). */
export const PAID_AT: ManualField = {
  id: 'paidAt',
  type: 'instant',
  check: (raw) => (typeof raw === 'string' && !Number.isNaN(Date.parse(raw)) ? { value: new Date(raw).toISOString() } : { refused: 'invalid' }),
};
