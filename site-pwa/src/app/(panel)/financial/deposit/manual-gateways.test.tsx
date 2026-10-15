import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DepositGateway, DepositQuote } from "@/lib/billing-api";
import { paymentTransferPath } from "@/lib/routes";
import { defaultGateway, groupGateways } from "./_lib/gateway-groups";
import { DepositView } from "./_components/DepositView";

/**
 * The deposit picker with manual gateways in it (F-803-h,
 * panel-web/contract.manual-transfer.md "The deposit picker").
 *
 * Two things have to hold. The page picks a gateway that settles itself
 * whenever one is offered — a card-to-card that a person confirms is the
 * slower road and is never the default over a bank gateway, whatever order
 * the list arrived in. And a start on a manual gateway has no bank to go to:
 * billing answers `redirectUrl: null` with the transfer, and the page goes to
 * the pay page instead of reading the null as the free path.
 */

const depositGateways = vi.fn();
const depositStart = vi.fn();
const walletPayments = vi.fn();
const push = vi.fn();

vi.mock("@/lib/billing-api", () => ({
  billingApi: {
    depositGateways: (...a: unknown[]) => depositGateways(...a),
    depositStart: (...a: unknown[]) => depositStart(...a),
    walletPayments: (...a: unknown[]) => walletPayments(...a),
    depositAbandon: vi.fn(),
  },
}));
vi.mock("next/navigation", async (actual) => ({ ...(await actual<object>()), useRouter: () => ({ push }) }));
vi.mock("@/context/LocaleContext", () => ({ useLocale: () => ({ t, lang: "en" }) }));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => () => "error" }));
vi.mock("../../_hooks/useWalletBalance", () => ({
  useWalletBalance: () => ({ balance: "10.00", isLoading: false, failed: false, refresh: () => {} }),
}));
vi.mock("./_hooks/useDepositQuote", () => ({ useDepositQuote: () => ({ quote: QUOTE, isQuoting: false, error: null }) }));

const t = (_ns: string, key: string) => key;

const gateway = (id: string, over: Partial<DepositGateway> = {}): DepositGateway => ({
  currencyCode: "USD",
  id,
  source: "tenant",
  displayName: id,
  providerName: "zarinpal",
  category: "domestic_rial",
  minAmount: null,
  maxAmount: null,
  presets: [],
  testing: false,
  confirmationMode: "automatic",
  manualKind: null,
  ...over,
});

const CARD = gateway("card", { providerName: "manual_transfer", category: "manual", confirmationMode: "manual_admin_required", manualKind: "card_to_card" });
const WALLET = gateway("wallet", { providerName: "manual_transfer", category: "manual", confirmationMode: "manual_admin_required", manualKind: "crypto_wallet" });
const BANK = gateway("bank");

const QUOTE: DepositQuote = {
  currencyCode: "USD",
  gatewayId: CARD.id,
  source: "tenant",
  amount: "10.00",
  coupons: [],
  rejected: [],
  discount: "0.00",
  gap: "0.00",
  fee: "0.00",
  tax: "0.00",
  taxRatePercent: null,
  payable: "10.00",
  credited: "10.00",
  free: false,
  charge: null,
};

describe("grouping and the default (F-803-h)", () => {
  it("puts gateways that settle themselves first, each group in the order billing sent", () => {
    const groups = groupGateways([CARD, BANK, WALLET]);
    expect(groups.map((g) => [g.id, g.gateways.map((x) => x.id)])).toEqual([
      ["automatic", ["bank"]],
      ["manual", ["card", "wallet"]],
    ]);
  });

  it("draws no heading for a group with nothing in it", () => {
    expect(groupGateways([BANK]).map((g) => g.id)).toEqual(["automatic"]);
    expect(groupGateways([]).length).toBe(0);
  });

  it("picks the first automatic gateway even when a manual one came first", () => {
    expect(defaultGateway([CARD, BANK])?.id).toBe("bank");
  });

  it("picks the first manual gateway only when no automatic one is offered", () => {
    expect(defaultGateway([WALLET, CARD])?.id).toBe("wallet");
    expect(defaultGateway([])).toBeNull();
  });

  it("reads a gateway from a list that carries no mode as one that settles itself", () => {
    const bare: DepositGateway = { ...BANK, confirmationMode: undefined, manualKind: undefined };
    expect(defaultGateway([CARD, bare])?.id).toBe("bank");
  });
});

describe("a start on a manual gateway (F-803-h)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    depositGateways.mockResolvedValue([CARD]);
    walletPayments.mockResolvedValue({ total: 0, page: 1, pageSize: 20, rows: [] });
  });

  it("opens the pay page for the payment, and shows no free-credit screen", async () => {
    depositStart.mockResolvedValue({
      paymentId: "99999999-9999-4999-8999-999999999999",
      free: false,
      redirectUrl: null,
      invoiceLink: null,
      transfer: {
        kind: "card_to_card",
        destination: { cardNumber: "6037990000000006", holderName: "Ali", bankId: "melli" },
        amountMinor: "100000",
        currencyCode: "IRR",
        decimals: 0,
        windowEndsAt: "2026-10-15T10:30:00Z",
        requiredProof: ["receiptImage"],
        confirmationMode: "manual_admin_required",
      },
      amount: "10.00",
      discount: "0.00",
      fee: "0.00",
      tax: "0.00",
      taxRatePercent: null,
      payable: "10.00",
      credited: "10.00",
      balance: null,
      currencyCode: "USD",
    });
    render(<DepositView />);
    const pay = () => screen.getAllByRole("button", { name: /^deposit\.summary\.(pay|starting)$/ })[0];
    await waitFor(() => expect(pay()).toBeEnabled());
    await waitFor(() => expect(walletPayments).toHaveBeenCalled());
    fireEvent.click(pay());
    await waitFor(() => expect(push).toHaveBeenCalledWith(paymentTransferPath("99999999-9999-4999-8999-999999999999")));
    expect(screen.queryByText("deposit.summary.freeTitle")).toBeNull();
  });

  it("badges a manual gateway as confirmed by a person", async () => {
    render(<DepositView />);
    expect(await screen.findByText("deposit.gateway.byPerson")).toBeInTheDocument();
  });
});
