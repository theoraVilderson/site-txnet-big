import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocale } from "@/context/LocaleContext";
import { RealtimeEvents } from "@/generated/wire";
import { billingApi, type ShopOffer } from "@/lib/billing-api";
import type { CatalogVariant } from "@/lib/catalog-api";
import { catalogChannel, PLATFORM_CATALOG } from "@/lib/realtime";
import { ShopView } from "./_components/ShopView";
import { SalesCapSection } from "../catalog/_components/SalesCapSection";
import { MAX_SALES_CAP } from "../catalog/_lib/sales-cap";

/**
 * A variant's sales cap on the panel (F-513-c, catalog F-513,
 * `panel-web/contract.shop.md` and `contract.catalog.md`):
 *
 * > **Sold out is shown, never hidden, and never bought.** Billing lists a
 * > sold-out variant marked `soldOut` (catalog `contract.sales-cap.md` rule 6);
 * > the card names it and its buy is off, so no shopper walks into the
 * > invoice's 409.
 *
 * > **It changes without a refresh.** Every move of a capped variant's counts
 * > writes `catalog.variant.sales_changed` on its owner's catalog channel —
 * > `catalog:platform` for the platform's, which every shop sells from (RT-1-p).
 * > The shop hears both its own tenant's and the platform's and re-reads.
 *
 * > **The cap is set or cleared on the variant**, a whole number 1..1 000 000
 * > as billing's schema takes it, and the card shows what is sold and held.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing-api")>()),
  billingApi: { shopOffers: vi.fn() },
}));
vi.mock("../_hooks/useWalletBalance", () => ({ useWalletBalance: () => ({ available: null, currencyCode: null }) }));
vi.mock("@/lib/catalog-api", () => ({ catalogApi: { texts: vi.fn().mockRejectedValue(new Error("404")) } }));
vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: () => ({ me: { tenant: { id: "t-reseller" } } }) }));
const live = vi.hoisted(() => ({ calls: [] as Array<{ channel: string | null; types: readonly string[] | "any"; reread: (cause: string) => void }> }));
vi.mock("@/hooks/useLiveReread", () => ({
  useLiveReread: (channel: string | null, types: readonly string[] | "any", reread: (cause: string) => void) => live.calls.push({ channel, types, reread }),
}));
const updateVariant = vi.hoisted(() => vi.fn());
vi.mock("../catalog/_lib/surface", () => ({ useCatalogSurface: () => ({ api: { updateVariant } }) }));

const shopOffers = vi.mocked(billingApi.shopOffers);
const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);

const OFFER: ShopOffer = {
  currencyCode: "USD",
  variantId: "v-30",
  sku: "VPN-30",
  nameKey: "catalog.product.vpn.name",
  productId: "p-vpn",
  productNameKey: "catalog.product.vpn.name",
  descriptionKey: null,
  categoryKey: "vpn",
  categories: [{ key: "vpn", nameKey: "catalog.category.vpn.name" }],
  fulfilmentKind: "network_access",
  durationDays: 30,
  billingMode: "prepaid",
  quotas: {},
  price: "12.50",
  rateCards: [],
  remaining: null,
  soldOut: false,
};
const SOLD_OUT: ShopOffer = { ...OFFER, soldOut: true, remaining: 0 };
const OFFER_90: ShopOffer = { ...OFFER, variantId: "v-90", sku: "VPN-90", durationDays: 90, price: "30.00", remaining: 4 };

const buy = () => screen.getByRole("button", { name: "shop.buy" });

beforeEach(() => {
  vi.clearAllMocks();
  live.calls = [];
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as unknown as ReturnType<typeof useLocale>);
});

describe("a sold-out variant in the shop", () => {
  it("is listed, named sold out, and cannot be bought", async () => {
    shopOffers.mockResolvedValue([SOLD_OUT]);
    render(<ShopView invoiceId={null} />);
    expect(await screen.findByText("shop.soldOut")).toBeInTheDocument();
    expect(buy()).toBeDisabled();
  });

  it("is not the variant a card opens on, and its chip says so", async () => {
    shopOffers.mockResolvedValue([SOLD_OUT, OFFER_90]);
    render(<ShopView invoiceId={null} />);
    const chips = await screen.findAllByRole("radio");
    expect(chips[1]).toHaveAttribute("aria-checked", "true");
    expect(chips[0]).toHaveTextContent("shop.soldOut");
    expect(buy()).toBeEnabled();
    await userEvent.click(chips[0]);
    expect(buy()).toBeDisabled();
  });

  it("re-reads on its catalog's event, own and the platform's, and the card follows", async () => {
    shopOffers.mockResolvedValueOnce([OFFER]).mockResolvedValue([SOLD_OUT]);
    render(<ShopView invoiceId={null} />);
    await waitFor(() => expect(buy()).toBeEnabled());

    const heard = live.calls.filter((c) => c.channel !== null);
    expect(new Set(heard.map((c) => c.channel))).toEqual(new Set([catalogChannel("t-reseller"), catalogChannel(PLATFORM_CATALOG)]));
    for (const c of heard) expect(c.types).toEqual([RealtimeEvents.catalogVariantSalesChanged]);

    await act(async () => heard.at(-1)!.reread("event"));
    await waitFor(() => expect(buy()).toBeDisabled());
    expect(screen.getByText("shop.soldOut")).toBeInTheDocument();
  });
});

const VARIANT = { id: "var-1", sales: { cap: 10, sold: 6, reserved: 1, remaining: 3, soldOut: false } } as CatalogVariant;

describe("the variant's sales cap in the catalog", () => {
  const renderCap = (variant = VARIANT) => {
    const act = vi.fn(async (run: () => Promise<unknown>) => void (await run()));
    render(<SalesCapSection variant={variant} act={act} />);
    return act;
  };

  it("shows what is sold, held and left", () => {
    renderCap();
    expect(screen.getByText("catalog.salesCap.counts:6,1,3")).toBeInTheDocument();
  });

  it("sets a whole-number cap and clears it to none", async () => {
    renderCap();
    const box = screen.getByRole("textbox");
    await userEvent.clear(box);
    await userEvent.type(box, "25");
    await userEvent.click(screen.getByRole("button", { name: "catalog.salesCap.save" }));
    expect(updateVariant).toHaveBeenCalledWith("var-1", { salesCap: 25 });
    await userEvent.click(screen.getByRole("button", { name: "catalog.salesCap.clear" }));
    expect(updateVariant).toHaveBeenLastCalledWith("var-1", { salesCap: null });
  });

  it.each(["0", "1.5", "-3", "abc", String(MAX_SALES_CAP + 1)])("refuses %s before any call, as billing's schema would", async (typed) => {
    renderCap();
    const box = screen.getByRole("textbox");
    await userEvent.clear(box);
    await userEvent.type(box, typed);
    await userEvent.click(screen.getByRole("button", { name: "catalog.salesCap.save" }));
    expect(screen.getByText("catalog.salesCap.invalid:" + MAX_SALES_CAP)).toBeInTheDocument();
    expect(updateVariant).not.toHaveBeenCalled();
  });

  it("offers no clear on a variant with no cap", () => {
    renderCap({ ...VARIANT, sales: { cap: null, sold: 2, reserved: 0, remaining: null, soldOut: false } });
    expect(screen.queryByRole("button", { name: "catalog.salesCap.clear" })).toBeNull();
    expect(screen.getByText("catalog.salesCap.uncapped:2")).toBeInTheDocument();
  });

  it("holds billing's own ceiling", () => {
    const backend = readFileSync(join(__dirname, "../../../../../txnet-backend/billing-service/src/app/catalog/sales-cap.ts"), "utf8");
    expect(backend).toContain(`export const MAX_SALES_CAP = ${MAX_SALES_CAP.toLocaleString("en").replace(/,/g, "_")};`);
  });
});
