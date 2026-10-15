import { Banknote } from "lucide-react";
import { CARD_TO_CARD } from "./kinds/card-to-card";
import { CRYPTO_WALLET } from "./kinds/crypto-wallet";
import { PlainAdminFields } from "./kinds/plain";
import type { TransferKind } from "./transfer-kind";

/**
 * Every manual method kind the panel can draw (contract.manual-transfer.md
 * principle 1) — the only file that lists them. A new billing kind is one
 * file under `kinds/` and one line here; until then it falls back to
 * {@link transferKind}'s plain one, so no page breaks on a kind newer than the panel.
 */
export const TRANSFER_KINDS: readonly TransferKind[] = [CARD_TO_CARD, CRYPTO_WALLET];

const BY_KIND: ReadonlyMap<string, TransferKind> = new Map(TRANSFER_KINDS.map((k) => [k.kind, k]));

/** A kind billing has and the panel does not: its fields as plain text, its proof as billing named it. */
function plainKind(kind: string): TransferKind {
  return {
    kind,
    icon: Banknote,
    destinationFields: [],
    proofFields: [],
    refProofField: null,
    defaultProof: [],
    check: () => ({}),
    summary: (f) => Object.values(f).join(" · "),
    AdminFields: PlainAdminFields,
  };
}

/** The drawing for a kind — the registered one, or the plain fallback. */
export function transferKind(kind: string): TransferKind {
  return BY_KIND.get(kind) ?? plainKind(kind);
}

