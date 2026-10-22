import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { RealtimeEvents } from "@/generated/wire";
import { ApiError } from "@/lib/api-error";
import { billingApi, type GrantRow, type RenewalPlans, type ShopInvoice } from "@/lib/billing-api";
import { PANEL_SHOP } from "@/lib/routes";
import { ConfirmProvider } from "../_components/kit";
import { ServiceRow } from "./_components/ServiceRow";
import { Renewal, RenewalSheet } from "./_components/RenewalSheet";
import { readGrantRenewed } from "./_lib/my-services";
import { renewalOffered } from "./_lib/renewal";

/**
 * «تمدید» on My services (F-305-f, panel-web `contract.renewal.md`).
 *
 * > 1. «تمدید» is on a renewable Grant's row only: the caller's own, `active`
 * >    or `suspended`. It opens one sheet.
 * > 2. The plans come first, the Grant's own on top, from billing's answer.
 * > 3. A plan no longer sold says so and links the shop.
 * > 5. Coupon field and pay from wallet are the shop's checkout.
 * > 6. Nothing is patched from the answer: a paid renewal closes the sheet.
 * > 7. A refusal stays in the sheet.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing-api")>()),
  billingApi: {
    renewalPlans: vi.fn(),
    createRenewalInvoice: vi.fn(),
    payInvoice: vi.fn(),
    invoice: vi.fn(),
    cancelInvoice: vi.fn(),
    spendingCap: vi.fn(() => new Promise(() => {})),
    subscriptionLink: vi.fn(),
    grantConfigs: vi.fn(),
    grantUsage: vi.fn(() => new Promise(() => {})),
    grantPeriod: vi.fn(() => new Promise(() => {})),
  },
}));
vi.mock("../_hooks/useWalletBalance", () => ({
  useWalletBalance: () => ({ balance: "100.00", held: "0.00", available: "100.00", currencyCode: "USD", isLoading: false, error: null, refresh: () => {} }),
}));
vi.mock("@/lib/catalog-api", () => ({ catalogApi: { texts: vi.fn().mockRejectedValue(new Error("404")) } }));

const R = FrontendI18nKeys.common.myServices.renew;
const SHOP = FrontendI18nKeys.common.shop;
const t = (_ns: string, key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.values(vars).join(",")}` : key;
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: ConfirmProvider });

const plans = vi.mocked(billingApi.renewalPlans);
const createRenewal = vi.mocked(billingApi.createRenewalInvoice);
const pay = vi.mocked(billingApi.payInvoice);

const ROW: GrantRow = {
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
};

const PLANS: RenewalPlans = {
  grantId: "g1",
  ownPlanRenewable: true,
  plans: [
    { variantId: "v-30", sku: "VPN-30", nameKey: "catalog.vpn30", current: true, bytes: "53687091200", days: 30, price: "12.50", currencyCode: "USD", campaignEndsAt: null },
    { variantId: "v-90", sku: "VPN-90", nameKey: "catalog.vpn90", current: false, bytes: "161061273600", days: 90, price: "30.00", currencyCode: "USD", campaignEndsAt: null },
  ],
  custom: null,
};

const INVOICE: ShopInvoice = {
  id: "inv-1",
  variantId: "v-30",
  sku: "VPN-30",
  nameKey: "catalog.vpn30",
  status: "pending",
  amount: "12.50",
  discount: "0.00",
  total: "12.50",
  currencyCode: "USD",
  applied: [],
  rejected: [],
  renewal: { grantId: "g1", bytes: "53687091200", days: 30 },
  expiresAt: "2099-01-01T00:00:00.000Z",
};

const PAID = { id: "inv-1", status: "paid" as const, total: "12.50", balanceAfter: "87.50", currencyCode: "USD", walletTransactionId: "w1", grants: [{ id: "g1", status: "active" }] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as ReturnType<typeof useLocale>);
  vi.mocked(billingApi.grantConfigs).mockResolvedValue({ grantId: "g1", rows: [] });
  plans.mockResolvedValue(PLANS);
  createRenewal.mockResolvedValue(INVOICE);
  pay.mockResolvedValue(PAID);
  vi.mocked(billingApi.invoice).mockResolvedValue(INVOICE);
});

describe("rule 1: which rows offer it", () => {
  it("an active or suspended Grant with a plan; never a closed one or one issued without a plan", () => {
    expect(renewalOffered(ROW)).toBe(true);
    expect(renewalOffered({ ...ROW, status: "suspended" })).toBe(true);
    for (const status of ["pending", "exhausted", "expired", "cancelled"] as const) expect(renewalOffered({ ...ROW, status })).toBe(false);
    expect(renewalOffered({ ...ROW, variant: null })).toBe(false);
  });

  it("the row draws «تمدید» on a renewable Grant and nowhere else, and reads nothing until it is pressed", () => {
    const { unmount } = render(<ServiceRow row={ROW} name="VPN" capabilities={[]} />);
    expect(screen.getByRole("button", { name: R.action })).toBeTruthy();
    expect(plans).not.toHaveBeenCalled();
    unmount();
    render(<ServiceRow row={{ ...ROW, status: "expired" }} name="VPN" capabilities={[]} />);
    expect(screen.queryByRole("button", { name: R.action })).toBeNull();
  });
});

describe("rules 2 and 3: the plans", () => {
  it("lists billing's plans, the Grant's own first and marked, with what each adds and costs", async () => {
    render(<Renewal row={ROW} name="VPN" />);
    fireEvent.click(screen.getByRole("button", { name: R.action }));
    const dialog = within(await screen.findByRole("dialog"));
    const radios = await dialog.findAllByRole("radio");
    expect(plans).toHaveBeenCalledWith("g1");
    expect(radios).toHaveLength(2);
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
    expect(radios[0].textContent).toContain(R.current);
    expect(radios[0].textContent).toContain("$12.50");
    expect(radios[0].textContent).toContain(`${SHOP.duration}:30`);
    expect(radios[1].textContent).toContain("$30.00");
  });

  it("a plan picked before it opened (the suggestion's renew, F-305-h) is the one checked; one billing does not list is ignored", async () => {
    const { unmount } = render(<RenewalSheet row={ROW} name="VPN" initialPlan="v-90" onClose={() => {}} />);
    let radios = await screen.findAllByRole("radio");
    expect(radios[1].getAttribute("aria-checked")).toBe("true");
    unmount();
    render(<RenewalSheet row={ROW} name="VPN" initialPlan="v-gone" onClose={() => {}} />);
    radios = await screen.findAllByRole("radio");
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
  });

  it("an unlimited Grant's plan says unlimited, never 0 GB", async () => {
    plans.mockResolvedValue({ ...PLANS, plans: [{ ...PLANS.plans[0], bytes: "0" }] });
    render(<Renewal row={{ ...ROW, trafficUnlimited: true, purchasedBytes: "0" }} name="VPN" />);
    fireEvent.click(screen.getByRole("button", { name: R.action }));
    const radio = (await screen.findAllByRole("radio"))[0];
    expect(radio.textContent).toContain(R.unlimited);
  });

  it("a plan no longer sold is said, with the shop linked, and never drawn as a choice", async () => {
    plans.mockResolvedValue({ ...PLANS, ownPlanRenewable: false, plans: [PLANS.plans[1]] });
    render(<Renewal row={ROW} name="VPN" />);
    fireEvent.click(screen.getByRole("button", { name: R.action }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByText(R.notSold)).toBeTruthy();
    expect(dialog.getByRole("link", { name: R.toShop }).getAttribute("href")).toBe(PANEL_SHOP);
    const radios = await dialog.findAllByRole("radio");
    expect(radios).toHaveLength(1);
    expect(radios[0].textContent).not.toContain(R.current);
  });
});

describe("rules 5 to 7: paying", () => {
  it("invoices the picked plan as a renewal of this Grant, pays it from the wallet and closes", async () => {
    render(<Renewal row={ROW} name="VPN" />);
    fireEvent.click(screen.getByRole("button", { name: R.action }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click((await dialog.findAllByRole("radio"))[1]);
    // The switch gives up the old plan's invoice under the checkout's claim; pay is off until it is done.
    const payButton = dialog.getByRole("button", { name: SHOP.invoice.pay });
    await waitFor(() => expect(payButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(payButton);
    await waitFor(() => expect(createRenewal).toHaveBeenCalledWith("g1", { variantId: "v-90" }, []));
    // The invoice's total differs from the plan's listed price: shown, not paid (shop rule 4).
    expect(pay).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole("button", { name: SHOP.invoice.pay }));
    await waitFor(() => expect(pay).toHaveBeenCalledWith("inv-1"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a refusal stays in the sheet, as billing's sentence with its ref", async () => {
    pay.mockRejectedValue(new ApiError("This plan can no longer be renewed", { status: 409, reason: "plan_not_renewable", ref: "ref-9" }));
    render(<Renewal row={ROW} name="VPN" />);
    fireEvent.click(screen.getByRole("button", { name: R.action }));
    const dialog = within(await screen.findByRole("dialog"));
    await dialog.findAllByRole("radio");
    fireEvent.click(dialog.getByRole("button", { name: SHOP.invoice.pay }));
    expect(await dialog.findByText("This plan can no longer be renewed")).toBeTruthy();
    expect(dialog.getByText("ref-9")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("the row hears its own renewal on the socket, and nothing else", () => {
    expect(readGrantRenewed({ type: RealtimeEvents.grantRenewed, grantId: "g1" })).toEqual({ grantId: "g1" });
    expect(readGrantRenewed({ type: RealtimeEvents.grantFreezeChanged, grantId: "g1" })).toBeNull();
    expect(readGrantRenewed({ type: RealtimeEvents.grantRenewed })).toBeNull();
  });
});
