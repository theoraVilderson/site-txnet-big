import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "@/lib/api-error";
import type { DepositGateway, DepositQuote, WalletPaymentRow } from "@/lib/billing-api";
import { QUOTE_DEBOUNCE_MS } from "./_hooks/useDepositQuote";
import { DepositView } from "./_components/DepositView";

/**
 * A start that was refused a coupon hold re-prices the page (F-093-s).
 *
 * `start` re-checks every code and takes a hold on each; a code that has run
 * out between the quote and the click aborts the whole transaction and is a
 * **409, with nothing written** (`billing/contract.deposit.md`). The sentence
 * arrives translated and is shown — but the bill beside it is still the one
 * that had the code in it, so the payer reads a discount they cannot have and
 * a payable nobody will charge, and pressing Pay again repeats the same 409.
 * Nothing on screen changes until they happen to touch an input.
 *
 * The quote is the only thing that can answer it: the same inputs, asked
 * again, come back with the code in `rejected` and the breakdown without it
 * (rule 4 — a refused code stays in the list, marked). That is what
 * `useDepositQuote`'s `retry` is for, and until now nothing called it.
 *
 * Only a 409 re-prices. A 400 on the range, a 503 from the gateway and a 429
 * from the limiter would all come back to the same bill, and the quote route
 * has a budget of its own (60 per 900s) that a refusal must not spend.
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

const BASE: DepositQuote = {
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

/** The bill the payer pressed Pay on: the code applied, 2.00 off. */
const WITH_COUPON: DepositQuote = {
  ...BASE,
  coupons: [{ code: "SAVE2", discount: "2.00" }],
  discount: "2.00",
  payable: "8.00",
};

/** The same inputs, priced again after the hold was refused. */
const WITHOUT_COUPON: DepositQuote = {
  ...BASE,
  rejected: [{ code: "SAVE2", reason: "per_user_limit_reached", message: "that code has run out" }],
};

const noPending = { total: 0, page: 1, pageSize: 20, rows: [] as WalletPaymentRow[] };

function payButton() {
  return screen.getAllByRole("button", { name: /^deposit\.summary\.(pay|starting)$/ })[0];
}

/** Amount, then a code: the inputs the quote below is the answer to. */
async function openPageWithCoupon() {
  render(<DepositView />);
  await waitFor(() => expect(depositGateways).toHaveBeenCalled());

  fireEvent.change(screen.getByLabelText("deposit.amount.label"), { target: { value: "10.00" } });
  fireEvent.change(screen.getByLabelText("deposit.coupon.label"), { target: { value: "SAVE2" } });
  fireEvent.click(screen.getByRole("button", { name: "deposit.coupon.add" }));

  await waitFor(() => expect(screen.getByText("deposit.summary.discount")).toBeInTheDocument(), {
    timeout: QUOTE_DEBOUNCE_MS * 4,
  });
  await waitFor(() => expect(walletPayments).toHaveBeenCalled());
}

beforeEach(() => {
  vi.clearAllMocks();
  depositGateways.mockResolvedValue([GATEWAY]);
  walletPayments.mockResolvedValue(noPending);
  depositQuote.mockResolvedValue(WITH_COUPON);
});

/** Real timers, because the page's debounce is the thing being waited on. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a refused coupon hold re-prices the page", () => {
  it("re-quotes after a 409 and shows the bill without the code", async () => {
    depositStart.mockRejectedValue(
      new ApiError("that code has run out", { status: 409, reason: "per_user_limit_reached" }),
    );
    await openPageWithCoupon();
    const quotesBefore = depositQuote.mock.calls.length;
    depositQuote.mockResolvedValue(WITHOUT_COUPON);

    fireEvent.click(payButton());
    await waitFor(() => expect(depositStart).toHaveBeenCalledTimes(1));

    // The same body, asked again — not a changed input, and not a retry the
    // payer had to find for themselves.
    await waitFor(() => expect(depositQuote.mock.calls.length).toBe(quotesBefore + 1), {
      timeout: QUOTE_DEBOUNCE_MS * 4,
    });
    expect(depositQuote).toHaveBeenLastCalledWith({
      gatewayId: GATEWAY.id,
      source: "tenant",
      amount: "10.00",
      couponCodes: ["SAVE2"],
    });

    // The discount line is gone and the code is still in the list, marked.
    await waitFor(() => expect(screen.queryByText("deposit.summary.discount")).toBeNull());
    expect(screen.getAllByText("deposit.coupon.rejected").length).toBeGreaterThan(0);
    // billing's sentence for the refusal is still on screen beside it.
    expect(screen.getAllByText("that code has run out").length).toBeGreaterThan(0);
  });

  it("does not spend a quote on a refusal the same inputs would repeat", async () => {
    depositStart.mockRejectedValue(new ApiError("out of range", { status: 400 }));
    await openPageWithCoupon();
    const quotesBefore = depositQuote.mock.calls.length;

    fireEvent.click(payButton());
    await waitFor(() => expect(depositStart).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByText("out of range").length).toBeGreaterThan(0));

    await sleep(QUOTE_DEBOUNCE_MS * 3);
    expect(depositQuote.mock.calls.length).toBe(quotesBefore);
  });
});
