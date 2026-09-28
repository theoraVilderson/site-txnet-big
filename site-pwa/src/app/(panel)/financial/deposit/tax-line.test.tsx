import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { DepositQuote, WalletPaymentRow } from "@/lib/billing-api";
import { PaymentSummary } from "./_components/PaymentSummary";
import { PaymentRow } from "../_components/PaymentRow";

/**
 * The tax line (F-104-ah, ADR-0076).
 *
 * Since F-104-af billing's `payable` is `basis + fee + tax`. A bill that lists
 * the amount and the fee but not the tax shows a total its own lines do not
 * add up to — a charge that does not match the quote on screen. The line is
 * billing's `tax`, labelled with billing's `taxRatePercent`: this page adds
 * nothing up. An untaxed quote (`tax` `0.00`, rate `null`) shows no line, as
 * before; the same holds for a payment row in history.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: () => ({ t, lang: "en" }) }));

/** The key back, with its params, so an assertion names what was asked for. */
const t = (_ns: string, key: string, params?: Record<string, unknown>) =>
  params ? `${key}${JSON.stringify(params)}` : key;

const QUOTE: DepositQuote = {
  currencyCode: "USD",
  gatewayId: "11111111-1111-4111-8111-111111111111",
  source: "tenant",
  amount: "100.00",
  coupons: [],
  rejected: [],
  discount: "0.00",
  gap: "0.00",
  fee: "1.00",
  tax: "9.00",
  taxRatePercent: "9",
  payable: "110.00",
  credited: "100.00",
  free: false,
  charge: null,
};

const summary = (quote: DepositQuote) =>
  render(<PaymentSummary quote={quote} isQuoting={false} error={null} isStarting={false} onPay={() => {}} />);

describe("the bill's tax line", () => {
  it("shows billing's tax, labelled with the rate billing applied", () => {
    summary(QUOTE);
    const label = screen.getByText(/deposit\.summary\.tax\{"rate":"9"\}/);
    expect(label.parentElement?.textContent).toContain("9.00");
  });

  it("shows no tax line on an untaxed quote", () => {
    summary({ ...QUOTE, tax: "0.00", taxRatePercent: null, payable: "101.00" });
    expect(screen.queryByText(/deposit\.summary\.tax/)).toBeNull();
  });
});

const ROW: WalletPaymentRow = {
  currencyCode: "USD",
  id: "77777777-7777-4777-8777-777777777777",
  status: "success",
  amountRequested: "100.00",
  fee: "1.00",
  tax: "9.00",
  taxRatePercent: "9",
  discount: "0.00",
  amountCredited: "100.00",
  charge: { amountMinor: "11000", rate: null },
  trackingCode: null,
  referenceId: null,
  cardPanMasked: null,
  failureCode: null,
  gateway: null,
  createdAt: "2026-09-24T09:00:00Z",
  expiresAt: null,
  verifying: false,
};

const expand = (row: WalletPaymentRow) => {
  render(<PaymentRow row={row} />);
  fireEvent.click(screen.getAllByRole("button")[0]);
};

describe("a payment's tax in history", () => {
  it("shows the tax it was charged, at the rate frozen on the payment", () => {
    expand(ROW);
    const label = screen.getByText(/financial\.detail\.tax\{"rate":"9"\}/);
    expect(label.closest("div")?.parentElement?.textContent).toContain("9.00");
  });

  it("shows no tax line for a payment that was not taxed", () => {
    expand({ ...ROW, tax: "0.00", taxRatePercent: null });
    expect(screen.queryByText(/financial\.detail\.tax/)).toBeNull();
  });
});
