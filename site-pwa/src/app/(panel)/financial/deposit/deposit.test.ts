import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { billingApi, type DepositGateway, type DepositQuote } from "@/lib/billing-api";
import { ApiError } from "@/lib/api-error";
import { QUOTE_DEBOUNCE_MS, useDepositQuote, type DepositInputs } from "./_hooks/useDepositQuote";
import { fromCents, fromMinor, offeredPresets, presetAmounts, tomanFromRial, toCents } from "./_lib/deposit-amount";

/**
 * The top-up page (F-093-e), and the one thing about it that has to be true:
 *
 * > **Every figure on this page is one `billing` answered for the inputs
 * > currently on screen.** The panel adds nothing up, and a quote for other
 * > inputs is never shown as the price of these.
 *
 * That is F-0612 written as a test. Legacy computed the bill twice — once in
 * `Deposit.tsx` (discount, the gateway-minimum adjustment, tax, fee, the
 * projected balance) and once on the server — and the two drifted, which is
 * the reason `POST /deposit/quote` returns the whole breakdown rather than the
 * pieces of one. A client that recomputes any of it re-opens that gap, and a
 * client that keeps showing the last breakdown while the amount changes has
 * the same bug with a delay on it.
 *
 * The helpers below the hook are the other half: the amount box and the slider
 * work in integer cents, because a slider that emits a float is how a decimal
 * string becomes `0.30000000000000004` on the wire.
 */

vi.mock("@/lib/billing-api", () => ({
  billingApi: { depositGateways: vi.fn(), depositQuote: vi.fn(), depositStart: vi.fn() },
}));

const depositQuote = vi.mocked(billingApi.depositQuote);

const GATEWAY: DepositGateway = {
  currencyCode: "USD",
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

/** A quote whose numbers are deliberately not derivable from each other. */
function quoteFor(amount: string): DepositQuote {
  return {
    currencyCode: "USD",
    gatewayId: GATEWAY.id,
    source: "tenant",
    amount,
    coupons: [],
    rejected: [],
    discount: "0.00",
    gap: "0.00",
    fee: "0.07",
    tax: "0.00",
    taxRatePercent: null,
    payable: "0.42",
    credited: "0.99",
    free: false,
    charge: { currency: "IRR", decimals: 0, amountMinor: "420000" },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  depositQuote.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Let the debounce elapse and the answer land, inside one act(). */
async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(QUOTE_DEBOUNCE_MS);
  });
}

describe("useDepositQuote", () => {
  it("asks for nothing until there is a gateway and an amount above zero", async () => {
    const { rerender } = renderHook((props: DepositInputs) => useDepositQuote(props), {
      initialProps: { gateway: null, amount: "10.00", codes: [] } as DepositInputs,
    });
    await settle();
    rerender({ gateway: GATEWAY, amount: "", codes: [] });
    await settle();
    rerender({ gateway: GATEWAY, amount: "0.00", codes: [] });
    await settle();

    expect(depositQuote).not.toHaveBeenCalled();
  });

  it("prices a burst of keystrokes once, with the amount the user stopped on", async () => {
    depositQuote.mockResolvedValue(quoteFor("123.00"));
    const { rerender } = renderHook((props: DepositInputs) => useDepositQuote(props), {
      initialProps: { gateway: GATEWAY, amount: "1", codes: [] },
    });
    for (const amount of ["12", "123", "123.0", "123.00"]) {
      act(() => {
        vi.advanceTimersByTime(QUOTE_DEBOUNCE_MS / 4);
      });
      rerender({ gateway: GATEWAY, amount, codes: [] });
    }
    await settle();

    expect(depositQuote).toHaveBeenCalledTimes(1);
    expect(depositQuote).toHaveBeenCalledWith({
      gatewayId: GATEWAY.id,
      source: "tenant",
      amount: "123.00",
      couponCodes: [],
    });
  });

  it("shows the figures billing answered, and derives none of them", async () => {
    const answer = quoteFor("10.00");
    depositQuote.mockResolvedValue(answer);
    const { result } = renderHook(() =>
      useDepositQuote({ gateway: GATEWAY, amount: "10.00", codes: [] }),
    );
    await settle();

    // Not `amount + fee - discount`: the payable is whatever the server said,
    // even when that is nothing arithmetic here could have produced.
    expect(result.current.quote).toEqual(answer);
    expect(result.current.isQuoting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("drops the old breakdown the moment an input changes", async () => {
    depositQuote.mockResolvedValue(quoteFor("10.00"));
    const { result, rerender } = renderHook(
      (props: DepositInputs) => useDepositQuote(props),
      { initialProps: { gateway: GATEWAY, amount: "10.00", codes: [] } },
    );
    await settle();
    expect(result.current.quote).not.toBeNull();

    rerender({ gateway: GATEWAY, amount: "20.00", codes: [] });
    // Before the new answer, and before the debounce has even fired: the old
    // numbers are gone. A stale bill under a new amount is the failure.
    expect(result.current.quote).toBeNull();
    expect(result.current.isQuoting).toBe(true);
  });

  it("never lets a slow answer to abandoned inputs land", async () => {
    let releaseSlow: (q: DepositQuote) => void = () => undefined;
    depositQuote
      .mockImplementationOnce(() => new Promise<DepositQuote>((resolve) => (releaseSlow = resolve)))
      .mockResolvedValueOnce(quoteFor("20.00"));

    const { result, rerender } = renderHook(
      (props: DepositInputs) => useDepositQuote(props),
      { initialProps: { gateway: GATEWAY, amount: "10.00", codes: [] } },
    );
    act(() => {
      vi.advanceTimersByTime(QUOTE_DEBOUNCE_MS);
    });
    rerender({ gateway: GATEWAY, amount: "20.00", codes: [] });
    await settle();
    expect(result.current.quote?.amount).toBe("20.00");

    await act(async () => {
      releaseSlow(quoteFor("10.00"));
    });
    expect(result.current.quote?.amount).toBe("20.00");
  });

  it("treats a rejected code as part of the answer, not as a failure", async () => {
    const rejected = {
      ...quoteFor("10.00"),
      rejected: [{ code: "DEAD", reason: "expired", message: "This code has expired." }],
    };
    depositQuote.mockResolvedValue(rejected);
    const { result } = renderHook(() =>
      useDepositQuote({ gateway: GATEWAY, amount: "10.00", codes: ["DEAD"] }),
    );
    await settle();

    expect(result.current.error).toBeNull();
    expect(result.current.quote?.rejected[0].message).toBe("This code has expired.");
  });

  it("keeps no breakdown when the quote fails, and asks again on retry", async () => {
    depositQuote.mockRejectedValueOnce(
      new ApiError("This gateway is unavailable right now.", { status: 503 }),
    );
    depositQuote.mockResolvedValueOnce(quoteFor("10.00"));
    const { result } = renderHook(() =>
      useDepositQuote({ gateway: GATEWAY, amount: "10.00", codes: [] }),
    );
    await settle();

    expect(result.current.quote).toBeNull();
    expect((result.current.error as ApiError).message).toBe("This gateway is unavailable right now.");

    act(() => result.current.retry());
    await settle();
    expect(result.current.quote).not.toBeNull();
    expect(result.current.error).toBeNull();
  });
});

describe("the amount box works in cents", () => {
  it("reads a decimal string and writes one back", () => {
    expect(toCents("10")).toBe(1000);
    expect(toCents("10.5")).toBe(1050);
    expect(toCents("0.07")).toBe(7);
    expect(fromCents(1050)).toBe("10.50");
    expect(fromCents(7)).toBe("0.07");
  });

  it("refuses what is not an amount rather than answering NaN", () => {
    expect(toCents("")).toBeNull();
    expect(toCents("abc")).toBeNull();
    expect(toCents("1.234")).toBeNull();
    expect(toCents("-1")).toBeNull();
  });

  it("survives the round trip a slider makes of a third of a dollar", () => {
    // 0.1 + 0.2 in floats is the reason this is integer arithmetic.
    expect(fromCents(toCents("0.10")! + toCents("0.20")!)).toBe("0.30");
  });
});

describe("presetAmounts", () => {
  it("comes from the gateway's own range, not from a constant", () => {
    const presets = presetAmounts("1.00", "500.00");
    expect(presets[0]).toBe("1.00");
    expect(presets).toContain("500.00");
    expect(presets.every((p) => toCents(p)! >= 100 && toCents(p)! <= 50000)).toBe(true);
  });

  it("drops every step a narrow gateway cannot take", () => {
    expect(presetAmounts("100.00", "150.00")).toEqual(["100.00", "150.00"]);
  });

  it("offers nothing rather than an unusable step when the range is empty", () => {
    expect(presetAmounts("100.00", "50.00")).toEqual([]);
    expect(presetAmounts("nonsense", "50.00")).toEqual([]);
  });

  it("builds the ladder for a gateway that left either end of its range open", () => {
    expect(presetAmounts(null, null)).toEqual(["1.00", "2.00", "5.00", "10.00", "20.00", "50.00"]);
    expect(presetAmounts("5.00", null)).toEqual(["5.00", "10.00", "25.00", "50.00", "100.00", "250.00"]);
    expect(presetAmounts(null, "8.00")).toEqual(["1.00", "2.00", "5.00", "8.00"]);
  });
});

describe("fromMinor", () => {
  it("splits the gateway's minor units on the digits, never through a float", () => {
    // A rial charge past 2^53 minor units still reads correctly, which is why
    // this is string work and not division.
    expect(fromMinor("420000", 0)).toBe("420000");
    expect(fromMinor("99999999999999999999", 0)).toBe("99999999999999999999");
    expect(fromMinor("7", 2)).toBe("0.07");
    expect(fromMinor("1234", 2)).toBe("12.34");
  });

  it("answers null for anything it cannot split, so the caller hides the line", () => {
    expect(fromMinor("12.3", 2)).toBeNull();
    expect(fromMinor("-5", 2)).toBeNull();
    expect(fromMinor("5", -1)).toBeNull();
  });
});

/**
 * A rial gateway's charge, as the page says it to a person: in toman, which is
 * what an Iranian reads a price in. Ten rial to the toman is a unit, not a rate,
 * so this is exact decimal work on the string — never `/ 10` on a float.
 */
describe("tomanFromRial", () => {
  it("divides whole rial by ten exactly", () => {
    expect(tomanFromRial("4563010")).toBe("456301");
    expect(tomanFromRial("10")).toBe("1");
  });

  it("keeps the odd rial as a tenth of a toman instead of rounding it away", () => {
    expect(tomanFromRial("4563015")).toBe("456301.5");
    expect(tomanFromRial("5")).toBe("0.5");
  });

  it("answers null for anything that is not whole rial", () => {
    expect(tomanFromRial("12.5")).toBeNull();
    expect(tomanFromRial("")).toBeNull();
  });
});

/** F-093-k: the list the tenant or the gateway set wins; without one, the ladder. */
describe("offeredPresets", () => {
  const gateway = { minAmount: "1.00", maxAmount: "500.00" };

  it("offers the configured list as billing answered it", () => {
    expect(offeredPresets({ ...gateway, presets: ["2.00", "2.50"] })).toEqual(["2.00", "2.50"]);
  });

  it("falls back to the automatic ladder when nothing is configured", () => {
    expect(offeredPresets({ ...gateway, presets: [] })).toEqual(presetAmounts("1.00", "500.00"));
    expect(offeredPresets(gateway)).toEqual(presetAmounts("1.00", "500.00"));
  });
});
