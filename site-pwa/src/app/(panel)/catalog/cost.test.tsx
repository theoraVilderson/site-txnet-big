import { fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { catalogCostApi } from "@/lib/catalog-cost-api";
import { costFrom, currentCost, isCostSet, validateMeterCost, validateVariantCost } from "./_lib/cost-form";
import { VariantCostSection } from "./_components/VariantCostSection";
import { historyOf, useProductVariantCosts } from "./_hooks/useProductVariantCosts";

/**
 * A product's cost in the catalog (F-1002-g, ADR-0151, panel-web
 * `contract.catalog-cost.md`).
 *
 * The ways this goes wrong quietly:
 *
 *  - **a variant with no cost looks fine.** Its Profit row reads 100%; the
 *    section says "no cost set" until one is written;
 *  - **a cost from a closed month.** Billing refuses it; the choices are "from
 *    now" and "from the 1st of this UTC month" only, the latter costing this
 *    month's sales too;
 *  - **a unit cost rounded away.** A meter's unit cost keeps 8 places, as a
 *    rate card's (`0.00004` per call is a real price);
 *  - **a cost taken back read as a cost** (F-1002-j). A row with no amount is
 *    "no cost set" again — in effect and in the history — never `null` or 0;
 *  - **a read per variant** (LIVE-1-d). A product sheet reads every variant's
 *    history in one call; a card reads its own only after a write, or a
 *    32-variant product runs the caller out of `CATALOG_ADMIN_READ`.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("./_lib/surface", () => ({ useCatalogSurface: () => ({ tenantId: null }) }));
vi.mock("@/lib/catalog-cost-api", () => ({ catalogCostApi: vi.fn() }));

const NOW = new Date("2026-10-17T10:00:00Z");
const row = (amount: string | null, effectiveFrom: string) => ({ id: effectiveFrom, amount, currencyCode: "USD", effectiveFrom, createdAt: effectiveFrom });

beforeEach(() => {
  vi.mocked(useLocale).mockReturnValue({ lang: "en", isRtl: false, t: (_ns: string, key: string) => key } as unknown as ReturnType<typeof useLocale>);
});

describe("the cost form", () => {
  it("takes a cost per sale of 0 or more a money column holds, and a unit cost to 8 places", () => {
    expect(validateVariantCost("2.50")).toBeNull();
    expect(validateVariantCost("0")).toBeNull();
    expect(validateVariantCost("")).not.toBeNull();
    expect(validateVariantCost("-1")).not.toBeNull();
    expect(validateVariantCost("1.23456")).not.toBeNull();
    expect(validateMeterCost({ unitSize: "1000", unitCost: "0.00004" })).toEqual({});
    expect(Object.keys(validateMeterCost({ unitSize: "0", unitCost: "0.000000001" })).sort()).toEqual(["unitCost", "unitSize"]);
  });

  it("starts a cost now, or at the 1st of this UTC month", () => {
    expect(costFrom("now", NOW)).toBeUndefined();
    expect(costFrom("monthStart", NOW)).toBe("2026-10-01T00:00:00.000Z");
  });

  it("reads the newest cost already in effect", () => {
    const rows = [row("3.00", "2026-11-01T00:00:00.000Z"), row("2.00", "2026-10-05T00:00:00.000Z"), row("1.00", "2026-10-01T00:00:00.000Z")];
    expect(currentCost(rows, NOW)?.amount).toBe("2.00");
    expect(currentCost([], NOW)).toBeNull();
  });

  it("reads a take-back in effect as no cost set (F-1002-j)", () => {
    const rows = [row(null, "2026-10-10T00:00:00.000Z"), row("2.00", "2026-10-01T00:00:00.000Z")];
    expect(isCostSet(currentCost(rows, NOW))).toBe(false);
    expect(isCostSet(currentCost(rows, new Date("2026-10-05T00:00:00Z")))).toBe(true);
    expect(isCostSet(null)).toBe(false);
    expect(isCostSet(row("0", "2026-10-01T00:00:00.000Z"))).toBe(true);
  });
});

describe("VariantCostSection", () => {
  it("says no cost is set, then writes one from the start of the month and reads it back", async () => {
    const api = { variantCosts: vi.fn().mockResolvedValue([row("2.50", "2026-10-01T00:00:00.000Z")]), setVariantCost: vi.fn().mockResolvedValue({}) };
    vi.mocked(catalogCostApi).mockReturnValue(api as unknown as ReturnType<typeof catalogCostApi>);
    render(<VariantCostSection variantId="v1" initial={[]} now={NOW} />);

    expect(await screen.findByText("catalog.cost.none")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/cost\.amount/), { target: { value: "2.50" } });
    fireEvent.click(screen.getByRole("radio", { name: "catalog.cost.fromMonthStart" }));
    fireEvent.click(screen.getByRole("button", { name: "catalog.cost.save" }));

    await waitFor(() => expect(api.setVariantCost).toHaveBeenCalledWith("v1", { amount: "2.50", effectiveFrom: "2026-10-01T00:00:00.000Z" }));
    await waitFor(() => expect(screen.queryByText("catalog.cost.none")).not.toBeInTheDocument());
    // The sheet's read stood in for the mount's; the one read is the write's own.
    expect(api.variantCosts).toHaveBeenCalledTimes(1);
  });

  it("waits for the sheet's read, and says the history failed when that read did", () => {
    const api = { variantCosts: vi.fn() };
    vi.mocked(catalogCostApi).mockReturnValue(api as unknown as ReturnType<typeof catalogCostApi>);
    const { rerender } = render(<VariantCostSection variantId="v1" initial={null} now={NOW} />);
    expect(screen.queryByText("catalog.cost.none")).not.toBeInTheDocument();
    rerender(<VariantCostSection variantId="v1" initial="failed" now={NOW} />);
    expect(screen.getByText("catalog.cost.loadFailed")).toBeInTheDocument();
    expect(api.variantCosts).not.toHaveBeenCalled();
  });

  it("takes a cost back from now: no cost set again, the take-back 'not set' in the history (F-1002-j)", async () => {
    const before = [row("2.50", "2026-10-01T00:00:00.000Z")];
    const after = [row(null, "2026-10-17T09:00:00.000Z"), ...before];
    const api = { variantCosts: vi.fn().mockResolvedValue(after), unsetVariantCost: vi.fn().mockResolvedValue({}) };
    vi.mocked(catalogCostApi).mockReturnValue(api as unknown as ReturnType<typeof catalogCostApi>);
    render(<VariantCostSection variantId="v1" initial={before} now={NOW} />);

    fireEvent.click(await screen.findByRole("button", { name: "catalog.cost.unset" }));
    await waitFor(() => expect(api.unsetVariantCost).toHaveBeenCalledWith("v1", {}));
    expect(await screen.findByText("catalog.cost.none")).toBeInTheDocument();
    // Nothing to take back any more.
    expect(screen.queryByRole("button", { name: "catalog.cost.unset" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /catalog\.cost\.history/ }));
    expect(screen.getAllByText("catalog.cost.notSet").length).toBeGreaterThan(0);
  });
});

describe("a product's variant costs, read once (LIVE-1-d)", () => {
  it("reads the product's every variant in one call, and gives a variant the read never saw an empty history", async () => {
    const byVariant = { v1: [row("2.50", "2026-10-01T00:00:00.000Z")], v2: [] };
    const api = { productVariantCosts: vi.fn().mockResolvedValue(byVariant) };
    vi.mocked(catalogCostApi).mockReturnValue(api as unknown as ReturnType<typeof catalogCostApi>);
    const { result } = renderHook(() => useProductVariantCosts("p1"));

    expect(historyOf(result.current, "v1")).toBeNull();
    await waitFor(() => expect(historyOf(result.current, "v1")).toEqual(byVariant.v1));
    // A variant added after the read has no cost yet.
    expect(historyOf(result.current, "v3")).toEqual([]);
    expect(api.productVariantCosts).toHaveBeenCalledTimes(1);
    expect(api.productVariantCosts).toHaveBeenCalledWith("p1");
  });

  it("answers failed for every variant when the read fails", async () => {
    vi.mocked(catalogCostApi).mockReturnValue({ productVariantCosts: vi.fn().mockRejectedValue(new Error("429")) } as unknown as ReturnType<typeof catalogCostApi>);
    const { result } = renderHook(() => useProductVariantCosts("p1"));
    await waitFor(() => expect(historyOf(result.current, "v1")).toBe("failed"));
  });
});
