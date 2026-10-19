import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminGateway, CommissionHistory } from "@/lib/billing-api";
import { ApiError } from "@/lib/api-error";
import { GatewayCommissionSection } from "./_components/GatewayCommissionSection";
import { commissionBodyOf } from "./_lib/commission";
import type { GatewaySurface } from "./_lib/surface";

/**
 * What a gateway's provider deducts (F-1001-w; billing
 * `contract.analytics-expenses.md` "Gateway commission"): the row in effect,
 * the history newest first, and a form that adds a row from a day on — there
 * is no edit. The platform's staff in a reseller's workspace are refused by
 * billing, and the section is then not shown at all.
 */

vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({ lang: "en", t: (_ns: string, key: string, vars?: Record<string, unknown>) => (vars ? `${key}|${JSON.stringify(vars)}` : key) }),
}));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => () => "failed" }));
// The calendar's stylesheet does not load under vitest; a plain field stands in for it.
vi.mock("../_components/kit/DatePicker", () => ({
  DatePicker: ({ label, value, onChange }: { label?: string; value: string | null; onChange: (v: string | null) => void }) => (
    <input aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} />
  ),
}));

const gateway = { source: "tenant", id: "gw-1", tenantId: "r-1" } as unknown as AdminGateway;
const commission = vi.fn();
const addCommission = vi.fn();
const surface = { tenantId: "r-1", api: { commission, addCommission } } as unknown as GatewaySurface;

const HISTORY: CommissionHistory = {
  commissions: [
    { id: "c-2", percent: "1.5", fixedAmount: "0", currencyCode: "USD", effectiveFrom: "2026-10-01", createdByUserId: null, createdAt: "2026-10-01T08:00:00Z" },
    { id: "c-1", percent: "2", fixedAmount: "0.1", currencyCode: "USD", effectiveFrom: "2026-01-01", createdByUserId: null, createdAt: "2026-01-01T08:00:00Z" },
  ],
  inEffect: "c-2",
  currencyCode: "USD",
};

beforeEach(() => {
  vi.clearAllMocks();
  commission.mockResolvedValue(HISTORY);
  addCommission.mockImplementation(async (_s: string, _id: string, body: { percent: string; fixedAmount: string; effectiveFrom: string }) => ({ id: "c-3", ...body, currencyCode: "USD", createdByUserId: null, createdAt: "" }));
});

describe("commissionBodyOf", () => {
  it("takes a percent 0..100 at four places, a fixed amount at or above zero, and a day", () => {
    expect(commissionBodyOf({ percent: "1.5", fixedAmount: "", effectiveFrom: "2026-10-01" })).toEqual({ body: { percent: "1.5", fixedAmount: "0", effectiveFrom: "2026-10-01" } });
    expect(commissionBodyOf({ percent: "", fixedAmount: "0.25", effectiveFrom: "2026-10-01" })).toEqual({ body: { percent: "0", fixedAmount: "0.25", effectiveFrom: "2026-10-01" } });
  });

  it("names the first field billing would refuse", () => {
    expect(commissionBodyOf({ percent: "100.5", fixedAmount: "0", effectiveFrom: "2026-10-01" })).toEqual({ error: "percent" });
    expect(commissionBodyOf({ percent: "1.23456", fixedAmount: "0", effectiveFrom: "2026-10-01" })).toEqual({ error: "percent" });
    expect(commissionBodyOf({ percent: "1", fixedAmount: "-1", effectiveFrom: "2026-10-01" })).toEqual({ error: "fixedAmount" });
    expect(commissionBodyOf({ percent: "1", fixedAmount: "0", effectiveFrom: null })).toEqual({ error: "effectiveFrom" });
  });
});

describe("GatewayCommissionSection", () => {
  it("reads the gateway's history on its surface and marks the row in effect", async () => {
    render(<GatewayCommissionSection gateway={gateway} surface={surface} />);
    const rows = await screen.findAllByRole("listitem");
    expect(commission).toHaveBeenCalledWith("tenant", "gw-1");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("gateways.commission.inEffect");
    expect(rows[1].textContent).not.toContain("gateways.commission.inEffect");
  });

  it("adds a row from the day given, then reads the history again", async () => {
    render(<GatewayCommissionSection gateway={gateway} surface={surface} />);
    await screen.findAllByRole("listitem");
    fireEvent.change(screen.getByLabelText("gateways.commission.percent"), { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: "gateways.commission.add" }));

    await waitFor(() => expect(addCommission).toHaveBeenCalledWith("tenant", "gw-1", expect.objectContaining({ percent: "2.5", fixedAmount: "0" })));
    await waitFor(() => expect(commission).toHaveBeenCalledTimes(2));
  });

  it("says no commission is counted before the first row", async () => {
    commission.mockResolvedValue({ commissions: [], inEffect: null, currencyCode: "USD" });
    render(<GatewayCommissionSection gateway={gateway} surface={surface} />);
    expect(await screen.findByText("gateways.commission.none")).toBeTruthy();
  });

  it("is not shown to someone billing refuses — the platform's staff in a reseller's workspace", async () => {
    commission.mockRejectedValue(new ApiError("not_allowed", { status: 403, reason: "not_allowed" }));
    const { container } = render(<GatewayCommissionSection gateway={gateway} surface={surface} />);
    await waitFor(() => expect(commission).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(""));
  });
});
