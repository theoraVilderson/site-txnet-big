/**
 * A manual transfer's routes as the chat reads them (F-803-d, F-805-a/b,
 * `billing/contract.manual-transfer.md`): the payer's destination and proof,
 * and the reviewer's queue row and answer. Every amount is billing's string;
 * the chat does no arithmetic on any of them.
 */

/** A start's `transfer` on a manual gateway (F-803-d): where to send what, and the proof to send back. */
export interface DepositTransfer {
  /** The method kind (`card_to_card`, `crypto_wallet`, …). */
  kind: string;
  /** The destination's public fields by the kind's ids (`cardNumber`, `address`, …), frozen at the start. */
  destination: Record<string, string | number>;
  /** Exactly what to send, in `currencyCode`'s minor unit. */
  amountMinor: string;
  currencyCode: string;
  decimals: number;
  windowEndsAt: string;
  /** The seller's pick of the kind's proof field ids (D-60 part 4), asked in this order. */
  requiredProof: string[];
  confirmationMode: string;
}

/** `GET …/deposit/:paymentId/transfer`: the start's body, and where the payment stands now. */
export interface TransferStatus extends DepositTransfer {
  /** `pending` until a person or the expiry sweep closes it. */
  status: string;
  /** Set once a proof was sent; cleared when a person sends it back (F-805-a). */
  proofSubmittedAt: string | null;
}

/** `POST …/proof`: the payment waits on a person now. */
export interface ProofAccepted {
  paymentId: string;
  proofSubmittedAt: string;
}

/** One open payment of the manual-payments queue (F-092-af), narrowed to what the chat judges a transfer by. */
export interface ManualQueueRow {
  id: string;
  /** What reaches the payer's wallet, in the payment's `currencyCode`. */
  amountCredited: string;
  currencyCode: string;
  /** Null for every payment that is no manual transfer; the chat reads what it judges by and no more. */
  transfer: {
    /** What the payer was asked to send, in the charge currency's minor unit. */
    expectedAmountMinor: string;
    decimals: number;
    currencyCode: string;
    /** The seller's own name for the card or wallet it went to. */
    destinationLabel: string;
    /** Null until the payer sends it, and again once a reviewer sends it back. */
    proofSubmittedAt: string | null;
    proof: Record<string, unknown> | null;
    /** Whether a reject may still send the proof back, once. */
    canReturn: boolean;
  } | null;
}

/** What billing did with a person's confirm or reject (F-092-z/ak, F-805-a). */
export interface ManualAnswer {
  paymentId: string;
  outcome: string;
  referenceId: string | null;
}
