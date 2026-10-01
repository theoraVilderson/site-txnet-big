/**
 * The pay-as-you-go service limit in the panel (F-118-aq, over F-118-ap):
 * the tenant's default on the users page, one user's number on their page,
 * and the shop naming the limit when billing refuses a purchase past it.
 *
 * What breaks without anyone seeing it:
 *  - **a number the panel made up.** "In effect" is billing's `effective`,
 *    never one computed here from the three levels;
 *  - **an empty box read as 0.** Empty is the platform's default (`null`); 0
 *    sells none — the two must not be one;
 *  - **a user's number with no reason.** The button waits for one, as billing does;
 *  - **the shop's refusal without its numbers.** `metered_cap_reached` names
 *    the limit and how many are open, and says to open a ticket.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLocale } from "@/context/LocaleContext";
import { ApiError } from "@/lib/api-error";
import { grantLimitsApi } from "@/lib/billing-api";
import { meteredCapOf } from "../shop/_lib/shop";
import { capOf, TenantGrantLimitCard, UserGrantLimitCard } from "./_components/GrantLimitCards";

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing-api")>()),
  grantLimitsApi: vi.fn(),
}));

const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);
const L = "resellerUsers.grantLimit";
const TENANT = "22222222-2222-4222-8222-222222222222";
const USER = "66666666-6666-4666-8666-666666666666";

const api = {
  tenant: vi.fn(),
  setTenant: vi.fn(),
  user: vi.fn(),
  setUser: vi.fn(),
  removeUser: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as unknown as ReturnType<typeof useLocale>);
  vi.mocked(grantLimitsApi).mockReturnValue(api as unknown as ReturnType<typeof grantLimitsApi>);
});

describe("capOf", () => {
  it("empty is the default, 0..1000 a number, anything else nothing", () => {
    expect(capOf("  ")).toBeNull();
    expect(capOf("0")).toBe(0);
    expect(capOf(" 1000 ")).toBe(1000);
    for (const bad of ["1001", "-1", "2.5", "abc", "۳"]) expect(capOf(bad)).toBeUndefined();
  });
});

describe("TenantGrantLimitCard", () => {
  it("shows billing's number in effect, and saves an empty box as the platform default", async () => {
    api.tenant.mockResolvedValue({ platformDefault: 5, tenantDefault: 2, effective: 2 });
    api.setTenant.mockResolvedValue({ platformDefault: 5, tenantDefault: null, effective: 5 });
    render(<TenantGrantLimitCard tenantId={TENANT} />);

    expect(await screen.findByText(`${L}.inEffect:2 · ${L}.platformDefault:5`)).toBeInTheDocument();
    const box = screen.getByLabelText(`${L}.tenantInput`) as HTMLInputElement;
    expect(box.value).toBe("2");

    fireEvent.change(box, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: `${L}.save` }));
    await waitFor(() => expect(api.setTenant).toHaveBeenCalledWith(null));
    expect(await screen.findByText(`${L}.saved`)).toBeInTheDocument();
    expect(screen.getByText(`${L}.inEffect:5 · ${L}.platformDefault:5`)).toBeInTheDocument();
  });

  it("offers no save for a number out of range, and saves 0 as 0", async () => {
    api.tenant.mockResolvedValue({ platformDefault: 5, tenantDefault: null, effective: 5 });
    api.setTenant.mockResolvedValue({ platformDefault: 5, tenantDefault: 0, effective: 0 });
    render(<TenantGrantLimitCard tenantId={TENANT} />);
    await screen.findByText(`${L}.inEffect:5 · ${L}.platformDefault:5`);

    const box = screen.getByLabelText(`${L}.tenantInput`);
    fireEvent.change(box, { target: { value: "1001" } });
    expect(screen.getByRole("button", { name: `${L}.save` })).toBeDisabled();
    fireEvent.change(box, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: `${L}.save` }));
    await waitFor(() => expect(api.setTenant).toHaveBeenCalledWith(0));
  });
});

describe("the reseller's ceiling (F-019-n)", () => {
  it("is named on both cards when there is one, and not when there is none", async () => {
    api.tenant.mockResolvedValue({ platformDefault: 5, tenantDefault: null, effective: 5, ceiling: 20 });
    api.user.mockResolvedValue({ userId: USER, own: null, tenantDefault: null, platformDefault: 5, effective: 5, ceiling: null, open: 0 });
    render(<TenantGrantLimitCard tenantId={TENANT} />);
    expect(await screen.findByText(`${L}.ceiling:20`)).toBeInTheDocument();
    render(<UserGrantLimitCard tenantId={TENANT} userId={USER} />);
    await screen.findByText(`${L}.userOpen:0,5`);
    expect(screen.getAllByText(/\.ceiling:/)).toHaveLength(1);
  });
});

describe("UserGrantLimitCard", () => {
  const view = { userId: USER, own: null, tenantDefault: 2, platformDefault: 5, effective: 2, open: 2 };

  it("shows how many are open of the number in effect, and where that number comes from", async () => {
    api.user.mockResolvedValue(view);
    render(<UserGrantLimitCard tenantId={TENANT} userId={USER} />);
    expect(await screen.findByText(`${L}.userOpen:2,2`)).toBeInTheDocument();
    expect(screen.getByText(`${L}.userFromDefault:2`)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `${L}.userRemove` })).not.toBeInTheDocument();
  });

  it("sets a number only with a reason, then offers going back to the default", async () => {
    api.user.mockResolvedValue(view);
    api.setUser.mockResolvedValue({
      ...view,
      own: { meteredOpenCap: 10, reason: "ticket 41", setByUserId: "s", updatedAt: "2026-09-30T12:00:00.000Z" },
      effective: 10,
    });
    api.removeUser.mockResolvedValue(view);
    render(<UserGrantLimitCard tenantId={TENANT} userId={USER} />);
    await screen.findByText(`${L}.userOpen:2,2`);

    fireEvent.change(screen.getByLabelText(`${L}.userInput`), { target: { value: "10" } });
    const set = screen.getByRole("button", { name: `${L}.userSet` });
    expect(set).toBeDisabled();
    fireEvent.change(screen.getByLabelText(`${L}.userReason`), { target: { value: " ticket 41 " } });
    fireEvent.click(set);

    await waitFor(() => expect(api.setUser).toHaveBeenCalledWith(USER, 10, "ticket 41"));
    expect(await screen.findByText(`${L}.userOwn:10`)).toBeInTheDocument();
    expect(screen.getByText(`${L}.userReasonShown:ticket 41`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: `${L}.userRemove` }));
    await waitFor(() => expect(api.removeUser).toHaveBeenCalledWith(USER));
    expect(await screen.findByText(`${L}.userFromDefault:2`)).toBeInTheDocument();
  });

  it("says the door's refusal, as the rest of the user page does", async () => {
    api.user.mockRejectedValue(new ApiError("forbidden", { status: 403, reason: "not_allowed" }));
    render(<UserGrantLimitCard tenantId={TENANT} userId={USER} />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});

describe("the shop's refusal (meteredCapOf)", () => {
  it("reads the limit and the open count from metered_cap_reached, and nothing from any other refusal", () => {
    expect(meteredCapOf(new ApiError("x", { status: 409, reason: "metered_cap_reached", facts: { cap: 5, open: 5 } }))).toEqual({ cap: 5, open: 5 });
    expect(meteredCapOf(new ApiError("x", { status: 409, reason: "metered_cap_reached" }))).toBeNull();
    expect(meteredCapOf(new ApiError("x", { status: 409, reason: "insufficient_balance", facts: { cap: 5, open: 5 } }))).toBeNull();
    expect(meteredCapOf(new Error("x"))).toBeNull();
  });
});
