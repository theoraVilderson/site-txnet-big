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
 *  - **a number the page made up.** Every value shown is the table's answer.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useLocale } from "@/context/LocaleContext";
import { resellerLimitsApi, tenantApi } from "@/lib/tenant-api";
import { usePanelSession } from "../_context/PanelSessionContext";
import { RESELLER_LIMIT_KEYS, limitValueOf } from "./_lib/limits";
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
  },
}));

const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);
const K = "resellers.limits";
const REGISTRY = join(__dirname, "../../../../../txnet-backend/shared-core/src/lib/tenant/reseller-limits.ts");

const row = (key: string, over: Record<string, unknown> = {}) => ({ key, codeDefault: 5, max: 1000, platform: null, packages: [], resellers: [], ...over });

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
});
