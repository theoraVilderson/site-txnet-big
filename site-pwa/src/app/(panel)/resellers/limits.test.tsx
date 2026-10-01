/**
 * The platform owner's reseller limits page (F-019-r, ADR-0106).
 *
 * What breaks without anyone seeing it:
 *  - **the page's list of keys drifts from shared-core's registry.** A key
 *    added there with no card here is a limit nobody can set;
 *  - **"no limit" sent as 0, or an empty box as a limit.** 0 refuses
 *    everything; `null` is no limit — the two must never be one;
 *  - **"several" sent without a reason, or for nobody.** The button waits for
 *    both, as tenant-service does;
 *  - **a number the page made up.** Every value shown is the table's answer;
 *  - **a price past a quota sent as a number, as 0, or on a guard** (F-019-v9).
 *    It is a string with two places, positive, and only a quota has one;
 *  - **a blank product window sent as 0.** Blank is no bound; 0 includes
 *    nothing — every sale overage or refused (F-019-v9, ADR-0107 point 3).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useLocale } from "@/context/LocaleContext";
import { resellerLimitsApi, tenantApi } from "@/lib/tenant-api";
import { usePanelSession } from "../_context/PanelSessionContext";
import { catalogApi } from "@/lib/catalog-api";
import { RESELLER_LIMIT_KEYS, limitValueOf, overageBodyOf, productQuotaBodyOf, unitPriceOf } from "./_lib/limits";
import { LimitsView } from "./limits/_components/LimitsView";

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: vi.fn() }));
vi.mock("@/lib/tenant-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-api")>()),
  tenantApi: { packages: vi.fn(), resellers: vi.fn() },
  resellerLimitsApi: {
    table: vi.fn(),
    setPlatform: vi.fn(async () => undefined),
    clearPlatform: vi.fn(async () => undefined),
    setPackage: vi.fn(async () => undefined),
    clearPackage: vi.fn(async () => undefined),
    setResellers: vi.fn(async () => ({})),
    clearResellers: vi.fn(async () => ({})),
    setPlatformOverage: vi.fn(async () => undefined),
    clearPlatformOverage: vi.fn(async () => undefined),
    setPackageOverage: vi.fn(async () => undefined),
    clearPackageOverage: vi.fn(async () => undefined),
    clearResellersOverage: vi.fn(async () => ({})),
    packageProducts: vi.fn(),
    setPackageProduct: vi.fn(async () => undefined),
    clearPackageProduct: vi.fn(async () => undefined),
  },
}));
vi.mock("@/lib/catalog-api", () => ({ catalogApi: { products: vi.fn(), texts: vi.fn() } }));

const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);
const K = "resellers.limits";
const REGISTRY = join(__dirname, "../../../../../txnet-backend/shared-core/src/lib/tenant/reseller-limits.ts");

const row = (key: string, over: Record<string, unknown> = {}) => ({ key, kind: "guard", codeDefault: 5, max: 1000, platform: null, packages: [], resellers: [], overage: null, ...over });
const quotaRow = (over: Record<string, unknown> = {}) =>
  row("campaign_sends_daily_max", { kind: "quota", overage: { platform: null, packages: [], resellers: [], ...over } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as unknown as ReturnType<typeof useLocale>);
  vi.mocked(usePanelSession).mockReturnValue({
    me: { tenant: { id: "p", type: "platform_owner" }, permissions: ["tenant.manage"] },
    isLoading: false,
  } as unknown as ReturnType<typeof usePanelSession>);
  vi.mocked(tenantApi.packages).mockResolvedValue([{ id: "pkg-1", name: "Growth" }] as never);
  vi.mocked(tenantApi.resellers).mockResolvedValue([
    { id: "r-1", slug: "acme" },
    { id: "r-2", slug: "zeta" },
  ] as never);
  vi.mocked(catalogApi.products).mockResolvedValue([
    { id: "prod-vpn", tenantId: null, key: "vpn", nameKey: "catalog.product.vpn", isActive: true },
    { id: "prod-mail", tenantId: null, key: "mail", nameKey: "catalog.product.mail", isActive: true },
    { id: "prod-own", tenantId: "r-1", key: "own" },
  ] as never);
  vi.mocked(catalogApi.texts).mockResolvedValue({ product: { vpn: "VPN" } } as never);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("the keys", () => {
  it("are shared-core's RESELLER_LIMITS, in its order", () => {
    const block = /RESELLER_LIMITS = \{([\s\S]*?)\} as const/.exec(readFileSync(REGISTRY, "utf8"));
    if (!block) throw new Error("RESELLER_LIMITS moved — this test is stale");
    const keys = [...block[1].matchAll(/^\s{2}([a-z0-9_]+):/gm)].map((m) => m[1]);
    expect([...RESELLER_LIMIT_KEYS]).toEqual(keys);
  });
});

describe("limitValueOf", () => {
  it("no limit is null; a whole number within the bound is itself; anything else is nothing", () => {
    expect(limitValueOf("", true, 10)).toBeNull();
    expect(limitValueOf("0", false, 10)).toBe(0);
    expect(limitValueOf(" 10 ", false, 10)).toBe(10);
    for (const bad of ["", "11", "-1", "1.5", "x"]) expect(limitValueOf(bad, false, 10)).toBeUndefined();
  });
});

describe("unitPriceOf / overageBodyOf / productQuotaBodyOf", () => {
  it("a price is a positive string with at most two places", () => {
    expect(unitPriceOf(" 0.50 ")).toBe("0.50");
    expect(unitPriceOf("12")).toBe("12");
    for (const bad of ["", "0", "0.00", "-1", "1.234", "1,5", "x"]) expect(unitPriceOf(bad)).toBeUndefined();
  });

  it("stop needs no price; overage needs a valid one", () => {
    expect(overageBodyOf("stop", "")).toEqual({ mode: "stop" });
    expect(overageBodyOf("overage", "2.5")).toEqual({ mode: "overage", unitPrice: "2.5" });
    expect(overageBodyOf("overage", "")).toBeUndefined();
  });

  it("a blank window is no bound, 0 is 0, and the whole terms go", () => {
    expect(productQuotaBodyOf({ day: "10", week: "", month: "0", mode: "stop", price: "" })).toEqual({ day: 10, month: 0 });
    expect(productQuotaBodyOf({ day: "", week: "", month: "", mode: "overage", price: "1.20" })).toEqual({ overage: { mode: "overage", unitPrice: "1.20" } });
    expect(productQuotaBodyOf({ day: "1.5", week: "", month: "", mode: "stop", price: "" })).toBeUndefined();
    expect(productQuotaBodyOf({ day: "10000001", week: "", month: "", mode: "stop", price: "" })).toBeUndefined();
    expect(productQuotaBodyOf({ day: "", week: "", month: "", mode: "overage", price: "0" })).toBeUndefined();
  });
});

describe("LimitsView", () => {
  it("shows each level's value from the table, and saves the platform's as a number or no limit", async () => {
    vi.mocked(resellerLimitsApi.table).mockResolvedValue([
      row("custom_domains_max", { platform: { value: 3 }, packages: [{ packageId: "pkg-1", name: "Growth", value: null }] }),
    ] as never);
    render(<LimitsView />);
    const card = await screen.findByRole("region", { name: `${K}.keys.custom_domains_max.name` });
    expect(within(card).getByText(`${K}.current:3`)).toBeInTheDocument();
    expect(within(card).getByText(`${K}.current:${K}.noLimit`)).toBeInTheDocument();

    const box = within(card).getByLabelText(`${K}.valueFor:${K}.platform`);
    const save = within(card).getAllByRole("button", { name: `${K}.save` })[0];
    expect(save).toBeDisabled();
    fireEvent.change(box, { target: { value: "7" } });
    fireEvent.click(save);
    await waitFor(() => expect(resellerLimitsApi.setPlatform).toHaveBeenCalledWith("custom_domains_max", 7));

    fireEvent.click(within(card).getAllByRole("checkbox", { name: `${K}.noLimit` })[0]);
    fireEvent.click(save);
    await waitFor(() => expect(resellerLimitsApi.setPlatform).toHaveBeenLastCalledWith("custom_domains_max", null));
    expect(await within(card).findByText(`${K}.saved`)).toBeInTheDocument();
  });

  it("sets one value for several resellers only with someone picked and a reason", async () => {
    vi.mocked(resellerLimitsApi.table).mockResolvedValue([row("admin_issues_30d_max")] as never);
    render(<LimitsView />);
    const card = await screen.findByRole("region", { name: `${K}.keys.admin_issues_30d_max.name` });
    const group = within(card).getByRole("group", { name: `${K}.forResellers` });

    fireEvent.change(within(group).getByLabelText(`${K}.valueFor:${K}.forResellers`), { target: { value: "200" } });
    expect(within(group).getByRole("button", { name: `${K}.apply:0` })).toBeDisabled();
    fireEvent.click(within(group).getByRole("checkbox", { name: "acme" }));
    fireEvent.click(within(group).getByRole("checkbox", { name: "zeta" }));
    expect(within(group).getByRole("button", { name: `${K}.apply:2` })).toBeDisabled();
    fireEvent.change(within(group).getByLabelText(`${K}.reason`), { target: { value: " trusted, ticket 12 " } });
    fireEvent.click(within(group).getByRole("button", { name: `${K}.apply:2` }));

    await waitFor(() => expect(resellerLimitsApi.setResellers).toHaveBeenCalledWith("admin_issues_30d_max", ["r-1", "r-2"], 200, "trusted, ticket 12"));
  });

  it("removes one reseller's own value, back to its package or every reseller's", async () => {
    vi.mocked(resellerLimitsApi.table).mockResolvedValue([
      row("custom_domains_max", { resellers: [{ tenantId: "r-1", slug: "acme", value: 9, reason: "ticket 3" }] }),
    ] as never);
    render(<LimitsView />);
    fireEvent.click(await screen.findByRole("button", { name: `${K}.remove:acme` }));
    await waitFor(() => expect(resellerLimitsApi.clearResellers).toHaveBeenCalledWith("custom_domains_max", ["r-1"]));
  });

  it("shows nobody but the platform owner the page", () => {
    vi.mocked(usePanelSession).mockReturnValue({ me: { tenant: { id: "r", type: "reseller" }, permissions: [] }, isLoading: false } as never);
    render(<LimitsView />);
    expect(screen.getByText("resellers.refusals.not_platform_owner")).toBeInTheDocument();
    expect(resellerLimitsApi.table).not.toHaveBeenCalled();
  });

  it("a quota shows each level's answer past it and saves a package's price as a string; a guard has none", async () => {
    vi.mocked(resellerLimitsApi.table).mockResolvedValue([
      row("custom_domains_max"),
      quotaRow({ platform: { mode: "overage", unitPrice: "0.50", currencyCode: "USD" }, resellers: [{ tenantId: "r-1", slug: "acme", reason: "deal", mode: "stop", unitPrice: null, currencyCode: null }] }),
    ] as never);
    render(<LimitsView />);
    const guard = await screen.findByRole("region", { name: `${K}.keys.custom_domains_max.name` });
    expect(within(guard).queryByRole("group", { name: new RegExp(`^${K}.overage.for`) })).toBeNull();

    const card = screen.getByRole("region", { name: `${K}.keys.campaign_sends_daily_max.name` });
    expect(within(card).getByText(`${K}.current:${K}.overage.priced:0.50,USD`)).toBeInTheDocument();
    const pkg = within(card).getByRole("group", { name: `${K}.overage.for:Growth` });
    const save = within(pkg).getByRole("button", { name: `${K}.save` });
    fireEvent.click(within(pkg).getByRole("radio", { name: `${K}.overage.sell` }));
    expect(save).toBeDisabled();
    fireEvent.change(within(pkg).getByLabelText(`${K}.overage.priceFor:Growth`), { target: { value: "0.75" } });
    fireEvent.click(save);
    await waitFor(() => expect(resellerLimitsApi.setPackageOverage).toHaveBeenCalledWith("pkg-1", "campaign_sends_daily_max", { mode: "overage", unitPrice: "0.75" }));

    fireEvent.click(within(card).getByRole("button", { name: `${K}.overage.remove:acme` }));
    await waitFor(() => expect(resellerLimitsApi.clearResellersOverage).toHaveBeenCalledWith("campaign_sends_daily_max", ["r-1"]));
  });

  it("lists a package's platform products, re-terms one with blanks as no bound, and takes one off after asking", async () => {
    vi.mocked(resellerLimitsApi.table).mockResolvedValue([] as never);
    vi.mocked(resellerLimitsApi.packageProducts).mockResolvedValue([
      { productId: "prod-vpn", key: "vpn", nameKey: "catalog.product.vpn", isActive: true, listedAt: "2026-10-01", quota: { day: 10, week: null, month: null, overage: { mode: "stop", unitPrice: null, currencyCode: null } } },
    ] as never);
    render(<LimitsView />);
    const section = await screen.findByRole("region", { name: `${K}.products.title` });
    fireEvent.change(within(section).getByLabelText(`${K}.products.package`), { target: { value: "pkg-1" } });

    const vpn = await within(section).findByRole("group", { name: "VPN" });
    expect(within(section).queryByRole("group", { name: "own" })).toBeNull();
    const mail = within(section).getByRole("group", { name: "mail" });
    expect(within(mail).getByText(`${K}.products.notListed`)).toBeInTheDocument();

    expect(within(vpn).getByLabelText(`${K}.products.windows.day`)).toHaveValue("10");
    fireEvent.change(within(vpn).getByLabelText(`${K}.products.windows.week`), { target: { value: "50" } });
    fireEvent.click(within(vpn).getByRole("button", { name: `${K}.save` }));
    await waitFor(() => expect(resellerLimitsApi.setPackageProduct).toHaveBeenCalledWith("pkg-1", "prod-vpn", { day: 10, week: 50 }));

    fireEvent.click(within(vpn).getByRole("button", { name: `${K}.products.unlist` }));
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(resellerLimitsApi.clearPackageProduct).toHaveBeenCalledWith("pkg-1", "prod-vpn"));
  });
});
