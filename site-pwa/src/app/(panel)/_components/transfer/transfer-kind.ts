import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * One manual method kind as the panel draws it (contract.manual-transfer.md
 * principle 1): a file under `kinds/` and one line in `transfer-kinds.ts`.
 * It mirrors billing's `ManualMethod` descriptor, which is the rule; this is
 * how the rule is asked for and shown. F-803-i/j add the payer's `Destination`
 * and `ProofField` beside `AdminFields`.
 */

/** Why billing refused one field — `invalid_destination`'s `error.facts` values (billing `FieldRefusal`). */
export type FieldRefusal = "missing" | "invalid" | "checksum" | "unknown_field";

/** A destination's fields as the seller's editor holds them: every value a string, as typed. */
export type DestinationDraft = Record<string, string>;
export type DestinationErrors = Partial<Record<string, FieldRefusal>>;

export interface AdminFieldsProps {
  fields: DestinationDraft;
  onChange: (fieldId: string, value: string) => void;
  /** The client's own check merged with billing's refusal, by field. */
  errors: DestinationErrors;
}

export interface TransferKind {
  /** Billing's registry id, `manual_gateway_setting.kind`. */
  kind: string;
  icon: LucideIcon;
  /** The fields this kind sends, in billing's order; a derived one (a card's bank) is left to billing. */
  destinationFields: readonly { id: string; optional?: boolean }[];
  /** The proof ids the kind declares — what `requiredProof` picks from (D-60 part 4). */
  proofFields: readonly string[];
  /** What a new gateway of this kind asks for until the seller changes it. */
  defaultProof: readonly string[];
  /** What the client can tell before a request: a missing field, a card's Luhn. Billing still decides. */
  check: (draft: DestinationDraft) => DestinationErrors;
  /** A destination in one line, for a list: the masked card, the wallet's asset and network. */
  summary: (fields: Readonly<Record<string, string | number>>) => string;
  /** The seller's editor for one destination's fields, with its live preview (F-803-g). */
  AdminFields: ComponentType<AdminFieldsProps>;
}

/** Every field the kind declares that is not optional and is blank. */
export function missingFields(kind: Pick<TransferKind, "destinationFields">, draft: DestinationDraft): DestinationErrors {
  const out: DestinationErrors = {};
  for (const f of kind.destinationFields) if (!f.optional && !(draft[f.id] ?? "").trim()) out[f.id] = "missing";
  return out;
}
