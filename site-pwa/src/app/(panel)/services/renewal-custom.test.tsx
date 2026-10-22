import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { ApiError } from "@/lib/api-error";
import { billingApi, type GrantRow, type RenewalPlans, type ShopInvoice } from "@/lib/billing-api";
import { renewalRateApi, type RenewalRates } from "@/lib/catalog-renewal-rates";
import { ConfirmProvider } from "../_components/kit";
import { RenewalRateSection } from "../catalog/_components/RenewalRateSection";
import { Renewal } from "./_components/RenewalSheet";

/**
 * GiB and days typed (F-305-g, panel-web `contract.renewal.md` rule 4 and "The
 * seller's rate").
 *
 * > 4. The custom amount is shown only when the product has a rate in effect:
 * >    GiB and days typed, its bounds shown beside each field, the price read
 * >    live from billing, never multiplied in the browser. A part the Grant
 * >    cannot take has no field.
 *
 * > On a product's editor: the rate in effect, its history newest first, a new
 * > rate from a moment, and «خاموش» as its own row, in the pricing currency.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing-api")>()),
  billingApi: { renewalPlans: vi.fn(), renewalQuote: vi.fn(), createRenewalInvoice: vi.fn(), payInvoice: vi.fn(), invoice: vi.fn(), cancelInvoice: vi.fn() },
}));
const rates = vi.hoisted(() => ({ list: vi.fn(), set: vi.fn(), off: vi.fn() }));
vi.mock("@/lib/catalog-renewal-rates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/catalog-renewal-rates")>()),
  renewalRateApi: vi.fn(() => rates),
}));
vi.mock("../_hooks/useWalletBalance", () => ({
  useWalletBalance: () => ({ balance: "100.00", held: "0.00", available: "100.00", currencyCode: "USD", isLoading: false, error: null, refresh: () => {} }),
}));
vi.mock("@/lib/catalog-api", () => ({ catalogApi: { texts: vi.fn().mockRejectedValue(new Error("404")) } }));
vi.mock("../catalog/_lib/surface", () => ({ usePricedIn: () => "USD", useCatalogSurface: () => ({ tenantId: "t-res" }) }));
// The date picker's stylesheet cannot load in jsdom.
vi.mock("../_components/kit/DatePicker", () => ({
  DatePicker: ({ onChange }: { onChange: (d: string | null) => void }) => <input aria-label="day" onChange={(e) => onChange(e.target.value || null)} />,
}));

const R = FrontendI18nKeys.common.myServices.renew;
const RR = FrontendI18nKeys.common.catalog.renewalRate;
const SHOP = FrontendI18nKeys.common.shop;
const t = (_ns: string, key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.values(vars).join(",")}` : key;
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: ConfirmProvider });

const ROW = {
  id: "g1",
  label: null,
  status: "active",
  startsAt: "2026-10-01T00:00:00.000Z",
  endsAt: "2026-10-31T00:00:00.000Z",
  featureKeys: [],
  variant: { id: "v-30", sku: "VPN-30", nameKey: "catalog.vpn30" },
  billingMode: "prepaid",
  consumedBytes: "0",
  purchasedBytes: "53687091200",
  trafficUnlimited: false,
  trafficCapBytes: null,
  suspendedAt: null,
  purgeAt: null,
  lastTrafficAt: null,
  frozen: false,
  frozenUntil: null,
  freezeMode: null,
  userMayUnfreeze: false,
} satisfies GrantRow;

const CUSTOM = { rateId: "rr-1", pricePerGib: "0.2", pricePerDay: "0.3", currencyCode: "USD", minGib: 5, maxGib: 500, minDays: 1, maxDays: 90 };
const PLANS: RenewalPlans = {
  grantId: "g1",
  ownPlanRenewable: true,
  plans: [{ variantId: "v-30", sku: "VPN-30", nameKey: "catalog.vpn30", current: true, price: "12.50", currencyCode: "USD", campaignEndsAt: null, bytes: "53687091200", days: 30 }],
  custom: CUSTOM,
};
// Deliberately not 20 × 0.2 + 10 × 0.3: the sheet shows billing's figure, never its own.
const QUOTE = { grantId: "g1", gib: 20, days: 10, bytes: "21474836480", amount: "7.77", currencyCode: "USD", rateId: "rr-1" };
const INVOICE: ShopInvoice = {
  id: "inv-c",
  variantId: "v-30",
  sku: "VPN-30",
  nameKey: "catalog.vpn30",
  status: "pending",
  amount: "7.77",
  discount: "0.00",
  total: "7.77",
  currencyCode: "USD",
  applied: [],
  rejected: [],
  renewal: { grantId: "g1", bytes: "21474836480", days: 10 },
  expiresAt: "2099-01-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as ReturnType<typeof useLocale>);
  vi.mocked(billingApi.renewalPlans).mockResolvedValue(PLANS);
  vi.mocked(billingApi.renewalQuote).mockResolvedValue(QUOTE);
  vi.mocked(billingApi.createRenewalInvoice).mockResolvedValue(INVOICE);
  vi.mocked(billingApi.payInvoice).mockResolvedValue({ id: "inv-c", status: "paid", total: "7.77", balanceAfter: "92.23", currencyCode: "USD", walletTransactionId: "w", grants: [] });
});

async function openSheet(row: GrantRow = ROW) {
  render(<Renewal row={row} name="VPN" />);
  fireEvent.click(screen.getByRole("button", { name: R.action }));
  return within(await screen.findByRole("dialog"));
}

describe("the sheet's custom amount (rule 4)", () => {
  it("is not offered when the product has no rate in effect", async () => {
    vi.mocked(billingApi.renewalPlans).mockResolvedValue({ ...PLANS, custom: null });
    const dialog = await openSheet();
    expect(await dialog.findAllByRole("radio")).toHaveLength(1);
    expect(dialog.queryByRole("radio", { name: new RegExp(R.custom.title) })).toBeNull();
  });

  it("shows a field per part the Grant can take, with its bounds beside it", async () => {
    const dialog = await openSheet();
    fireEvent.click(await dialog.findByRole("radio", { name: new RegExp(R.custom.title) }));
    expect(dialog.getByRole("textbox", { name: R.custom.gib })).toBeTruthy();
    expect(dialog.getByText(`${R.custom.bounds}:5,500`)).toBeTruthy();
    expect(dialog.getByText(`${R.custom.bounds}:1,90`)).toBeTruthy();
  });

  it("has no field for a part billing says this Grant cannot take", async () => {
    vi.mocked(billingApi.renewalPlans).mockResolvedValue({ ...PLANS, custom: { ...CUSTOM, minGib: 0, maxGib: 0 } });
    const dialog = await openSheet();
    fireEvent.click(await dialog.findByRole("radio", { name: new RegExp(R.custom.title) }));
    expect(dialog.queryByRole("textbox", { name: R.custom.gib })).toBeNull();
    expect(dialog.getByRole("textbox", { name: R.custom.days })).toBeTruthy();
  });

  it("prices what is typed by billing's quote, then invoices and pays GiB and days as a renewal", async () => {
    const dialog = await openSheet();
    fireEvent.click(await dialog.findByRole("radio", { name: new RegExp(R.custom.title) }));
    fireEvent.change(dialog.getByRole("textbox", { name: R.custom.gib }), { target: { value: "۲۰" } });
    fireEvent.change(dialog.getByRole("textbox", { name: R.custom.days }), { target: { value: "10" } });
    await waitFor(() => expect(billingApi.renewalQuote).toHaveBeenLastCalledWith("g1", 20, 10));
    expect(await dialog.findAllByText("$7.77")).not.toHaveLength(0);
    const pay = dialog.getByRole("button", { name: SHOP.invoice.pay });
    await waitFor(() => expect(pay.hasAttribute("disabled")).toBe(false));
    fireEvent.click(pay);
    await waitFor(() => expect(billingApi.createRenewalInvoice).toHaveBeenCalledWith("g1", { gib: 20, days: 10 }, []));
    await waitFor(() => expect(billingApi.payInvoice).toHaveBeenCalledWith("inv-c"));
  });

  it("shows billing's refusal of an amount out of bounds, and no pay", async () => {
    vi.mocked(billingApi.renewalQuote).mockRejectedValue(new ApiError("Between 5 and 500 GB", { status: 409, reason: "custom_out_of_bounds" }));
    const dialog = await openSheet();
    fireEvent.click(await dialog.findByRole("radio", { name: new RegExp(R.custom.title) }));
    fireEvent.change(dialog.getByRole("textbox", { name: R.custom.gib }), { target: { value: "900" } });
    expect(await dialog.findByText("Between 5 and 500 GB")).toBeTruthy();
    expect(dialog.queryByRole("button", { name: SHOP.invoice.pay })).toBeNull();
  });
});

const IN_EFFECT = { id: "r2", pricePerGib: "0.2", pricePerDay: "0.3", minGib: 5, maxGib: 500, minDays: 1, maxDays: 90, isOff: false, currencyCode: "USD", effectiveFrom: "2026-10-20T00:00:00.000Z", createdAt: "2026-10-20T00:00:00.000Z" };
const OFF_ROW = { ...IN_EFFECT, id: "r1", pricePerGib: null, pricePerDay: null, minGib: null, maxGib: null, minDays: null, maxDays: null, isOff: true, effectiveFrom: "2026-10-01T00:00:00.000Z" };
const RATES: RenewalRates = { inEffect: IN_EFFECT, history: [IN_EFFECT, OFF_ROW] };

describe("the seller's rate on a product's editor", () => {
  beforeEach(() => {
    rates.list.mockResolvedValue(RATES);
    rates.set.mockResolvedValue(IN_EFFECT);
    rates.off.mockResolvedValue(OFF_ROW);
  });

  const fill = (label: string, value: string) => fireEvent.change(screen.getByRole("textbox", { name: new RegExp(label) }), { target: { value } });

  it("reads this surface's product, and shows the rate in effect and the history newest first, off as its own row", async () => {
    render(<RenewalRateSection productId="p-1" />);
    expect(await screen.findByText(new RegExp(`${RR.inEffect}`))).toBeTruthy();
    expect(renewalRateApi).toHaveBeenCalledWith("t-res");
    expect(rates.list).toHaveBeenCalledWith("p-1");
    fireEvent.click(screen.getByRole("button", { name: new RegExp(RR.history) }));
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[1].textContent).toContain(RR.off);
  });

  it("writes a new rate as numbers, in the pricing currency, and re-reads", async () => {
    render(<RenewalRateSection productId="p-1" />);
    await screen.findByText(new RegExp(RR.inEffect));
    fill(RR.pricePerGib, "0.25");
    fill(RR.pricePerDay, "0");
    fill(RR.minGib, "10");
    fill(RR.maxGib, "200");
    fill(RR.minDays, "0");
    fill(RR.maxDays, "0");
    fireEvent.click(screen.getByRole("button", { name: RR.save }));
    await waitFor(() =>
      expect(rates.set).toHaveBeenCalledWith("p-1", { pricePerGib: "0.25", pricePerDay: "0", minGib: 10, maxGib: 200, minDays: 0, maxDays: 0 }),
    );
    await waitFor(() => expect(rates.list).toHaveBeenCalledTimes(2));
  });

  it("refuses before any call what billing's schema would: bounds reversed, nothing sold, a sold part free", async () => {
    render(<RenewalRateSection productId="p-1" />);
    await screen.findByText(new RegExp(RR.inEffect));
    fill(RR.pricePerGib, "0.25");
    fill(RR.pricePerDay, "0");
    fill(RR.minGib, "300");
    fill(RR.maxGib, "200");
    fill(RR.minDays, "0");
    fill(RR.maxDays, "30");
    fireEvent.click(screen.getByRole("button", { name: RR.save }));
    expect(await screen.findByText(RR.errors.reversed)).toBeTruthy();
    expect(screen.getByText(RR.errors.soldFree)).toBeTruthy();
    expect(rates.set).not.toHaveBeenCalled();
  });

  it("switches custom renewal off as its own row", async () => {
    render(<RenewalRateSection productId="p-1" />);
    await screen.findByText(new RegExp(RR.inEffect));
    fireEvent.click(screen.getByRole("button", { name: RR.turnOff }));
    await waitFor(() => expect(rates.off).toHaveBeenCalledWith("p-1", {}));
  });
});
