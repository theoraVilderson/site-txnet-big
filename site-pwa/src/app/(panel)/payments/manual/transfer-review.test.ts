import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { TransferView, VerifyingPayment } from "@/lib/billing-api";
import { explorerTxUrl, knownNetwork } from "../../_components/transfer/networks";
import { REVIEW_REASON_KEYS, judgedWithoutAsking, proofRows, referenceOf, rejectChoice } from "./_lib/transfer-review";

/**
 * A manual transfer on the queue (F-803-k). What breaks silently:
 *  - a review reason billing writes with no sentence here — the badge that says
 *    why a person must look is blank. The enum is read out of the schema;
 *  - a transfer row waiting on "ask the gateway" — there is no gateway, billing
 *    answers `unsettled` and the reviewer learns nothing from the extra click;
 *  - a tx hash linked to the wrong explorer, or to one at all when the
 *    seller's free-text network is not one the panel knows — a reviewer
 *    trusting a page about another chain;
 *  - "let them send it again" offered when billing will refuse it (`cannot_return`).
 */
// The kind registry draws with the locale; nothing here renders, so the context is a stub.
vi.mock("@/context/LocaleContext", () => ({ useLocale: () => ({ t: (_ns: string, key: string) => key, lang: "en" }) }));

const REPO = join(__dirname, "../../../../../..");
const SCHEMA = join(REPO, "txnet-backend/prisma/domains/billing.prisma");

function reasonsBillingCanWrite(): string[] {
  const block = /enum TransferReviewReason \{([\s\S]*?)\}/.exec(readFileSync(SCHEMA, "utf8"));
  if (!block) throw new Error("TransferReviewReason is gone from billing.prisma — this test is stale");
  return [...block[1].matchAll(/^\s+([a-z_]+)\s*$/gm)].map((m) => m[1]);
}

const transfer = (overrides: Partial<TransferView> = {}): TransferView => ({
  kind: "card_to_card",
  destinationLabel: "Melli card",
  expectedAmountMinor: "5000000",
  currencyCode: "IRR",
  decimals: 0,
  network: null,
  proof: { receiptImage: "t/transfers/p/receipt", trackingCode: "12345678", paidAt: "2026-10-15T09:58:00Z" },
  proofSubmittedAt: "2026-10-15T10:00:00Z",
  reviewReason: "proof_only",
  receiptUrl: "/private-files/t/transfers/p/receipt?sig=x",
  receiptUrlExpiresAt: "2026-10-15T10:05:00Z",
  canReturn: true,
  ...overrides,
});

const row = (t: TransferView | null): Pick<VerifyingPayment, "transfer"> => ({ transfer: t });

describe("review reasons", () => {
  it("every reason billing can write has a sentence", () => {
    expect(Object.keys(REVIEW_REASON_KEYS).sort()).toEqual(reasonsBillingCanWrite().sort());
  });
});

describe("judgedWithoutAsking", () => {
  it("a transfer is judged at once — there is no gateway to ask", () => {
    expect(judgedWithoutAsking(row(transfer()))).toBe(true);
  });

  it("a gateway payment still asks the gateway first (ADR-0044)", () => {
    expect(judgedWithoutAsking(row(null))).toBe(false);
  });
});

describe("proofRows", () => {
  it("lists the proof in the kind's order, the receipt left to its own viewer", () => {
    expect(proofRows("card_to_card", transfer().proof).map(([id]) => id)).toEqual(["trackingCode", "paidAt"]);
  });

  it("still shows a field the panel's kind does not declare, after the known ones", () => {
    const proof = { sourceCardLast4: "1234", extra: "x", trackingCode: "1" };
    expect(proofRows("card_to_card", proof).map(([id]) => id)).toEqual(["trackingCode", "sourceCardLast4", "extra"]);
  });

  it("is empty before the payer sends anything", () => {
    expect(proofRows("card_to_card", null)).toEqual([]);
  });
});

describe("referenceOf", () => {
  it("offers the kind's reference field as the confirm form's reference", () => {
    expect(referenceOf("card_to_card", transfer().proof)).toBe("12345678");
    expect(referenceOf("crypto_wallet", { txHash: "ab".repeat(32) })).toBe("ab".repeat(32));
  });

  it("offers nothing when the payer sent no reference", () => {
    expect(referenceOf("card_to_card", { receiptImage: "k" })).toBe("");
    expect(referenceOf("unknown_kind", { trackingCode: "1" })).toBe("");
  });
});

describe("rejectChoice", () => {
  it("offers sending the proof back only while billing still allows it", () => {
    expect(rejectChoice(row(transfer()))).toBe("may_return");
    expect(rejectChoice(row(transfer({ canReturn: false })))).toBe("close_only");
    expect(rejectChoice(row(null))).toBe("close_only");
  });
});

describe("the explorer link", () => {
  const TRON = "a".repeat(64);
  const EVM = `0x${"b".repeat(64)}`;

  it.each([
    ["TRON (TRC20)", TRON, `https://tronscan.org/#/transaction/${TRON}`],
    ["trc20", TRON, `https://tronscan.org/#/transaction/${TRON}`],
    ["ERC20", EVM, `https://etherscan.io/tx/${EVM}`],
    ["BSC (BEP20)", EVM, `https://bscscan.com/tx/${EVM}`],
  ])("links %s to its own explorer", (network, hash, url) => {
    expect(explorerTxUrl(network, hash)).toBe(url);
  });

  it("links nothing for a network the panel does not know", () => {
    expect(knownNetwork("My private chain")).toBeNull();
    expect(explorerTxUrl("My private chain", TRON)).toBeNull();
  });

  it("links nothing when the free text names two chains", () => {
    expect(knownNetwork("TRC20 or BEP20")).toBeNull();
  });

  it("links nothing for a hash that is not that chain's shape", () => {
    expect(explorerTxUrl("TRC20", EVM)).toBeNull();
    expect(explorerTxUrl("ERC20", "not-a-hash/../x")).toBeNull();
    expect(explorerTxUrl(null, TRON)).toBeNull();
  });
});
