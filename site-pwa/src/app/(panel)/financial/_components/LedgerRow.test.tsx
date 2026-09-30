import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { WalletLedgerRow } from "@/lib/billing-api";
import * as money from "../../_lib/money";
import { LedgerRow } from "./LedgerRow";

/**
 * Money in the currency its row names (F-116-h3, ADR-0098 part 3).
 *
 * > **A USD ledger row written before a switch to IRR still reads as dollars.**
 *
 * Every route answers a `currencyCode` beside its amounts, a list row its own
 * (F-116-h2). The panel prints that code and keeps no default of its own:
 * a constant here is how every figure read as dollars whatever it was in.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: () => ({ t, lang: "en" }) }));

const t = (_ns: string, key: string, vars?: Record<string, string>) => (vars ? `${key} ${Object.values(vars).join(" ")}` : key);

const row = (over: Partial<WalletLedgerRow>): WalletLedgerRow => ({
  id: "row-1",
  amount: "5.50",
  direction: "credit",
  reasonType: "deposit",
  referenceId: null,
  balanceAfter: "12.00",
  currencyCode: "USD",
  meterKey: null,
  usageQuantity: null,
  note: null,
  createdAt: "2026-09-01T10:00:00Z",
  ...over,
});

describe("a ledger row's money", () => {
  it("reads in the row's own currency, not the wallet's now: a dollar row stays dollars after a switch to rials", () => {
    render(
      <>
        <LedgerRow row={row({ id: "before", currencyCode: "USD" })} />
        <LedgerRow row={row({ id: "after", amount: "1500000", balanceAfter: "2000000", currencyCode: "IRR" })} />
      </>,
    );

    expect(screen.getByText(/\+\s+\$5\.50/)).toBeTruthy();
    expect(screen.getAllByText("$12.00").length).toBeGreaterThan(0);
    expect(screen.getByText(/\+\s+IRR\s1,500,000/)).toBeTruthy();
    expect(screen.queryByText(/\$1,500,000/)).toBeNull();
  });

  it("has no default currency to fall back to", () => {
    expect("BASE_CURRENCY" in money).toBe(false);
  });
});

describe("a closed service's last usage (F-118-am)", () => {
  it("says it was rounded up, with the traffic it covers", () => {
    render(
      <LedgerRow
        row={row({
          direction: "debit",
          amount: "0.01",
          reasonType: "usage_charge",
          meterKey: "vpn.traffic",
          usageQuantity: String(3 * 1024 * 1024),
          note: "final_usage_rounded_up",
        })}
      />,
    );
    expect(screen.getByText("financial.note.final_usage_rounded_up 3 MB")).toBeTruthy();
  });

  it("says nothing of rounding on a capture priced exactly", () => {
    render(<LedgerRow row={row({ direction: "debit", reasonType: "usage_charge", meterKey: "vpn.traffic", usageQuantity: "1024" })} />);
    expect(screen.queryByText(/financial\.note\./)).toBeNull();
  });
});
