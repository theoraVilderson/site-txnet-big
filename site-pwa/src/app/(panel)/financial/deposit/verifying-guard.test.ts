import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { billingApi, type WalletPaymentRow } from "@/lib/billing-api";
import { paymentTone, STATUS_TONES, VERIFYING_TONE } from "../_lib/tones";
import { useVerifyingGuard, VERIFYING_QUERY } from "./_hooks/useVerifyingGuard";

/**
 * A verifying payment on the top-up and financial pages (F-093-m, ADR-0044
 * decision 7). What breaks silently:
 *  - a payer whose money may already be at the gateway pays again without
 *    being told — the second payment is the whole reason for this row;
 *  - the warning becomes a block. The user chose warn-and-confirm (2026-09-14):
 *    an explicit "pay anyway" must always go through;
 *  - a failed check stops a payment. The warning is a courtesy, never a gate;
 *  - the badge reads "pending" (or gold) for a payment that is being verified.
 */

vi.mock("@/lib/billing-api", () => ({ billingApi: { walletPayments: vi.fn() } }));
const walletPayments = vi.mocked(billingApi.walletPayments);

const row = (overrides: Partial<WalletPaymentRow> = {}): WalletPaymentRow => ({
  currencyCode: "USD",
  id: "77777777-7777-4777-8777-777777777777",
  status: "pending",
  amountRequested: "10.00",
  fee: "0.00",
  tax: "0.00",
  taxRatePercent: null,
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
  ...overrides,
});

const page = (rows: WalletPaymentRow[]) => ({ total: rows.length, page: 1, pageSize: 20, rows });

beforeEach(() => {
  walletPayments.mockReset();
});

describe("paymentTone", () => {
  it("names a verifying payment as verifying, not pending", () => {
    expect(paymentTone(row())).toBe(VERIFYING_TONE);
    expect(paymentTone(row({ verifying: false }))).toBe(STATUS_TONES.pending);
    expect(paymentTone(row({ status: "success", verifying: false }))).toBe(STATUS_TONES.success);
  });

  it("is theme green, never gold", () => {
    expect(VERIFYING_TONE.className).not.toMatch(/gold/);
  });
});

describe("useVerifyingGuard", () => {
  it("asks only for pending attempts", async () => {
    walletPayments.mockResolvedValue(page([]));
    renderHook(() => useVerifyingGuard());
    await waitFor(() => expect(walletPayments).toHaveBeenCalled());
    expect(VERIFYING_QUERY).toContain("statuses=pending");
    expect(walletPayments).toHaveBeenCalledWith(VERIFYING_QUERY);
  });

  it("shows the verifying payment it found when the page opens", async () => {
    walletPayments.mockResolvedValue(page([row({ verifying: false, id: "a" }), row({ id: "b" })]));
    const { result } = renderHook(() => useVerifyingGuard());
    await waitFor(() => expect(result.current.verifying?.id).toBe("b"));
  });

  it("warns instead of paying while a payment is verifying, and pays on an explicit confirm", async () => {
    walletPayments.mockResolvedValue(page([row()]));
    const proceed = vi.fn();
    const { result } = renderHook(() => useVerifyingGuard());

    await act(() => result.current.guard(proceed));
    expect(proceed).not.toHaveBeenCalled();
    expect(result.current.warning?.id).toBe(row().id);

    act(() => result.current.confirm());
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(result.current.warning).toBeNull();
  });

  it("drops the payment on cancel", async () => {
    walletPayments.mockResolvedValue(page([row()]));
    const proceed = vi.fn();
    const { result } = renderHook(() => useVerifyingGuard());

    await act(() => result.current.guard(proceed));
    act(() => result.current.cancel());
    expect(result.current.warning).toBeNull();
    expect(proceed).not.toHaveBeenCalled();
  });

  it("pays straight away when nothing is verifying", async () => {
    walletPayments.mockResolvedValue(page([row({ verifying: false })]));
    const proceed = vi.fn();
    const { result } = renderHook(() => useVerifyingGuard());

    await act(() => result.current.guard(proceed));
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it("never blocks a payment because the check itself failed", async () => {
    walletPayments.mockRejectedValue(new Error("offline"));
    const proceed = vi.fn();
    const { result } = renderHook(() => useVerifyingGuard());

    await act(() => result.current.guard(proceed));
    expect(proceed).toHaveBeenCalledTimes(1);
  });
});
