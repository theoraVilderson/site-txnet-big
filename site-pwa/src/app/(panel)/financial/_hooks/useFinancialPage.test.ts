import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { RealtimeEvents } from "@/generated/wire";
import { billingApi } from "@/lib/billing-api";
import { userChannel } from "@/lib/realtime";
import { usePanelRealtime } from "../../_context/PanelRealtimeContext";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { parseFilters } from "../_lib/filters";
import { useFinancialPage } from "./useFinancialPage";

/**
 * A card-to-card payment confirmed by staff or by the reseller (F-093-v) moves
 * on the server while the payer's financial page is open. The page re-reads on
 * the payer's `user:` channel (RT-1, C-14) — quietly, with no skeleton over the
 * list — instead of showing "pending" until a reload.
 */

vi.mock("../../_context/PanelSessionContext", () => ({ usePanelSession: vi.fn() }));
vi.mock("../../_context/PanelRealtimeContext", () => ({ usePanelRealtime: vi.fn() }));
vi.mock("@/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing-api")>()),
  billingApi: { walletPayments: vi.fn(), walletHistory: vi.fn() },
}));

const payments = vi.mocked(billingApi.walletPayments);

function fakeClient() {
  const listeners: Array<(payload: unknown) => void> = [];
  return {
    channels: [] as string[],
    listeners,
    subscribe: vi.fn((channel: string, options: { onMessage: (p: unknown) => void }) => {
      client.channels.push(channel);
      listeners.push(options.onMessage);
      return vi.fn();
    }),
  };
}
let client: ReturnType<typeof fakeClient>;

const hear = (payload: unknown) =>
  act(async () => {
    for (const onMessage of client.listeners) onMessage(payload);
  });

const page = (status: string) => ({ rows: [{ id: "p1", status }], total: 1 }) as never;
const PAYMENTS_TAB = parseFilters(new URLSearchParams("tab=payments"));

beforeEach(() => {
  vi.clearAllMocks();
  client = fakeClient();
  vi.mocked(usePanelSession).mockReturnValue({ group: { current: { userId: "u-1" } } } as never);
  vi.mocked(usePanelRealtime).mockReturnValue(client as never);
  payments.mockResolvedValue(page("pending"));
});

describe("useFinancialPage — live re-read", () => {
  it.each([
    ["confirmed", "success"],
    ["rejected", "failed"],
    ["expired", "expired"],
  ])("re-reads quietly when a payment it shows is %s", async (_, after) => {
    const { result } = renderHook(() => useFinancialPage(PAYMENTS_TAB));
    await waitFor(() => expect(result.current.payments?.[0].status).toBe("pending"));
    expect(client.channels).toEqual([userChannel("u-1")]);

    payments.mockResolvedValue(page(after));
    await hear({ type: RealtimeEvents.paymentChanged, paymentId: "p1" });

    expect(result.current.isLoading).toBe(false);
    await waitFor(() => expect(result.current.payments?.[0].status).toBe(after));
    expect(payments).toHaveBeenCalledTimes(2);
  });

  it("on the payments tab, asks nothing for a payment not on this page, or a bare wallet movement", async () => {
    const { result } = renderHook(() => useFinancialPage(PAYMENTS_TAB));
    await waitFor(() => expect(result.current.payments).not.toBeNull());

    await hear({ type: RealtimeEvents.paymentChanged, paymentId: "p-on-another-page" });
    await hear({ type: RealtimeEvents.paymentChanged }); // no id: whose it is is never guessed
    await hear({ type: RealtimeEvents.walletChanged });
    expect(payments).toHaveBeenCalledTimes(1);
  });

  it("on the ledger tab, re-reads on any wallet movement — a new row shifts every page", async () => {
    vi.mocked(billingApi.walletHistory).mockResolvedValue({ rows: [], total: 0, balance: "0", held: "0", available: "0", currencyCode: "USD" } as never);
    const { result } = renderHook(() => useFinancialPage(parseFilters(new URLSearchParams("tab=ledger"))));
    await waitFor(() => expect(result.current.ledger).not.toBeNull());

    await hear({ type: RealtimeEvents.walletChanged });
    await waitFor(() => expect(billingApi.walletHistory).toHaveBeenCalledTimes(2));
  });

  it("asks nothing for an event that is not about money", async () => {
    const { result } = renderHook(() => useFinancialPage(PAYMENTS_TAB));
    await waitFor(() => expect(result.current.payments).not.toBeNull());

    await hear({ type: RealtimeEvents.grantDelivered, grantId: "g1" });
    expect(payments).toHaveBeenCalledTimes(1);
  });
});
