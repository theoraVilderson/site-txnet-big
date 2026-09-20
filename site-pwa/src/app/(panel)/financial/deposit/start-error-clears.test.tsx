import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "@/lib/api-error";
import type { DepositGateway, DepositQuote, WalletPaymentRow } from "@/lib/billing-api";
import { QUOTE_DEBOUNCE_MS } from "./_hooks/useDepositQuote";
import { DepositView } from "./_components/DepositView";

/**
 * A start error belongs to the inputs it was refused for (F-093-t).
 *
 * `start` is refused for a gateway, an amount and a list of codes — a 503 at
 * one bank, a 400 on one range, a 429 for one burst. The page kept that
 * sentence in plain state and cleared it only inside `pay()` and `reset()`, so
 * switching gateway left the first bank's outage over the second bank's bill,
 * and the payer read a refusal that no longer applied to anything on screen.
 *
 * Worse, it was passed as `startError ?? quote.error`: while the stale sentence
 * was up, a **new** refusal of the quote itself — the range, the gateway, the
 * limiter — had nowhere to be shown. The page said 503 while billing was
 * saying something else about the bill in front of the payer.
 *
 * Both halves are the same rule as the quote's (rule 1): an answer belongs to
 * the inputs it was asked for, and the bill's own verdict is the current one.
 */

const depositGateways = vi.fn();
const depositQuote = vi.fn();
const depositStart = vi.fn();
const walletPayments = vi.fn();

vi.mock("@/lib/billing-api", () => ({
  billingApi: {
    depositGateways: (...a: unknown[]) => depositGateways(...a),
    depositQuote: (...a: unknown[]) => depositQuote(...a),
    depositStart: (...a: unknown[]) => depositStart(...a),
    walletPayments: (...a: unknown[]) => walletPayments(...a),
    depositAbandon: vi.fn(),
  },
}));
vi.mock("@/lib/mini-app", () => ({ openMiniAppInvoice: vi.fn() }));
vi.mock("@/context/LocaleContext", () => ({ useLocale: () => ({ t, lang: "en" }) }));
vi.mock("@/hooks/useApiError", () => ({
  useApiErrorMessage: () => (e: unknown) => (e as Error).message,
}));
vi.mock("../../_hooks/useWalletBalance", () => ({
  useWalletBalance: () => ({ balance: "10.00", isLoading: false, failed: false, refresh: () => {} }),
}));

/** The key back, so an assertion names the string the component asked for. */
const t = (_ns: string, key: string) => key;

const ZARINPAL: DepositGateway = {
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

/** A second bank, so a refusal at the first has somewhere to be left behind. */
const NEXTPAY: DepositGateway = {
  ...ZARINPAL,
  id: "22222222-2222-4222-8222-222222222222",
  displayName: "NextPay",
  providerName: "nextpay",
};

const BASE: DepositQuote = {
  gatewayId: ZARINPAL.id,
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

const noPending = { total: 0, page: 1, pageSize: 20, rows: [] as WalletPaymentRow[] };

function payButton() {
  return screen.getAllByRole("button", { name: /^deposit\.summary\.(pay|starting)$/ })[0];
}

/** An amount the gateways above both accept, priced and on screen. */
async function openPageWithAmount() {
  render(<DepositView />);
  await waitFor(() => expect(depositGateways).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("deposit.amount.label"), { target: { value: "10.00" } });
  await waitFor(() => expect(depositQuote).toHaveBeenCalled(), { timeout: QUOTE_DEBOUNCE_MS * 4 });
  await waitFor(() => expect(walletPayments).toHaveBeenCalled());
}

/** Pay, and wait for the refusal's sentence to be on screen. */
async function payAndFail(message: string) {
  fireEvent.click(payButton());
  await waitFor(() => expect(screen.getAllByText(message).length).toBeGreaterThan(0));
}

beforeEach(() => {
  vi.clearAllMocks();
  depositGateways.mockResolvedValue([ZARINPAL, NEXTPAY]);
  walletPayments.mockResolvedValue(noPending);
  depositQuote.mockResolvedValue(BASE);
});

describe("a start error belongs to the inputs it was refused for", () => {
  it("clears when the gateway changes", async () => {
    depositStart.mockRejectedValue(new ApiError("that bank is down", { status: 503 }));
    await openPageWithAmount();
    await payAndFail("that bank is down");

    fireEvent.click(screen.getByRole("radio", { name: /NextPay/ }));

    // Gone in the render that switched, not once the second bank's quote lands.
    expect(screen.queryByText("that bank is down")).toBeNull();
  });

  it("clears when the amount or a code changes", async () => {
    depositStart.mockRejectedValue(new ApiError("out of range", { status: 400 }));
    await openPageWithAmount();
    await payAndFail("out of range");

    fireEvent.change(screen.getByLabelText("deposit.amount.label"), { target: { value: "20.00" } });
    expect(screen.queryByText("out of range")).toBeNull();

    await waitFor(() => expect(screen.getAllByText("deposit.summary.pay").length).toBeGreaterThan(0), {
      timeout: QUOTE_DEBOUNCE_MS * 4,
    });
    await payAndFail("out of range");

    fireEvent.change(screen.getByLabelText("deposit.coupon.label"), { target: { value: "SAVE2" } });
    fireEvent.click(screen.getByRole("button", { name: "deposit.coupon.add" }));
    expect(screen.queryByText("out of range")).toBeNull();
  });

  it("does not hide a refusal of the quote itself", async () => {
    // A 409 re-prices (rule 5), and that re-pricing is what fails here: the
    // limiter answers the retry. The payer must read the current verdict.
    depositStart.mockRejectedValue(
      new ApiError("that code has run out", { status: 409, reason: "per_user_limit_reached" }),
    );
    await openPageWithAmount();
    const quotesBefore = depositQuote.mock.calls.length;
    depositQuote.mockRejectedValue(new ApiError("too many quotes", { status: 429 }));

    fireEvent.click(payButton());
    await waitFor(() => expect(depositQuote.mock.calls.length).toBe(quotesBefore + 1), {
      timeout: QUOTE_DEBOUNCE_MS * 4,
    });

    await waitFor(() => expect(screen.getAllByText("too many quotes").length).toBeGreaterThan(0));
    expect(screen.queryByText("that code has run out")).toBeNull();
  });

  it("keeps a start refusal on screen while the inputs are unchanged", async () => {
    depositStart.mockRejectedValue(new ApiError("that bank is down", { status: 503 }));
    await openPageWithAmount();
    await payAndFail("that bank is down");

    // Nothing was touched, so the sentence is still the answer for this bill —
    // clearing on any render would be the other half of the same bug.
    fireEvent.click(payButton());
    await waitFor(() => expect(depositStart).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText("that bank is down").length).toBeGreaterThan(0);
  });
});
