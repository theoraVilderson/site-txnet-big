/**
 * A reseller's own limits in its workspace (F-019-s, ADR-0106), and the
 * panel's sentence for a `reseller_limit_reached` refusal.
 *
 * What breaks without anyone seeing it:
 *  - **a figure the panel made up.** Limit, source and use are tenant-service's
 *    answer for the path's reseller — never the session's tenant, never a count here;
 *  - **"no limit" read as 0, or "no count" as 0 used.** `limit: null` is no
 *    limit; `used: null` is a key that counts nothing (the per-user ceiling);
 *  - **a refusal that does not say which limit.** The sentence names the key's
 *    own name and both figures; a key this panel does not know, or the
 *    per-user ceiling (not a count), keeps the server's text;
 *  - **an extra unit the reseller cannot see** (F-019-v10). A quota shows what
 *    is included and used, and apart from it what was sold past and its cost;
 *    a product's quota each window on its own;
 *  - **a refusal past a quota that does not say why.** Wallet empty, own cap,
 *    price unavailable or stop each have a sentence; the buyer's (no figures)
 *    keeps the server's text;
 *  - **an upgrade charged without the price shown, or tried with too little.**
 *    The preview's price is shown and asked about first; short of it, no button.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ApiError } from "@/lib/api-error";
import { resellerLimitReachedOf } from "@/lib/reseller-limits";
import { resellerLimitsApi, resellerPurchaseApi, tenantApi } from "@/lib/tenant-api";
import { catalogApi } from "@/lib/catalog-api";
import { ResellerLimitsCard } from "./[id]/_components/ResellerLimitsCard";
import { OverageCapCard, PackageChangeCard, ProductQuotasCard } from "./[id]/_components/QuotaCards";
import { capAmountOf, changeVerdict, compareAmounts, includedReading, limitReading } from "./_lib/limits";

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/lib/tenant-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-api")>()),
  resellerLimitsApi: { ofReseller: vi.fn(), productsOf: vi.fn(), overageCap: vi.fn(), setOverageCap: vi.fn() },
  resellerPurchaseApi: { packages: vi.fn() },
  tenantApi: { subscriptionChange: vi.fn(), changeSubscription: vi.fn() },
}));
vi.mock("@/lib/catalog-api", () => ({ catalogApi: { texts: vi.fn() } }));

const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);
const L = "resellerOnboarding.limits";
const RESELLER = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLocale).mockReturnValue({ t, lang: "en" } as never);
  vi.mocked(resellerLimitsApi.ofReseller).mockReset();
  vi.mocked(catalogApi.texts).mockResolvedValue({ product: { vpn: "VPN" } } as never);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

const Q = "resellerOnboarding.quotas";
const period = (kind: "day" | "week" | "month") => ({ kind, start: "2026-10-01T00:00:00Z", end: "2026-10-02T00:00:00Z" });

describe("limitReading", () => {
  it("a count under a limit, at it, with no limit, and a key that counts nothing", () => {
    expect(limitReading({ key: "custom_domains_max", limit: 5, source: "platform", used: 2 })).toEqual({ text: "usedOf", vars: { used: 2, limit: 5 }, full: false, share: 0.4 });
    expect(limitReading({ key: "custom_domains_max", limit: 3, source: "package", used: 3 })).toMatchObject({ full: true, share: 1 });
    expect(limitReading({ key: "custom_domains_max", limit: 0, source: "reseller", used: 0 })).toMatchObject({ full: true, share: 1 });
    expect(limitReading({ key: "admin_issues_30d_max", limit: null, source: "reseller", used: 4 })).toEqual({ text: "usedNoLimit", vars: { used: 4 }, full: false, share: null });
    expect(limitReading({ key: "user_metered_cap_max", limit: 20, source: "default", used: null })).toEqual({ text: "upTo", vars: { limit: 20 }, full: false, share: null });
    expect(limitReading({ key: "user_metered_cap_max", limit: null, source: "exempt", used: null })).toEqual({ text: "noLimit", vars: undefined, full: false, share: null });
  });
});

describe("ResellerLimitsCard", () => {
  it("asks for the path's reseller and shows each key's name, use and source", async () => {
    vi.mocked(resellerLimitsApi.ofReseller).mockResolvedValue([
      { key: "platform_open_grants_max", limit: 500, source: "default", used: 7 },
      { key: "custom_domains_max", limit: 3, source: "package", used: 3 },
    ]);
    render(<ResellerLimitsCard tenantId={RESELLER} />);
    await waitFor(() => expect(screen.getByText("resellers.limits.keys.custom_domains_max.name")).toBeInTheDocument());
    expect(resellerLimitsApi.ofReseller).toHaveBeenCalledWith(RESELLER);
    expect(screen.getByText(`${L}.usedOf:7,500`)).toBeInTheDocument();
    expect(screen.getByText(`${L}.usedOf:3,3`)).toBeInTheDocument();
    expect(screen.getByText(`${L}.sources.package`)).toBeInTheDocument();
    expect(screen.getAllByText(`${L}.full`)).toHaveLength(1);
    expect(screen.getByText(`${L}.raise`)).toBeInTheDocument();
  });

  it("says the refusal when the reseller's limits cannot be read", async () => {
    vi.mocked(resellerLimitsApi.ofReseller).mockRejectedValue(new ApiError("not allowed here", { status: 403, reason: "not_allowed" }));
    render(<ResellerLimitsCard tenantId={RESELLER} />);
    await waitFor(() => expect(screen.getByText("not allowed here")).toBeInTheDocument());
  });
});

describe("a reseller_limit_reached refusal", () => {
  const refused = (facts: Record<string, string | number>) =>
    new ApiError("reseller limit reached: custom_domains_max (5 of 5)", { status: 409, reason: "reseller_limit_reached", facts });

  it("names the limit and both figures", () => {
    expect(resellerLimitReachedOf(refused({ key: "custom_domains_max", limit: 5, used: 5 }))).toEqual({ key: "custom_domains_max", limit: 5, used: 5, ceiling: false });
    const { result } = renderHook(() => useApiErrorMessage());
    expect(result.current(refused({ key: "custom_domains_max", limit: 5, used: 5 }))).toBe("errors.resellerLimitReached:resellers.limits.keys.custom_domains_max.name,5,5");
  });

  it("says a ceiling as the most allowed and the size asked (F-019-t5)", () => {
    const { result } = renderHook(() => useApiErrorMessage());
    expect(result.current(refused({ key: "bulk_job_grants_max", limit: 100, used: 340 }))).toBe("errors.resellerLimitAbove:resellers.limits.keys.bulk_job_grants_max.name,340,100");
  });

  it("keeps the server's text for a key or figures this panel does not know", () => {
    expect(resellerLimitReachedOf(refused({ key: "bots_max", limit: 2, used: 2 }))).toBeNull();
    expect(resellerLimitReachedOf(refused({ key: "custom_domains_max", limit: "5", used: 5 }))).toBeNull();
    // The per-user ceiling's `used` is the number asked, and billing says that itself.
    expect(resellerLimitReachedOf(refused({ key: "user_metered_cap_max", limit: 20, used: 25 }))).toBeNull();
    const { result } = renderHook(() => useApiErrorMessage());
    expect(result.current(refused({ key: "bots_max", limit: 2, used: 2 }))).toBe("reseller limit reached: custom_domains_max (5 of 5)");
  });
});

describe("includedReading / capAmountOf / compareAmounts / changeVerdict", () => {
  it("fills against what is included, Full at it, nothing with no bound", () => {
    expect(includedReading(10, 4)).toEqual({ share: 0.4, full: false });
    expect(includedReading(10, 10)).toEqual({ share: 1, full: true });
    expect(includedReading(null, 99)).toEqual({ share: null, full: false });
  });

  it("a cap is 0 or more with two places at most", () => {
    expect(capAmountOf(" 0 ")).toBe("0");
    expect(capAmountOf("50.5")).toBe("50.5");
    for (const bad of ["", "-1", "1.234", "x"]) expect(capAmountOf(bad)).toBeUndefined();
  });

  it("compares money exactly and says what a change would do", () => {
    expect(compareAmounts("0.10", "0.1")).toBe(0);
    expect(compareAmounts("9.99", "10")).toBe(-1);
    expect(compareAmounts("x", "1")).toBeNull();
    const p = { charge: "20.00", currencyCode: "USD", balance: "25.00", currentPeriodEnd: "2026-10-20T00:00:00Z" };
    expect(changeVerdict({ ...p, when: "now" })).toBe("now");
    expect(changeVerdict({ ...p, when: "now", balance: "19.99" })).toBe("short");
    expect(changeVerdict({ ...p, when: "renewal" })).toBe("renewal");
    expect(changeVerdict({ ...p, when: "none" })).toBe("none");
  });
});

describe("a reseller_quota_exhausted refusal (F-019-v10)", () => {
  const refused = (facts: Record<string, string | number>) => new ApiError("reseller quota exhausted", { status: 409, reason: "reseller_quota_exhausted", facts });

  it("says why, naming the quota when the panel knows it", () => {
    const { result } = renderHook(() => useApiErrorMessage());
    expect(result.current(refused({ meter: "campaign_sends_daily_max", stoppedBy: "wallet_empty", included: 10, used: 10 }))).toBe(
      "errors.resellerQuotaExhausted.wallet_empty:resellers.limits.keys.campaign_sends_daily_max.name",
    );
    expect(result.current(refused({ meter: "product:abc", stoppedBy: "spend_cap", included: 2, used: 2 }))).toBe(
      "errors.resellerQuotaExhausted.spend_cap:errors.resellerQuotaExhausted.aProduct",
    );
  });

  it("keeps the server's text for the buyer's refusal, which carries no figures", () => {
    const { result } = renderHook(() => useApiErrorMessage());
    expect(result.current(new ApiError("Not available now", { status: 409, reason: "reseller_quota_exhausted" }))).toBe("Not available now");
  });
});

describe("the workspace's quota cards (F-019-v10)", () => {
  it("a quota row shows what is included and used, and what was sold past it apart", async () => {
    vi.mocked(resellerLimitsApi.ofReseller).mockResolvedValue([
      {
        key: "campaign_sends_daily_max",
        kind: "quota",
        limit: 10,
        source: "package",
        used: 13,
        overage: { mode: "overage", unitPrice: "0.50", currencyCode: "USD", source: "package" },
        statement: { period: period("day"), includedUsed: 10, overageQty: 3, overageAmount: "1.50" },
        lockedUntil: null,
      },
    ]);
    render(<ResellerLimitsCard tenantId={RESELLER} />);
    expect(await screen.findByText(`${L}.usedOf:10,10`)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`^${Q}.extra:3,`))).toBeInTheDocument();
  });

  it("shows each window of a product's quota for the path's reseller", async () => {
    vi.mocked(resellerLimitsApi.productsOf).mockResolvedValue([
      {
        productId: "p1",
        key: "vpn",
        nameKey: "catalog.product.vpn",
        listed: true,
        overage: { mode: "stop", unitPrice: null, currencyCode: null },
        windows: [
          { period: period("day"), included: 2, includedUsed: 2, overageQty: 0, overageAmount: "0.00" },
          { period: period("week"), included: null, includedUsed: 5, overageQty: 0, overageAmount: "0.00" },
          { period: period("month"), included: 30, includedUsed: 5, overageQty: 0, overageAmount: "0.00" },
        ],
      },
    ]);
    render(<ProductQuotasCard tenantId={RESELLER} />);
    const vpn = await screen.findByRole("group", { name: "VPN" });
    expect(resellerLimitsApi.productsOf).toHaveBeenCalledWith(RESELLER);
    expect(within(vpn).getByText(`${Q}.windows.day: ${L}.usedOf:2,2`)).toBeInTheDocument();
    expect(within(vpn).getByText(`${Q}.windows.week: ${L}.usedNoLimit:5`)).toBeInTheDocument();
    expect(within(vpn).getByText(`${Q}.pastStop`)).toBeInTheDocument();
  });

  it("sets the spend cap as a string, and removes it as null", async () => {
    const view = { month: period("month"), cap: "50.00", spent: "12.00", currencyCode: "USD" };
    vi.mocked(resellerLimitsApi.overageCap).mockResolvedValue(view);
    vi.mocked(resellerLimitsApi.setOverageCap).mockResolvedValue({ ...view, cap: "80.00" });
    render(<OverageCapCard tenantId={RESELLER} />);
    const box = await screen.findByLabelText(`${Q}.cap.amount`);
    const save = screen.getByRole("button", { name: `${Q}.cap.save` });
    fireEvent.change(box, { target: { value: "1.234" } });
    expect(save).toBeDisabled();
    fireEvent.change(box, { target: { value: "80" } });
    fireEvent.click(save);
    await waitFor(() => expect(resellerLimitsApi.setOverageCap).toHaveBeenCalledWith(RESELLER, "80"));
    fireEvent.click(screen.getByRole("button", { name: `${Q}.cap.remove` }));
    await waitFor(() => expect(resellerLimitsApi.setOverageCap).toHaveBeenLastCalledWith(RESELLER, null));
  });

  it("shows an upgrade's prorated price, asks, then applies it; short of it, offers no button", async () => {
    vi.mocked(resellerPurchaseApi.packages).mockResolvedValue([{ id: "gold", name: "Gold", monthlyPrice: "30.00", yearlyPrice: null, currencyCode: "USD", includedFeatureKeys: [] }]);
    const preview = { when: "now" as const, charge: "12.00", currencyCode: "USD", balance: "40.00", currentPeriodEnd: "2026-10-20T00:00:00Z" };
    vi.mocked(tenantApi.subscriptionChange).mockResolvedValue(preview);
    vi.mocked(tenantApi.changeSubscription).mockResolvedValue({} as never);
    render(<PackageChangeCard tenantId={RESELLER} />);
    fireEvent.change(await screen.findByLabelText(`${Q}.change.package`), { target: { value: "gold" } });
    await waitFor(() => expect(tenantApi.subscriptionChange).toHaveBeenCalledWith(RESELLER, "gold", "subscription_monthly"));
    expect(await screen.findByText(new RegExp(`^${Q}.change.now:`))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: `${Q}.change.upgrade` }));
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(tenantApi.changeSubscription).toHaveBeenCalledWith(RESELLER, { packageId: "gold", billingModel: "subscription_monthly" }));

    vi.mocked(tenantApi.subscriptionChange).mockResolvedValue({ ...preview, balance: "5.00" });
    fireEvent.change(screen.getByLabelText(`${Q}.change.period`), { target: { value: "subscription_yearly" } });
    expect(await screen.findByText(new RegExp(`^${Q}.change.short:`))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `${Q}.change.upgrade` })).toBeNull();
  });
});
