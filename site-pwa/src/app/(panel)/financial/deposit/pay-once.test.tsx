import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DepositGateway, DepositQuote, WalletPaymentRow } from "@/lib/billing-api";
import { DepositView } from "./_components/DepositView";

/**
 * One press of Pay starts one payment (F-093-r).
 *
 * `start` writes a payment row and takes this payment's coupon holds, so a
 * second one is a second row the payer never asked for — and, with a one-use
 * code in the list, a 409 on the click they meant. The button's disabled state
 * is the only thing between the two, and it is driven by a `useState` that is
 * set inside `pay()`, **after** `useVerifyingGuard.guard` has awaited a network
 * read. Two clicks inside that window both find the flag false.
 *
 * So the claim is made on the click, synchronously, and released on every path
 * that comes back to the form. Nothing here is about the guard's verdict: the
 * warning still warns and "pay anyway" still pays (F-093-m).
 */

const depositGateways = vi.fn();
const depositStart = vi.fn();
const walletPayments = vi.fn();

vi.mock("@/lib/billing-api", () => ({
  billingApi: {
    depositGateways: (...a: unknown[]) => depositGateways(...a),
    depositStart: (...a: unknown[]) => depositStart(...a),
    walletPayments: (...a: unknown[]) => walletPayments(...a),
    depositAbandon: vi.fn(),
  },
}));
vi.mock("@/lib/mini-app", () => ({ openMiniAppInvoice: vi.fn() }));
vi.mock("@/context/LocaleContext", () => ({ useLocale: () => ({ t, lang: "en" }) }));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => () => "error" }));
vi.mock("../../_hooks/useWalletBalance", () => ({
  useWalletBalance: () => ({ balance: "10.00", isLoading: false, failed: false, refresh: () => {} }),
}));
vi.mock("./_hooks/useDepositQuote", () => ({ useDepositQuote: () => ({ quote, isQuoting: false, error: null }) }));

/** The key back, so an assertion names the string the component asked for. */
const t = (_ns: string, key: string) => key;

const GATEWAY: DepositGateway = {
  id: "11111111-1111-4111-8111-111111111111",
  source: "tenant",
  displayName: "Zarinpal",
  providerName: "zarinpal",
  category: "iranian_gateway",
  minAmount: "1.00",
  maxAmount: "500.00",
  presets: [],
  testing: false,
};

/** A bill for the inputs on screen — `charge: null`, so no rial block is drawn. */
let quote: DepositQuote | null = null;
const QUOTE: DepositQuote = {
  gatewayId: GATEWAY.id,
  source: "tenant",
  amount: "10.00",
  coupons: [],
  rejected: [],
  discount: "0.00",
  gap: "0.00",
  fee: "0.00",
  payable: "10.00",
  credited: "10.00",
  free: false,
  charge: null,
};

const verifyingRow: WalletPaymentRow = {
  id: "77777777-7777-4777-8777-777777777777",
  status: "pending",
  amountRequested: "10.00",
  fee: "0.00",
  discount: "0.00",
  amountCredited: "10.00",
  charge: { amountMinor: "1000000", rate: null },
  trackingCode: "A1",
  referenceId: null,
  cardPanMasked: null,
  failureCode: null,
  gateway: null,
  createdAt: "2026-09-14T10:00:00Z",
  expiresAt: null,
  verifying: true,
};

const noPending = { total: 0, page: 1, pageSize: 20, rows: [] as WalletPaymentRow[] };

/**
 * The desktop card's button; the mobile footer renders the same component. It
 * is matched on either label, because "starting" is what a claimed click shows.
 */
function payButton() {
  return screen.getAllByRole("button", { name: /^deposit\.summary\.(pay|starting)$/ })[0];
}

async function openPage() {
  render(<DepositView />);
  // The gateways and the page's own verifying read both have to land, or the
  // second of them settles after the test and React reports it outside `act`.
  await waitFor(() => expect(payButton()).toBeEnabled());
  await waitFor(() => expect(walletPayments).toHaveBeenCalled());
}

beforeEach(() => {
  vi.clearAllMocks();
  quote = QUOTE;
  depositGateways.mockResolvedValue([GATEWAY]);
  walletPayments.mockResolvedValue(noPending);
  depositStart.mockResolvedValue({ paymentId: "p1", redirectUrl: "https://bank.example/pay", balance: null, credited: "0.00" });
});

describe("one press of Pay starts one payment", () => {
  it("sends one start for two clicks inside the verifying check", async () => {
    await openPage();

    // Both clicks land while `guard`'s read of the pending attempts is still
    // in flight — the window the old code left open.
    fireEvent.click(payButton());
    fireEvent.click(payButton());

    await waitFor(() => expect(depositStart).toHaveBeenCalledTimes(1));
    expect(walletPayments).toHaveBeenCalledTimes(2); // the page's own read, then the guard's
  });

  it("disables the button from the click, not from the answer", async () => {
    await openPage();
    fireEvent.click(payButton());
    expect(payButton()).toBeDisabled();
  });

  it("gives the button back when the verifying warning is dismissed", async () => {
    walletPayments.mockResolvedValueOnce(noPending).mockResolvedValue({ ...noPending, total: 1, rows: [verifyingRow] });
    await openPage();

    fireEvent.click(payButton());
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "deposit.verifying.warn.cancel" }));

    expect(depositStart).not.toHaveBeenCalled();
    await waitFor(() => expect(payButton()).toBeEnabled());
  });

  it("still pays once when the payer answers 'pay anyway'", async () => {
    walletPayments.mockResolvedValueOnce(noPending).mockResolvedValue({ ...noPending, total: 1, rows: [verifyingRow] });
    await openPage();

    fireEvent.click(payButton());
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "deposit.verifying.warn.confirm" }));

    await waitFor(() => expect(depositStart).toHaveBeenCalledTimes(1));
  });
});
