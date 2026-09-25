import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocale } from "@/context/LocaleContext";
import { ApiError } from "@/lib/api-error";
import { billingApi, type ShopInvoice, type ShopOffer } from "@/lib/billing-api";
import { PANEL_MY_SERVICES } from "@/lib/routes";
import { ShopView } from "./_components/ShopView";
import { groupOffers, prefillAmount, shortfallOf } from "./_lib/shop";

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
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing-api")>()),
  billingApi: { shopOffers: vi.fn(), createInvoice: vi.fn(), invoice: vi.fn(), payInvoice: vi.fn() },
}));
vi.mock("@/lib/catalog-api", () => ({ catalogApi: { texts: vi.fn().mockRejectedValue(new Error("404")) } }));

const shopOffers = vi.mocked(billingApi.shopOffers);
const createInvoice = vi.mocked(billingApi.createInvoice);
const readInvoice = vi.mocked(billingApi.invoice);
const payInvoice = vi.mocked(billingApi.payInvoice);

const t = (_ns: string, key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.values(vars).join(",")}` : key;

const INVOICE_ID = "88888888-8888-4888-8888-888888888881";

const OFFER: ShopOffer = {
  variantId: "v-30",
  sku: "VPN-30",
  nameKey: "catalog.product.vpn.name",
  productId: "p-vpn",
  descriptionKey: null,
  categoryKey: "vpn",
  fulfilmentKind: "network_access",
  durationDays: 30,
  billingMode: "prepaid",
  quotas: {},
  price: "12.50",
};

const INVOICE: ShopInvoice = {
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
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as ReturnType<typeof useLocale>);
  shopOffers.mockResolvedValue([OFFER]);
  createInvoice.mockResolvedValue(INVOICE);
  readInvoice.mockResolvedValue(INVOICE);
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
    const other = { ...OFFER, variantId: "v-90", sku: "VPN-90", productId: "p-vpn" };
    const mail = { ...OFFER, variantId: "m-1", sku: "MAIL", productId: "p-mail" };
    expect(groupOffers([OFFER, mail, other]).map((g) => [g.productId, g.variants.map((v) => v.sku)])).toEqual([
      ["p-vpn", ["VPN-30", "VPN-90"]],
      ["p-mail", ["MAIL"]],
    ]);
  });
});

describe("buy -> invoice -> pay", () => {
  async function toInvoice() {
    const user = userEvent.setup();
    render(<ShopView invoiceId={null} />);
    await user.click(await screen.findByRole("button", { name: "shop.buy" }));
    await user.click(await screen.findByRole("button", { name: "shop.checkout.create" }));
    await screen.findByRole("button", { name: "shop.invoice.pay" });
    return user;
  }

  it("prices on the server: the invoice is made from the variant and the codes, never a figure", async () => {
    const user = userEvent.setup();
    render(<ShopView invoiceId={null} />);
    await user.click(await screen.findByRole("button", { name: "shop.buy" }));
    await user.type(screen.getByRole("textbox"), "spring");
    await user.click(screen.getByRole("button", { name: "shop.checkout.addCode" }));
    await user.click(screen.getByRole("button", { name: "shop.checkout.create" }));
    await waitFor(() => expect(createInvoice).toHaveBeenCalledWith("v-30", ["SPRING"]));
  });

  it("on a shortfall, offers the top-up for exactly it and a way back to this invoice", async () => {
    payInvoice.mockRejectedValue(insufficient("7.50"));
    const user = await toInvoice();
    await user.click(screen.getByRole("button", { name: "shop.invoice.pay" }));

    const link = await screen.findByRole("link", { name: /shop\.shortfall\.topUp/ });
    const href = new URL(link.getAttribute("href")!, "https://panel.test");
    expect(href.pathname).toBe("/financial/deposit");
    expect(href.searchParams.get("invoice")).toBe(INVOICE_ID);
    expect(href.searchParams.get("missing")).toBe("7.50");
  });

  it("shows the key once, then sends the user to My services", async () => {
    payInvoice.mockResolvedValue({
      id: INVOICE_ID,
      status: "paid",
      total: "12.50",
      balanceAfter: "7.50",
      walletTransactionId: "w1",
      grants: [{ id: "g1", status: "pending", token: "KEY-once" }],
    });
    const user = await toInvoice();
    await user.click(screen.getByRole("button", { name: "shop.invoice.pay" }));

    expect(await screen.findByText("KEY-once")).toBeTruthy();
    expect(screen.getByText("wallet.gift.keyOnce")).toBeTruthy();
    expect(screen.getByRole("link", { name: "shop.paid.myServices" }).getAttribute("href")).toBe(PANEL_MY_SERVICES);
  });

  it("pays once per press: the button is off while the pay is in flight", async () => {
    let settle: (v: never) => void = () => {};
    payInvoice.mockReturnValue(new Promise((resolve) => (settle = resolve as never)));
    const user = await toInvoice();
    const pay = screen.getByRole("button", { name: "shop.invoice.pay" });
    await user.click(pay);
    await user.click(pay);
    expect(payInvoice).toHaveBeenCalledTimes(1);
    expect((pay as HTMLButtonElement).disabled).toBe(true);
    settle(undefined as never);
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
