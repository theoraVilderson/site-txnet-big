import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocale } from "@/context/LocaleContext";
import { VariantFields } from "./_components/VariantFields";
import { emptyVariantForm, validateVariantForm, variantBody, type VariantForm } from "./_lib/catalog-form";
import { MAX_SALES_CAP } from "./_lib/sales-cap";

/**
 * A sales cap from the first moment of a variant (F-513-e, catalog F-513,
 * `panel-web/contract.catalog.md` rule 10h): "new variant" and the wizard's
 * variant step share `VariantFields`, so one optional box serves both. Blank
 * is no cap and sends nothing; anything else is the card's rule
 * (`parseSalesCap`), refused before the call, and sent as `salesCap` on
 * `POST /products/:id/variants`.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("./_lib/surface", () => ({ usePricedIn: () => null }));
// The metered-only rate fields reach the date picker, whose stylesheet jsdom cannot load.
vi.mock("../_components/kit/DatePicker", () => ({ DatePicker: () => null }));

const t = (_ns: string, key: string) => key;
const priced = (patch: Partial<VariantForm> = {}): VariantForm => ({ ...emptyVariantForm(), sku: "VPN-30", price: "12.50", ...patch });

beforeEach(() => {
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as unknown as ReturnType<typeof useLocale>);
});

describe("a new variant's sales cap", () => {
  it("is a box on the variant's fields that writes salesCap", async () => {
    const set = vi.fn();
    render(<VariantFields form={priced()} set={set} errors={{}} productKey="vpn" kind="feature_access" groups={{ options: [], failed: false }} />);
    await userEvent.type(screen.getByRole("textbox", { name: /catalog\.salesCap\.label/ }), "7");
    expect(set).toHaveBeenLastCalledWith("salesCap", "7");
  });

  it("sends no salesCap when left blank", () => {
    expect(validateVariantForm(priced())).toEqual({});
    expect(variantBody(priced(), "feature_access")).not.toHaveProperty("salesCap");
  });

  it("sends the typed whole number", () => {
    expect(validateVariantForm(priced({ salesCap: " 25 " }))).toEqual({});
    expect(variantBody(priced({ salesCap: " 25 " }), "feature_access")).toMatchObject({ salesCap: 25 });
  });

  it.each(["0", "1.5", "-3", "abc", String(MAX_SALES_CAP + 1)])("refuses %s before the call, as the card does", (typed) => {
    expect(validateVariantForm(priced({ salesCap: typed }))).toEqual({ salesCap: "catalog.errors.salesCap" });
  });
});
