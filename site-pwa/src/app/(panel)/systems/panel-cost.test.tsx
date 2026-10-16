import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { billingApi } from "@/lib/billing-api";
import { PanelCost } from "./_components/PanelCost";
import { firstOpenDay, panelCostBodyOf } from "./_lib/panel-cost";

/**
 * A panel's monthly cost on `/systems` (F-1002-c; network
 * `contract.panel-cost.md`). What goes wrong here quietly:
 *
 *  - **a float for money.** The amount goes as the decimal string typed, at
 *    most two places, never a number (C-02);
 *  - **a closed month priced.** A date before this month's first day is
 *    refused here before billing refuses it, with the same sentence;
 *  - **an edit where history belongs.** A save adds a price; the old ones
 *    stay listed under it, newest first.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => () => "generic" }));
vi.mock("@/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing-api")>()),
  billingApi: { panelCost: vi.fn(), setPanelCost: vi.fn() },
}));

const PANEL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);
const price = (usd: string, from: string) => ({ monthlyCostUsd: usd, effectiveFrom: from, createdByUserId: null, createdAt: `${from}T08:00:00.000Z` });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLocale).mockReturnValue({ lang: "en", isRtl: false, t } as unknown as ReturnType<typeof useLocale>);
  vi.mocked(billingApi.panelCost).mockResolvedValue({ current: price("40.00", "2026-09-01"), history: [price("40.00", "2026-09-01")] });
});

describe("panelCostBodyOf", () => {
  it("sends the amount as typed and the day, or says what is wrong", () => {
    expect(panelCostBodyOf({ amount: "12.5", from: "2026-10-16" }, "2026-10-16")).toEqual({ body: { monthlyCostUsd: "12.5", effectiveFrom: "2026-10-16" } });
    expect(panelCostBodyOf({ amount: "12.505", from: "2026-10-16" }, "2026-10-16")).toEqual({ error: "amount" });
    expect(panelCostBodyOf({ amount: "-1", from: "2026-10-16" }, "2026-10-16")).toEqual({ error: "amount" });
    expect(panelCostBodyOf({ amount: "", from: "2026-10-16" }, "2026-10-16")).toEqual({ error: "amount" });
    expect(panelCostBodyOf({ amount: "10", from: "2026-09-30" }, "2026-10-16")).toEqual({ error: "closedMonth" });
    expect(panelCostBodyOf({ amount: "10", from: "2026-10-01" }, "2026-10-16")).toEqual({ body: { monthlyCostUsd: "10", effectiveFrom: "2026-10-01" } });
  });

  it("opens on the first day of the reader's UTC month", () => {
    expect(firstOpenDay("2026-10-16")).toBe("2026-10-01");
  });
});

describe("PanelCost", () => {
  it("shows the price in effect and the history, and adds a price — never edits one", async () => {
    vi.mocked(billingApi.setPanelCost).mockResolvedValue({ current: price("60.00", "2026-10-16"), history: [price("60.00", "2026-10-16"), price("40.00", "2026-09-01")] });
    render(<PanelCost panelId={PANEL} today="2026-10-16" />);
    expect((await screen.findAllByText(/40\.00/)).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("systems.cost.amount"), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "systems.cost.save" }));
    await waitFor(() => expect(billingApi.setPanelCost).toHaveBeenCalledWith(PANEL, { monthlyCostUsd: "60", effectiveFrom: "2026-10-16" }));
    expect((await screen.findAllByText(/60\.00/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/40\.00/).length).toBeGreaterThan(0);
  });

  it("says no cost is set before the first price", async () => {
    vi.mocked(billingApi.panelCost).mockResolvedValue({ current: null, history: [] });
    render(<PanelCost panelId={PANEL} today="2026-10-16" />);
    expect(await screen.findByText("systems.cost.none")).toBeTruthy();
  });

  it("refuses a closed month before asking billing", async () => {
    render(<PanelCost panelId={PANEL} today="2026-10-16" />);
    await screen.findAllByText(/40\.00/);
    fireEvent.change(screen.getByLabelText("systems.cost.amount"), { target: { value: "60" } });
    fireEvent.change(screen.getByLabelText("systems.cost.from"), { target: { value: "2026-09-30" } });
    expect(screen.getByText("systems.refusals.cost_in_closed_month")).toBeTruthy();
    expect((screen.getByRole("button", { name: "systems.cost.save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
