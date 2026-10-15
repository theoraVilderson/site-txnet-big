"use client";

import { useAnimate } from "framer-motion";
import { CreditCard } from "lucide-react";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { DURATION } from "@/lib/motion";
import { BankCard } from "../BankCard";
import { bankOfCard, CARD_LENGTH, foldDigits, isLuhnValid } from "../banks";
import { TransferField } from "../TransferField";
import { missingFields, type AdminFieldsProps, type DestinationDraft, type TransferKind } from "../transfer-kind";

/** The last digits a list shows of a card: enough to tell two apart, as a receipt does. */
const SHOWN_DIGITS = 4;
/** A Luhn failure's one shake (contract "Admin"): a few pixels each way, inside `slow`. */
const SHAKE_PX = [0, -6, 6, -4, 4, 0];

const digitsOf = (raw: string) => foldDigits(raw).replace(/\D/g, "").slice(0, CARD_LENGTH);

/** A complete number that fails Luhn — a typo the payer would otherwise send money to (billing `checksum`). */
const luhnFails = (digits: string) => digits.length === CARD_LENGTH && !isLuhnValid(digits);

function check(draft: DestinationDraft) {
  const errors = missingFields(CARD_TO_CARD, draft);
  const digits = draft.cardNumber ?? "";
  if (digits && digits.length !== CARD_LENGTH) errors.cardNumber = "invalid";
  else if (luhnFails(digits)) errors.cardNumber = "checksum";
  return errors;
}

/**
 * The seller's card editor (F-803-g): the card is drawn beside the fields and
 * fills as the number is typed; the bank resolves from the first six digits
 * with a fade, and a complete number that fails Luhn shakes the field once
 * (`full` motion only) and says why. The bank itself is left to billing, which
 * derives it from the same table (`bankId`'s `fallback`).
 */
function CardAdminFields({ fields, onChange, errors }: AdminFieldsProps) {
  const level = useMotionLevel();
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const digits = fields.cardNumber ?? "";

  const typeNumber = (_id: string, raw: string) => {
    const next = digitsOf(raw);
    onChange("cardNumber", next);
    // Once, on the keystroke that completes a bad number — not on every render while it stays bad.
    if (level === "full" && luhnFails(next) && !luhnFails(digits) && scope.current) {
      void animate(scope.current, { x: SHAKE_PX }, { duration: DURATION.slow });
    }
  };

  return (
    <div className="grid items-start gap-5 sm:grid-cols-2">
      <div className="flex flex-col gap-4">
        <div ref={scope}>
          <TransferField id="cardNumber" fields={fields} onChange={typeNumber} errors={errors} ltr numeric placeholder="6037 99•• •••• ••••" />
        </div>
        <TransferField id="holderName" fields={fields} onChange={onChange} errors={errors} />
        <TransferField id="sheba" fields={fields} onChange={onChange} errors={errors} ltr optional placeholder="IR…" fold={(raw) => foldDigits(raw).toUpperCase()} />
      </div>
      <BankCard digits={digits} holderName={fields.holderName ?? ""} bankId={bankOfCard(digits)} />
    </div>
  );
}

export const CARD_TO_CARD: TransferKind = {
  kind: "card_to_card",
  icon: CreditCard,
  destinationFields: [{ id: "cardNumber" }, { id: "holderName" }, { id: "sheba", optional: true }],
  proofFields: ["receiptImage", "trackingCode", "sourceCardLast4", "paidAt"],
  refProofField: "trackingCode",
  defaultProof: ["receiptImage", "trackingCode"],
  check,
  summary: (f) => `•••• ${String(f.cardNumber ?? "").slice(-SHOWN_DIGITS)} · ${String(f.holderName ?? "")}`,
  AdminFields: CardAdminFields,
};
