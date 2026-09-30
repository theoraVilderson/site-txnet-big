import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocale } from "@/context/LocaleContext";
import { ApiError } from "@/lib/api-error";
import { billingApi, type ShopInvoice, type ShopOffer } from "@/lib/billing-api";
import { PANEL_MY_SERVICES } from "@/lib/routes";
import { ShopView } from "./_components/ShopView";
import { categoriesOf, groupOffers, meteredStartShortOf, prefillAmount, quotaLimit, shortfallOf, trafficRateOf } from "./_lib/shop";

/**
 * The shop page (F-111-e), and what breaks silently on it:
 *
 * > **A shortfall is a top-up for exactly what is missing, and a way back.**
 * > Billing refuses a wallet payment it cannot cover with `insufficient_balance`
 * > and the rounded-up `missing` in the envelope's `error.facts`
 * > (`billing/contract.purchase.md` "The shortfall"). The page offers the top-up
 * > for that figure — raised to the gateway's minimum, which only the panel
 * > knows — and the top-up page links back to the **same** invoice. A top-up
 * > of less leaves the user a cent short; a new invoice on return re-prices
 * > and re-holds the codes.
 *
 * > **The key is shown once.** Billing keeps only its hash, so the answer to
 * > the pay is the one time it exists in the clear; after it, My services is
 * > the way back (F-502-s).
 *
 * > **One press pays once.** The server pays exactly once under concurrency
 * > anyway; a button that stays live sends the second request into a
 * > refusal the user then reads as a failure of the first.
 *
 * > **A metered offer is priced by its rate, not its 0.00** (F-118-ae/af). A
 * > live run sold a 10 USD/GB product whose card read "$0.00, pay as you
 * > use": the card names the rate per GB billing sends and whether it is
 * > paid ahead or after, so the price is seen before the buy.
 *
 * > **An invoice replaced is cancelled first** (F-114-d). A code held by an
 * > unpaid invoice counts as a use for its 30 minutes, so a new invoice made
 * > beside the old one refuses a one-use code the shopper typed a moment ago.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing-api")>()),
  billingApi: { shopOffers: vi.fn(), createInvoice: vi.fn(), invoice: vi.fn(), payInvoice: vi.fn(), cancelInvoice: vi.fn() },
}));
const wallet = vi.hoisted(() => ({ available: null as string | null }));
vi.mock("../_hooks/useWalletBalance", () => ({
  useWalletBalance: () => ({
    balance: "5.00",
    held: wallet.available === null ? null : "0.00",
    available: wallet.available,
    currencyCode: wallet.available === null ? null : "USD",
    isLoading: false,
    failed: false,
    refresh: () => {},
  }),
}));
vi.mock("@/lib/catalog-api", () => ({ catalogApi: { texts: vi.fn().mockRejectedValue(new Error("404")) } }));

const shopOffers = vi.mocked(billingApi.shopOffers);
const createInvoice = vi.mocked(billingApi.createInvoice);
const readInvoice = vi.mocked(billingApi.invoice);
const payInvoice = vi.mocked(billingApi.payInvoice);
const cancelInvoice = vi.mocked(billingApi.cancelInvoice);

const t = (_ns: string, key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.values(vars).join(",")}` : key;

const INVOICE_ID = "88888888-8888-4888-8888-888888888881";

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
  quotas: { traffic_bytes: { limit: 50 * 1024 ** 3, resetPolicy: "never" } },
  price: "12.50",
  rateCards: [],
};

const OFFER_90: ShopOffer = { ...OFFER, variantId: "v-90", sku: "VPN-90", durationDays: 90, price: "30.00" };
const MAIL: ShopOffer = {
  ...OFFER,
  variantId: "m-1",
  sku: "MAIL",
  nameKey: "catalog.product.mail.name",
  productId: "p-mail",
  productNameKey: "catalog.product.mail.name",
  categoryKey: "mail",
  categories: [{ key: "mail", nameKey: "catalog.category.mail.name" }],
  price: "3.00",
};

const GIB = "1073741824";
const PAYG: ShopOffer = {
  ...OFFER,
  variantId: "v-payg",
  sku: "PAYG",
  billingMode: "metered",
  quotas: {},
  price: "0.00",
  rateCards: [
    { meterKey: "vpn.config.regenerate", unitSize: "1", unitPrice: "0.5", currencyCode: "USD", mode: "postpaid", includedQuantity: "2", afterIncluded: "metered" },
    { meterKey: "vpn.traffic", unitSize: GIB, unitPrice: "10", currencyCode: "USD", mode: "prepaid", includedQuantity: "0", afterIncluded: "metered" },
  ],
};

const INVOICE: ShopInvoice = {
  currencyCode: "USD",
  id: INVOICE_ID,
  variantId: "v-30",
  sku: "VPN-30",
  nameKey: "catalog.product.vpn.name",
  status: "pending",
  amount: "12.50",
  discount: "0.00",
  total: "12.50",
  applied: [],
  rejected: [],
  expiresAt: "2099-01-01T00:00:00.000Z",
};

const insufficient = (missing: string) =>
  new ApiError("Your balance does not cover this purchase", {
    status: 409,
    reason: "insufficient_balance",
    facts: { total: "12.50", balance: "5.00", missing },
  });

beforeEach(() => {
  vi.clearAllMocks();
  wallet.available = null;
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as ReturnType<typeof useLocale>);
  shopOffers.mockResolvedValue([OFFER]);
  createInvoice.mockResolvedValue(INVOICE);
  readInvoice.mockResolvedValue(INVOICE);
  cancelInvoice.mockResolvedValue({ id: INVOICE_ID, status: "cancelled" });
});

describe("the shortfall", () => {
  it("is the refusal's own missing figure, read from the envelope's facts", () => {
    expect(shortfallOf(insufficient("7.50"))).toBe("7.50");
  });

  it("is nothing for any other refusal, or one that carried no figure", () => {
    expect(shortfallOf(new ApiError("expired", { status: 409, reason: "expired" }))).toBeNull();
    expect(shortfallOf(new ApiError("short", { status: 409, reason: "insufficient_balance" }))).toBeNull();
    expect(shortfallOf(new Error("boom"))).toBeNull();
  });

  it("is raised to the gateway's minimum, never lowered — a larger top-up still covers", () => {
    expect(prefillAmount("7.50", "10.00")).toBe("10.00");
    expect(prefillAmount("7.50", "5.00")).toBe("7.50");
    expect(prefillAmount("7.50", null)).toBe("7.50");
    expect(prefillAmount("0.01", "0.01")).toBe("0.01");
  });
});

describe("the list", () => {
  it("groups variants under their product, in the order billing answered", () => {
    const mail = { ...MAIL };
    expect(groupOffers([OFFER, mail, OFFER_90]).map((g) => [g.productId, g.variants.map((v) => v.sku)])).toEqual([
      ["p-vpn", ["VPN-30", "VPN-90"]],
      ["p-mail", ["MAIL"]],
    ]);
  });

  it("tabs every category an offer is filed in, once, in the order first met", () => {
    const both = { ...OFFER_90, categories: [...OFFER.categories, { key: "gold", nameKey: "catalog.category.gold.name" }] };
    expect(categoriesOf([OFFER, both, MAIL]).map((c) => c.key)).toEqual(["vpn", "gold", "mail"]);
  });

  it("reads a quota's limit from the catalog's shape, and nothing it did not set", () => {
    expect(quotaLimit(OFFER.quotas, "traffic_bytes")).toBe(50 * 1024 ** 3);
    expect(quotaLimit(OFFER.quotas, "concurrent_devices")).toBeNull();
    expect(quotaLimit(null, "traffic_bytes")).toBeNull();
  });

  it("puts a product's variants on one card: picking one changes the price, and buy takes the one picked", async () => {
    shopOffers.mockResolvedValue([OFFER, OFFER_90]);
    const user = userEvent.setup();
    render(<ShopView invoiceId={null} />);
    const pick = await screen.findByRole("radio", { name: "shop.duration:90" });
    expect(screen.getAllByRole("button", { name: "shop.buy" })).toHaveLength(1);
    await user.click(pick);
    expect(screen.getByText("$30.00")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "shop.buy" }));
    await user.click(await screen.findByRole("button", { name: "shop.invoice.pay" }));
    await waitFor(() => expect(createInvoice).toHaveBeenCalledWith("v-90", []));
  });

  it("reads a metered offer's traffic rate per GB off its vpn.traffic card, and nothing else", () => {
    expect(trafficRateOf(PAYG)).toEqual({ unitPrice: "10", currencyCode: "USD", mode: "prepaid" });
    expect(trafficRateOf(OFFER)).toBeNull();
    const perMb = { ...PAYG, rateCards: [{ ...PAYG.rateCards[1], unitSize: "1048576" }] };
    expect(trafficRateOf(perMb)).toBeNull();
    expect(trafficRateOf({ ...PAYG, rateCards: undefined as unknown as ShopOffer["rateCards"] })).toBeNull();
  });

  it("prices a metered card by its rate per GB and says it is paid ahead — never $0.00", async () => {
    shopOffers.mockResolvedValue([PAYG]);
    render(<ShopView invoiceId={null} />);
    expect(await screen.findByText("$10.00")).toBeTruthy();
    expect(screen.getByText("shop.perGb")).toBeTruthy();
    expect(screen.getByText("shop.meteredPrepaid")).toBeTruthy();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("filters the cards by category tab, and shows no tabs for one category", async () => {
    shopOffers.mockResolvedValue([OFFER, MAIL]);
    const user = userEvent.setup();
    render(<ShopView invoiceId={null} />);
    await user.click(await screen.findByRole("tab", { name: "mail" }));
    expect(screen.getAllByRole("button", { name: "shop.buy" })).toHaveLength(1);
    expect(screen.getByText("MAIL")).toBeTruthy();
    expect(screen.queryByText("VPN-30")).toBeNull();
  });
});

describe("one page: pick, codes, pay", () => {
  async function toCheckout() {
    const user = userEvent.setup();
    render(<ShopView invoiceId={null} />);
    await user.click(await screen.findByRole("button", { name: "shop.buy" }));
    await screen.findByRole("button", { name: "shop.invoice.pay" });
    return user;
  }

  it("makes no invoice for looking: one press with no code makes it and pays it", async () => {
    payInvoice.mockReturnValue(new Promise(() => {}));
    const user = await toCheckout();
    expect(createInvoice).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "shop.invoice.pay" }));
    await waitFor(() => expect(payInvoice).toHaveBeenCalledWith(INVOICE_ID));
    expect(createInvoice).toHaveBeenCalledWith("v-30", []);
  });

  it("does not pay a price other than the one on screen: a changed price waits for a second press", async () => {
    createInvoice.mockResolvedValue({ ...INVOICE, amount: "14.00", total: "14.00" });
    const user = await toCheckout();
    await user.click(screen.getByRole("button", { name: "shop.invoice.pay" }));
    expect(await screen.findByText("shop.checkout.priceChanged")).toBeTruthy();
    expect(payInvoice).not.toHaveBeenCalled();
  });

  it("prices on the server: a code makes the invoice from the variant and the codes, never a figure, and pays nothing", async () => {
    const user = await toCheckout();
    await user.type(screen.getByRole("textbox"), "spring");
    await user.click(screen.getByRole("button", { name: "shop.checkout.addCode" }));
    await waitFor(() => expect(createInvoice).toHaveBeenCalledWith("v-30", ["SPRING"]));
    expect(payInvoice).not.toHaveBeenCalled();
  });

  it("cancels the invoice it replaces before making the next, so a one-use code is not held against itself", async () => {
    createInvoice.mockResolvedValueOnce({ ...INVOICE, applied: [{ code: "SPRING", discount: "2.50" }], discount: "2.50", total: "10.00" });
    createInvoice.mockResolvedValueOnce({ ...INVOICE, id: "second" });
    const user = await toCheckout();
    await user.type(screen.getByRole("textbox"), "spring");
    await user.click(screen.getByRole("button", { name: "shop.checkout.addCode" }));
    await screen.findByText("$10.00");
    await user.type(screen.getByRole("textbox"), "summer");
    await user.click(screen.getByRole("button", { name: "shop.checkout.addCode" }));
    await waitFor(() => expect(createInvoice).toHaveBeenLastCalledWith("v-30", ["SPRING", "SUMMER"]));
    expect(cancelInvoice).toHaveBeenCalledWith(INVOICE_ID);
    expect(cancelInvoice.mock.invocationCallOrder[0]).toBeLessThan(createInvoice.mock.invocationCallOrder[1]);
  });

  it("drops a code billing did not apply, with billing's sentence", async () => {
    createInvoice.mockResolvedValue({ ...INVOICE, rejected: [{ code: "BAD", reason: "not_found", message: "No such code" }] });
    const user = await toCheckout();
    await user.type(screen.getByRole("textbox"), "bad");
    await user.click(screen.getByRole("button", { name: "shop.checkout.addCode" }));
    expect(await screen.findByText(/No such code/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "shop.checkout.removeCode:BAD" })).toBeNull();
  });

  it("cancels the invoice it leaves behind when the shopper goes back to the list", async () => {
    const user = await toCheckout();
    await user.type(screen.getByRole("textbox"), "spring");
    await user.click(screen.getByRole("button", { name: "shop.checkout.addCode" }));
    await waitFor(() => expect(createInvoice).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "shop.checkout.back" }));
    await waitFor(() => expect(cancelInvoice).toHaveBeenCalledWith(INVOICE_ID));
    expect(await screen.findByRole("button", { name: "shop.buy" })).toBeTruthy();
  });

  it("on a shortfall, offers the top-up for exactly it and a way back to this invoice", async () => {
    payInvoice.mockRejectedValue(insufficient("7.50"));
    const user = await toCheckout();
    await user.click(screen.getByRole("button", { name: "shop.invoice.pay" }));

    const link = await screen.findByRole("link", { name: /shop\.shortfall\.topUp/ });
    const href = new URL(link.getAttribute("href")!, "https://panel.test");
    expect(href.pathname).toBe("/financial/deposit");
    expect(href.searchParams.get("invoice")).toBe(INVOICE_ID);
    expect(href.searchParams.get("missing")).toBe("7.50");
  });

  it("shows no key or link — it sends the user to My services, where the link is", async () => {
    payInvoice.mockResolvedValue({
      currencyCode: "USD",
      id: INVOICE_ID,
      status: "paid",
      total: "12.50",
      balanceAfter: "7.50",
      walletTransactionId: "w1",
      grants: [{ id: "g1", status: "pending" }],
    });
    const user = await toCheckout();
    await user.click(screen.getByRole("button", { name: "shop.invoice.pay" }));

    expect(await screen.findByText("shop.paid.preparing")).toBeTruthy();
    expect(document.body.textContent ?? "").not.toMatch(/wallet\.gift\.key/);
    expect(screen.getByRole("link", { name: "shop.paid.myServices" }).getAttribute("href")).toBe(PANEL_MY_SERVICES);
  });

  it("pays once per press: the button is off while the pay is in flight", async () => {
    let settle: (v: never) => void = () => {};
    payInvoice.mockReturnValue(new Promise((resolve) => (settle = resolve as never)));
    const user = await toCheckout();
    const pay = screen.getByRole("button", { name: "shop.invoice.pay" });
    await user.click(pay);
    await user.click(pay);
    expect(payInvoice).toHaveBeenCalledTimes(1);
    expect((pay as HTMLButtonElement).disabled).toBe(true);
    settle(undefined as never);
  });
});

/**
 * > **A metered service bought on an empty wallet is told so before the pay**
 * > (F-118-ah). Its usage is taken from the wallet, so on 0.00 it stays
 * > pending and connects nothing, and nothing said why (live run
 * > 2026-09-30). Under 1 GB at its rate — the wallet-low line (F-601-g) — the
 * > checkout says it will not start and links to the top-up. The pay stays:
 * > it starts on its own once the wallet is topped up.
 */
describe("a metered buy on a low wallet", () => {
  it("is short of 1 GB at the offer's rate, in the wallet's currency, and nothing else is", () => {
    expect(meteredStartShortOf(PAYG, "0.00", "USD")).toBe("10.00");
    expect(meteredStartShortOf(PAYG, "3.25", "USD")).toBe("6.75");
    expect(meteredStartShortOf(PAYG, "10.00", "USD")).toBeNull();
    expect(meteredStartShortOf(OFFER, "0.00", "USD")).toBeNull();
    expect(meteredStartShortOf(PAYG, "0.00", "EUR")).toBeNull();
    expect(meteredStartShortOf(PAYG, null, null)).toBeNull();
  });

  async function checkoutFor(offer: ShopOffer) {
    shopOffers.mockResolvedValue([offer]);
    const user = userEvent.setup();
    render(<ShopView invoiceId={null} />);
    await user.click(await screen.findByRole("button", { name: "shop.buy" }));
    await screen.findByRole("button", { name: "shop.invoice.pay" });
  }

  it("says it will not start and links to the top-up, and still lets the user pay", async () => {
    wallet.available = "0.00";
    await checkoutFor(PAYG);
    expect(screen.getByText("shop.meteredStart.title")).toBeTruthy();
    const link = screen.getByRole("link", { name: "shop.meteredStart.topUp" });
    expect(new URL(link.getAttribute("href")!, "https://panel.test").pathname).toBe("/financial/deposit");
    expect(screen.getByRole("button", { name: "shop.invoice.pay" })).toBeTruthy();
  });

  it("says nothing on a wallet that covers 1 GB, or for a plan paid up front", async () => {
    wallet.available = "25.00";
    await checkoutFor(PAYG);
    expect(screen.queryByText("shop.meteredStart.title")).toBeNull();
  });

  it("says nothing for a plan paid up front, whatever the wallet", async () => {
    wallet.available = "0.00";
    await checkoutFor(OFFER);
    expect(screen.queryByText("shop.meteredStart.title")).toBeNull();
  });
});

describe("coming back to the same invoice", () => {
  it("reads the invoice the top-up page linked back to, and offers to pay it", async () => {
    render(<ShopView invoiceId={INVOICE_ID} />);
    expect(await screen.findByRole("button", { name: "shop.invoice.pay" })).toBeTruthy();
    expect(readInvoice).toHaveBeenCalledWith(INVOICE_ID);
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it("says an invoice that ran out is gone, and offers no pay for it", async () => {
    readInvoice.mockResolvedValue({ ...INVOICE, status: "expired" });
    render(<ShopView invoiceId={INVOICE_ID} />);
    expect(await screen.findByText("shop.invoice.status.expired")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "shop.invoice.pay" })).toBeNull();
  });
});
