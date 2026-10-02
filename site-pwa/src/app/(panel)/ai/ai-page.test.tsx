import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useLocale } from "@/context/LocaleContext";
import { ApiError } from "@/lib/api-error";
import { aiAdminApi, type AiOffer, type AiSettings, type PlanMargin } from "@/lib/ai-api";
import { billingApi, type AdminCoupon } from "@/lib/billing-api";
import { catalogApi } from "@/lib/catalog-api";
import { myResellerUserPath, panelResellerPath } from "@/lib/routes";
import { usePanelSession } from "../_context/PanelSessionContext";
import { AiView } from "./_components/AiView";

/**
 * F-038-j2 (ADR-0109 points 7, 13; ADR-0110): the tenant's AI page over ai's
 * `/api/ai/admin/*` (F-038-j1).
 *
 * The failures worth a spec: a save that sends what was not changed (and so
 * overwrites another admin's edit); a threshold or holdout share the server
 * refuses, sent anyway; an engine that is "on" but does not run, shown as
 * running; a template list with a platform coupon or a gift code in it; a
 * refusal shown as "something went wrong" instead of its reason; an at-risk
 * customer with no way to open them, or a reason shown as a raw code; a plan
 * that loses money on every sale not flagged, or an unknown cost shown as a
 * number (F-1528).
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: vi.fn() }));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => () => "generic" }));
vi.mock("@/lib/ai-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-api")>()),
  aiAdminApi: { settings: vi.fn(), saveSettings: vi.fn(), atRisk: vi.fn(), resellers: vi.fn(), usageForecast: vi.fn(), capacity: vi.fn(), margins: vi.fn(), planLayout: vi.fn(), uplift: vi.fn(), offers: vi.fn(), createOffer: vi.fn(), updateOffer: vi.fn() },
}));
vi.mock("@/lib/catalog-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/catalog-api")>()),
  catalogApi: { texts: vi.fn() },
}));
vi.mock("@/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing-api")>()),
  billingApi: { adminCoupons: vi.fn() },
}));

const TENANT = "t-1";
const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);

const settings: AiSettings = {
  engineEnabled: true,
  engineRuns: true,
  confidenceThreshold: "0.60",
  holdoutPercent: 10,
  disabledActionTypes: [],
  actionTypes: ["renew", "resize_up", "retain_offer"],
};
const coupon = (over: Partial<AdminCoupon>) => ({ id: "c-1", tenantId: TENANT, code: "STAY20", discountType: "percentage", currencyCode: "IRR", status: "active", ...over }) as AdminCoupon;
const offer: AiOffer = {
  id: "o-1", name: "Stay with us", actionType: "retain_offer", target: { couponTemplateId: "c-1", variantId: null },
  maxDiscountPercent: "20.00", dailyBudget: "1000000.00", currencyCode: "IRR", isActive: true, createdByUserId: "u", createdAt: "", updatedAt: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as ReturnType<typeof useLocale>);
  vi.mocked(usePanelSession).mockReturnValue({ me: { tenant: { id: TENANT } }, isLoading: false } as unknown as ReturnType<typeof usePanelSession>);
  vi.mocked(aiAdminApi.settings).mockResolvedValue({ settings });
  vi.mocked(aiAdminApi.saveSettings).mockImplementation(async (p) => ({ settings: { ...settings, ...p } }));
  vi.mocked(aiAdminApi.offers).mockResolvedValue({ items: [offer] });
  vi.mocked(aiAdminApi.updateOffer).mockResolvedValue({ offer: { ...offer, isActive: false } });
  vi.mocked(aiAdminApi.atRisk).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(aiAdminApi.margins).mockResolvedValue({ items: [] });
  vi.mocked(aiAdminApi.planLayout).mockResolvedValue({ families: [] });
  vi.mocked(catalogApi.texts).mockResolvedValue({} as Awaited<ReturnType<typeof catalogApi.texts>>);
  vi.mocked(aiAdminApi.uplift).mockResolvedValue({ from: "", to: "", types: [], renewals: { treated: 0, control: 0 } });
  vi.mocked(billingApi.adminCoupons).mockResolvedValue({
    items: [
      coupon({}),
      coupon({ id: "c-platform", tenantId: null, code: "PLAT" }),
      coupon({ id: "c-gift", code: "GIFT", discountType: "wallet_credit" }),
      coupon({ id: "c-del", code: "OLD", status: "deleted" }),
    ],
    total: 4, page: 1, pageSize: 100,
  });
});

const tab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));

describe("settings (F-038-j2)", () => {
  it("sends only what changed: switching one type off", async () => {
    render(<AiView />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "ai.types.resize_up" }));
    fireEvent.click(screen.getByRole("button", { name: "ai.settings.save" }));
    await waitFor(() => expect(aiAdminApi.saveSettings).toHaveBeenCalledWith({ disabledActionTypes: ["resize_up"] }));
    expect(await screen.findByText("ai.saved")).toBeTruthy();
  });

  it("never sends a threshold or holdout share the server refuses", async () => {
    render(<AiView />);
    const threshold = await screen.findByLabelText("ai.settings.threshold");
    fireEvent.change(threshold, { target: { value: "1.5" } });
    expect(screen.getByRole("button", { name: "ai.settings.save" })).toHaveProperty("disabled", true);
    fireEvent.change(threshold, { target: { value: "0.7" } });
    fireEvent.change(screen.getByLabelText("ai.settings.holdout"), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: "ai.settings.save" })).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("ai.settings.holdout"), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: "ai.settings.save" }));
    await waitFor(() => expect(aiAdminApi.saveSettings).toHaveBeenCalledWith({ confidenceThreshold: "0.7", holdoutPercent: 15 }));
  });

  it("says so when the switch is on but the engine does not run", async () => {
    vi.mocked(aiAdminApi.settings).mockResolvedValue({ settings: { ...settings, engineRuns: false } });
    render(<AiView />);
    expect(await screen.findByText("ai.settings.notRunning")).toBeTruthy();
  });
});

describe("discount offers (F-038-j2)", () => {
  it("offers only the tenant's own live discount coupons as templates, and creates with the template's currency", async () => {
    vi.mocked(aiAdminApi.createOffer).mockResolvedValue({ offer });
    render(<AiView />);
    tab("ai.tabs.offers");
    fireEvent.click(await screen.findByRole("button", { name: "ai.offers.add" }));
    const select = (await screen.findByLabelText("ai.offers.template")) as HTMLSelectElement;
    const codes = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(codes).toContain("STAY20");
    expect(codes).not.toContain("PLAT");
    expect(codes).not.toContain("GIFT");
    expect(codes).not.toContain("OLD");
    fireEvent.change(screen.getByLabelText("ai.offers.name"), { target: { value: "Stay" } });
    fireEvent.change(select, { target: { value: "c-1" } });
    fireEvent.change(screen.getByLabelText("ai.offers.maxDiscount"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("ai.offers.dailyBudget"), { target: { value: "1000000" } });
    fireEvent.click(screen.getByRole("button", { name: "ai.offers.create" }));
    await waitFor(() =>
      expect(aiAdminApi.createOffer).toHaveBeenCalledWith({ name: "Stay", actionType: "retain_offer", couponTemplateId: "c-1", maxDiscountPercent: "20", dailyBudget: "1000000", currencyCode: "IRR" }),
    );
  });

  it("words ai's refusal by its reason", async () => {
    vi.mocked(aiAdminApi.createOffer).mockRejectedValue(new ApiError("x", { status: 400, reason: "template_not_found" }));
    render(<AiView />);
    tab("ai.tabs.offers");
    fireEvent.click(await screen.findByRole("button", { name: "ai.offers.add" }));
    fireEvent.change(await screen.findByLabelText("ai.offers.name"), { target: { value: "Stay" } });
    fireEvent.change(screen.getByLabelText("ai.offers.template"), { target: { value: "c-1" } });
    fireEvent.change(screen.getByLabelText("ai.offers.maxDiscount"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("ai.offers.dailyBudget"), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: "ai.offers.create" }));
    expect(await screen.findByText("ai.refused.template_not_found")).toBeTruthy();
  });

  it("turns an offer off", async () => {
    render(<AiView />);
    tab("ai.tabs.offers");
    fireEvent.click(await screen.findByRole("button", { name: "ai.offers.turnOff" }));
    await waitFor(() => expect(aiAdminApi.updateOffer).toHaveBeenCalledWith("o-1", { isActive: false }));
  });
});

describe("at risk and the report (F-038-j2)", () => {
  it("links each customer to their page, words the reasons, and pages on", async () => {
    vi.mocked(aiAdminApi.atRisk)
      .mockResolvedValueOnce({
        items: [{ userId: "u-1", grantId: "g-1", value: "0.3000", predictedAt: "2026-10-07T00:00:00.000Z", confidence: "0.6000", reasons: [{ code: "rule_defaults", base: 0.5 }, { code: "idle_7d", weight: -0.2 }, { code: "something_new" }] }],
        nextCursor: "p1",
      })
      .mockResolvedValueOnce({ items: [{ userId: "u-2", grantId: null, value: "0.4000", predictedAt: null, confidence: "0.6000", reasons: [] }], nextCursor: null });
    render(<AiView />);
    tab("ai.tabs.atRisk");
    const link = await screen.findByRole("link", { name: /u-1/ });
    expect(link.getAttribute("href")).toBe(myResellerUserPath(TENANT, "u-1"));
    expect(screen.getByText("ai.reasons.idle_7d")).toBeTruthy();
    expect(screen.getByText(/ai\.atRisk\.renewChance:30/)).toBeTruthy();
    expect(screen.queryByText("something_new")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "ai.atRisk.more" }));
    expect(await screen.findByRole("link", { name: /u-2/ })).toBeTruthy();
    expect(aiAdminApi.atRisk).toHaveBeenLastCalledWith("renewal", "p1");
  });

  it("asks the report for the last 30 days and shows each type's two arms", async () => {
    vi.mocked(aiAdminApi.uplift).mockResolvedValue({
      from: "", to: "", renewals: { treated: 7, control: 1 },
      types: [{
        actionType: "renew",
        treated: { units: 20, converted: 8, rate: 0.4, revenue: [], margin: [], marginUnknown: 0 },
        control: { units: 5, converted: 1, rate: 0.2, revenue: [], margin: [], marginUnknown: 0 },
        uplift: { rate: 0.2, revenue: [{ amount: "1200000.00", currencyCode: "IRR" }], margin: [] },
      }],
    });
    render(<AiView />);
    tab("ai.tabs.report");
    expect(await screen.findByText("ai.types.renew")).toBeTruthy();
    const [from, to] = vi.mocked(aiAdminApi.uplift).mock.calls[0];
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(30 * 86_400_000);
    expect(screen.getByText("ai.report.converted:8,20")).toBeTruthy();
    expect(screen.getByText("ai.report.converted:1,5")).toBeTruthy();
    expect(screen.getByText("+20%")).toBeTruthy();
  });
});

describe("margins (F-1528)", () => {
  const plan = (over: Partial<PlanMargin>): PlanMargin => ({
    variantId: "v50", productId: "p1", sku: "VPN-50", nameKey: "plan.v50", billingMode: "prepaid", durationDays: 30, size: "53687091200", unlimited: false,
    price: { amount: "200000.00", currencyCode: "IRR" }, cost: { amount: "220000.00", currencyCode: "IRR" }, margin: { amount: "-20000.00", currencyCode: "IRR" },
    losingMoney: true, reasons: [{ code: "wholesale_cost" }], grants: { active: 9, losing: 2, costUnknown: 0 }, ...over,
  });

  it("flags a plan that loses money, counts them, and says why a cost is unknown instead of showing a number", async () => {
    vi.mocked(aiAdminApi.margins).mockResolvedValue({
      items: [
        plan({}),
        plan({ variantId: "vm", sku: "PAYG", nameKey: "plan.vm", billingMode: "metered", cost: null, margin: null, losingMoney: false, reasons: [{ code: "cost_unknown", why: "metered" }], grants: { active: 0, losing: 0, costUnknown: 0 } }),
      ],
    });
    render(<AiView />);
    tab("ai.tabs.margins");
    expect(await screen.findByText("ai.margins.losingCount:1")).toBeTruthy();
    const [losing, metered] = screen.getAllByRole("listitem").filter((li) => li.dataset.variant);
    expect(within(losing).getByText("VPN-50")).toBeTruthy();
    expect(within(losing).getByText("ai.margins.losing")).toBeTruthy();
    expect(within(losing).getByText("ai.margins.grantsLosing:2")).toBeTruthy();
    expect(within(metered).queryByText("ai.margins.losing")).toBeNull();
    expect(within(metered).getByText(/ai\.margins\.why\.metered/)).toBeTruthy();
  });
});

describe("plan layout (F-1527)", () => {
  const GIB = 1024 ** 3;
  it("shows each plan's use per period and words every suggestion as a size, never a price", async () => {
    vi.mocked(aiAdminApi.planLayout).mockResolvedValue({
      families: [
        {
          productId: "p1", billingMode: "prepaid", durationDays: 30,
          plans: [
            { variantId: "v20", sku: "VPN-20", nameKey: "plan.v20", size: String(20 * GIB), active: 0, measured: 0, usage: null, under: 0, atCap: 0 },
            { variantId: "v100", sku: "VPN-100", nameKey: "plan.v100", size: String(100 * GIB), active: 15, measured: 15,
              usage: { p25: String(12 * GIB), p50: String(12 * GIB), p75: String(20 * GIB), p90: String(80 * GIB) }, under: 12, atCap: 3 },
          ],
          suggestions: [
            { code: "add_smaller", variantId: "v100", users: 12, measured: 15, share: 0.8, size: String(25 * GIB) },
            { code: "add_bigger", variantId: "v100", users: 4, measured: 15, share: 0.27, size: String(150 * GIB), demandCensored: true },
            { code: "no_takers", variantId: "v20", users: 0, measured: 15 },
          ],
        },
      ],
    });
    render(<AiView />);
    tab("ai.tabs.layout");
    const v100 = await screen.findByText("VPN-100");
    expect(v100).toBeTruthy();
    expect(screen.getByText("ai.layout.usage:12 GB,20 GB,80 GB")).toBeTruthy();
    expect(screen.getByText("ai.layout.addSmaller:12,15,VPN-100,25 GB")).toBeTruthy();
    expect(screen.getByText("ai.layout.addBigger:4,15,VPN-100,150 GB")).toBeTruthy();
    expect(screen.getByText("ai.layout.noTakers:VPN-20")).toBeTruthy();
    expect(screen.queryByText(/IRR/)).toBeNull();
  });
});

describe("resellers at risk, platform owner only (F-038-o3)", () => {
  const owner = () =>
    vi.mocked(usePanelSession).mockReturnValue({ me: { tenant: { id: TENANT, type: "platform_owner" } }, isLoading: false } as unknown as ReturnType<typeof usePanelSession>);

  it("is not a tab for a reseller — ai would refuse it", () => {
    render(<AiView />);
    expect(screen.queryByRole("tab", { name: "ai.tabs.resellers" })).toBeNull();
    expect(aiAdminApi.resellers).not.toHaveBeenCalled();
  });

  it("links each reseller to its page, says when its quota runs out, words each window and pages on", async () => {
    owner();
    vi.mocked(aiAdminApi.resellers)
      .mockResolvedValueOnce({
        items: [{
          tenantId: "r-1", slug: "alpha", value: "2.5000", currencyCode: null, predictedAt: "2026-10-05T00:00:00.000Z", confidence: "0.9000",
          reasons: [
            { code: "quota_rate", meter: "campaign_sends_daily_max", period: "month", included: 1000, used: 600, perDay: 100 },
            { code: "quota_full", meter: "product:p-1", period: "day", included: 10, used: 10 },
            { code: "an_unworded_code" },
          ],
        }],
        nextCursor: "c-1",
      })
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    render(<AiView />);
    fireEvent.click(screen.getByRole("tab", { name: "ai.tabs.resellers" }));
    const link = await screen.findByRole("link", { name: "alpha" });
    expect(link).toHaveAttribute("href", panelResellerPath("r-1"));
    expect(aiAdminApi.resellers).toHaveBeenCalledWith("quota_exhaustion");
    expect(screen.getByText(/^ai\.resellers\.runsOutOn:/)).toBeInTheDocument();
    expect(screen.getByText("ai.reasons.quota_rate:resellers.limits.keys.campaign_sends_daily_max.name,600,1000,ai.resellers.period.month,100")).toBeInTheDocument();
    expect(screen.getByText("ai.reasons.quota_full:ai.resellers.productSales,10,10,ai.resellers.period.day")).toBeInTheDocument();
    expect(screen.queryByText(/an_unworded_code/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "ai.resellers.more" }));
    await waitFor(() => expect(aiAdminApi.resellers).toHaveBeenLastCalledWith("quota_exhaustion", "c-1"));
  });

  it("churn: the risk as a percent and the subscription's end; a deleted reseller by id, unlinked", async () => {
    owner();
    vi.mocked(aiAdminApi.resellers)
      .mockResolvedValueOnce({ items: [], nextCursor: null })
      .mockResolvedValueOnce({
        items: [{ tenantId: "r-gone", slug: null, value: "0.9500", currencyCode: null, predictedAt: "2026-10-12T00:00:00.000Z", confidence: "0.6000", reasons: [{ code: "churn_base" }, { code: "wallet_short", balance: "10.00", price: "50.00", currencyCode: "USD" }] }],
        nextCursor: null,
      });
    render(<AiView />);
    fireEvent.click(screen.getByRole("tab", { name: "ai.tabs.resellers" }));
    await waitFor(() => expect(aiAdminApi.resellers).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "ai.resellers.churn" }));
    await screen.findByText("r-gone");
    expect(aiAdminApi.resellers).toHaveBeenLastCalledWith("churn_risk");
    expect(screen.queryByRole("link", { name: "r-gone" })).toBeNull();
    expect(screen.getByText(/^ai\.resellers\.churnChance:95 · ai\.resellers\.renewsOn:/)).toBeInTheDocument();
    expect(screen.getByText("ai.reasons.wallet_short:10.00,50.00,USD")).toBeInTheDocument();
  });
});

describe("usage forecast (F-1525-b)", () => {
  const meters = [{ meterKey: "vpn.traffic", last7d: String(7 * 1024 ** 3), perDay: String(1024 ** 3), next30d: String(30 * 1024 ** 3), observedHours: 168 }];
  const wallet = { balance: "90.00", perDay: "20.00", runsOutAt: "2026-10-06T00:00:00.000Z", topUp: "510.00", currencyCode: "USD", observedDays: 7 };

  it("names each meter, shows its next 30 days, and the billing wallet's run-out with the top-up that holds 30 days; no capacity for a reseller", async () => {
    vi.mocked(catalogApi.texts).mockResolvedValue({ meter: { "vpn.traffic": { name: "Traffic" } } } as unknown as Awaited<ReturnType<typeof catalogApi.texts>>);
    vi.mocked(aiAdminApi.usageForecast).mockResolvedValue({ meters, wallet });
    render(<AiView />);
    fireEvent.click(screen.getByRole("tab", { name: "ai.tabs.usage" }));
    expect(await screen.findByText("Traffic")).toBeInTheDocument();
    expect(screen.getByText(/^ai\.usage\.next30d:30(\.0)? GB/)).toBeInTheDocument();
    expect(screen.getByText(/^ai\.usage\.walletRunsOut:/)).toBeInTheDocument();
    expect(screen.getByText(/^ai\.usage\.topUp:/)).toHaveTextContent("510");
    expect(aiAdminApi.capacity).not.toHaveBeenCalled();
  });

  it("says when nothing is measured yet, and shows no wallet block without one", async () => {
    vi.mocked(aiAdminApi.usageForecast).mockResolvedValue({ meters: [], wallet: null });
    render(<AiView />);
    fireEvent.click(screen.getByRole("tab", { name: "ai.tabs.usage" }));
    expect(await screen.findByText("ai.usage.empty")).toBeInTheDocument();
    expect(screen.queryByText(/ai\.usage\.walletRunsOut/)).toBeNull();
  });

  it("the platform owner also sees the capacity of every tenant, and how many it covers", async () => {
    vi.mocked(usePanelSession).mockReturnValue({ me: { tenant: { id: TENANT, type: "platform_owner" } }, isLoading: false } as unknown as ReturnType<typeof usePanelSession>);
    vi.mocked(aiAdminApi.usageForecast).mockResolvedValue({ meters: [], wallet: null });
    vi.mocked(aiAdminApi.capacity).mockResolvedValue({ meters, tenantsMeasured: 3, tenants: 5 });
    render(<AiView />);
    fireEvent.click(screen.getByRole("tab", { name: "ai.tabs.usage" }));
    expect(await screen.findByText("ai.usage.covers:3,5")).toBeInTheDocument();
  });

  it("the resellers tab lists billing wallets running out, with the top-up as money", async () => {
    vi.mocked(usePanelSession).mockReturnValue({ me: { tenant: { id: TENANT, type: "platform_owner" } }, isLoading: false } as unknown as ReturnType<typeof usePanelSession>);
    vi.mocked(aiAdminApi.resellers)
      .mockResolvedValueOnce({ items: [], nextCursor: null })
      .mockResolvedValueOnce({
        items: [{ tenantId: "r-1", slug: "alpha", value: "510.00", currencyCode: "USD", predictedAt: "2026-10-06T00:00:00.000Z", confidence: "0.9000", reasons: [{ code: "wholesale_rate", perDay: "20.00", currencyCode: "USD" }] }],
        nextCursor: null,
      });
    render(<AiView />);
    fireEvent.click(screen.getByRole("tab", { name: "ai.tabs.resellers" }));
    await waitFor(() => expect(aiAdminApi.resellers).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "ai.resellers.wallet" }));
    await screen.findByRole("link", { name: "alpha" });
    expect(aiAdminApi.resellers).toHaveBeenLastCalledWith("wallet_need");
    expect(screen.getByText(/^ai\.resellers\.walletRunsOut:.* · ai\.resellers\.topUp:/)).toBeInTheDocument();
    expect(screen.getByText(/^ai\.reasons\.wholesale_rate:/)).toBeInTheDocument();
  });
});
