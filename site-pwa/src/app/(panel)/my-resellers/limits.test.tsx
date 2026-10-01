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
 *    per-user ceiling (not a count), keeps the server's text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ApiError } from "@/lib/api-error";
import { resellerLimitReachedOf } from "@/lib/reseller-limits";
import { resellerLimitsApi } from "@/lib/tenant-api";
import { ResellerLimitsCard } from "./[id]/_components/ResellerLimitsCard";
import { limitReading } from "./_lib/limits";

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/lib/tenant-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-api")>()),
  resellerLimitsApi: { ofReseller: vi.fn() },
}));

const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);
const L = "resellerOnboarding.limits";
const RESELLER = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.mocked(useLocale).mockReturnValue({ t } as never);
  vi.mocked(resellerLimitsApi.ofReseller).mockReset();
});

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
