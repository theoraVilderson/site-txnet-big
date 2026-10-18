import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocale } from "@/context/LocaleContext";
import type { CatalogVariant } from "@/lib/catalog-api";
import { ActiveCapSection } from "./_components/SalesCapSection";
import { VariantFields } from "./_components/VariantFields";
import { emptyVariantForm, validateVariantForm, variantBody, type VariantForm } from "./_lib/catalog-form";
import { MAX_SALES_CAP } from "./_lib/sales-cap";

/**
 * A variant's active cap on the catalog page (F-514-d, catalog F-514,
 * `panel-web/contract.catalog.md` rule 10h): at most N live services at once.
 * The card shows billing's `active` — live, held by unpaid invoices, left —
 * sets a whole number 1..`MAX_SALES_CAP` (billing's schema takes the same
 * ceiling for both caps) or clears it to `null`, and says when it is full.
 * "New variant" and the wizard share `VariantFields`: blank sends no
 * `activeCap`, anything else the card's rule. The shop's sold-out pill needs
 * nothing: billing's `soldOut` is either cap full (`sold-out.test.tsx`).
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
const updateVariant = vi.hoisted(() => vi.fn());
vi.mock("./_lib/surface", () => ({ usePricedIn: () => null, useCatalogSurface: () => ({ api: { updateVariant } }) }));
// The metered-only rate fields reach the date picker, whose stylesheet jsdom cannot load.
vi.mock("../_components/kit/DatePicker", () => ({ DatePicker: () => null }));

const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);
const priced = (patch: Partial<VariantForm> = {}): VariantForm => ({ ...emptyVariantForm(), sku: "VPN-30", price: "12.50", ...patch });
const VARIANT = { id: "var-1", active: { cap: 50, live: 41, held: 2, remaining: 7, full: false } } as CatalogVariant;

beforeEach(() => {
  updateVariant.mockReset();
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as unknown as ReturnType<typeof useLocale>);
});

describe("the variant card's active cap", () => {
  const renderCap = (variant = VARIANT) => {
    const act = vi.fn(async (run: () => Promise<unknown>) => void (await run()));
    render(<ActiveCapSection variant={variant} act={act} />);
  };
  const box = () => screen.getByRole("textbox", { name: /catalog\.activeCap\.label/ });

  it("shows live / cap, what unpaid invoices hold and what is left", () => {
    renderCap();
    expect(box()).toHaveValue("50");
    expect(screen.getByText("catalog.activeCap.counts:41,50,2,7")).toBeInTheDocument();
  });

  it("sets a whole-number cap and clears it to none", async () => {
    renderCap();
    await userEvent.clear(box());
    await userEvent.type(box(), "80");
    await userEvent.click(screen.getByRole("button", { name: "catalog.activeCap.save" }));
    expect(updateVariant).toHaveBeenCalledWith("var-1", { activeCap: 80 });
    await userEvent.click(screen.getByRole("button", { name: "catalog.activeCap.clear" }));
    expect(updateVariant).toHaveBeenLastCalledWith("var-1", { activeCap: null });
  });

  it.each(["0", "2.5", "-1", "x", String(MAX_SALES_CAP + 1)])("refuses %s before any call", async (typed) => {
    renderCap();
    await userEvent.clear(box());
    await userEvent.type(box(), typed);
    await userEvent.click(screen.getByRole("button", { name: "catalog.activeCap.save" }));
    expect(screen.getByText("catalog.salesCap.invalid:" + MAX_SALES_CAP)).toBeInTheDocument();
    expect(updateVariant).not.toHaveBeenCalled();
  });

  it("with no cap offers no clear and counts the live services", () => {
    renderCap({ ...VARIANT, active: { cap: null, live: 3, held: 0, remaining: null, full: false } });
    expect(screen.queryByRole("button", { name: "catalog.activeCap.clear" })).toBeNull();
    expect(screen.getByText("catalog.activeCap.uncapped:3")).toBeInTheDocument();
  });
});

describe("a new variant's active cap", () => {
  it("is a box on the variant's fields that writes activeCap", async () => {
    const set = vi.fn();
    render(<VariantFields form={priced()} set={set} errors={{}} productKey="vpn" kind="feature_access" groups={{ options: [], failed: false }} />);
    await userEvent.type(screen.getByRole("textbox", { name: /catalog\.activeCap\.label/ }), "9");
    expect(set).toHaveBeenLastCalledWith("activeCap", "9");
  });

  it("sends none when blank and the typed whole number otherwise", () => {
    expect(variantBody(priced(), "feature_access")).not.toHaveProperty("activeCap");
    expect(validateVariantForm(priced({ activeCap: " 40 " }))).toEqual({});
    expect(variantBody(priced({ activeCap: " 40 " }), "feature_access")).toMatchObject({ activeCap: 40 });
  });

  it.each(["0", "1.5", "abc", String(MAX_SALES_CAP + 1)])("refuses %s before the call", (typed) => {
    expect(validateVariantForm(priced({ activeCap: typed }))).toEqual({ activeCap: "catalog.errors.salesCap" });
  });
});
