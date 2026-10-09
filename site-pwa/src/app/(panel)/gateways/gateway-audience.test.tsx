import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminGateway } from "@/lib/billing-api";
import type { UserGroup } from "@/lib/auth-api";
import { GatewayAudienceSection } from "./_components/GatewayAudienceSection";
import { audienceChanged, audienceError, ownsAudience } from "./_lib/audience";
import type { GatewaySurface } from "./_lib/surface";

/**
 * Who a gateway is offered to (F-102-g-e): everyone, or only chosen user
 * groups of its owner. Its own save, beside the editor's — billing takes it as
 * its own route (`PUT …/audience`), replacing the whole set.
 */

vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({ t: (_ns: string, key: string, vars?: Record<string, unknown>) => (vars ? `${key}|${JSON.stringify(vars)}` : key) }),
}));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => () => "failed" }));

const group = (id: string, name: string): UserGroup => ({
  id,
  name,
  kind: "manual",
  allTenants: false,
  userCount: 3,
  tenantCount: 0,
  access: { roleId: null, roleName: null, keys: [] },
  createdAt: "",
  updatedAt: "",
});
const GROUPS = [group("g-vip", "VIP"), group("g-new", "New")];
const gateway = (userGroupIds: string[] = []) => ({ source: "tenant", id: "gw-1", tenantId: "r-1", userGroupIds }) as unknown as AdminGateway;

const setAudience = vi.fn();
const groups = vi.fn();
const surface = { tenantId: "r-1", api: { setAudience }, groups } as unknown as GatewaySurface;

beforeEach(() => {
  vi.clearAllMocks();
  groups.mockResolvedValue(GROUPS);
  setAudience.mockImplementation(async (_s: string, _id: string, ids: string[]) => ({ userGroupIds: ids }));
});

describe("the audience rules", () => {
  it("needs at least one group once limited, and knows when nothing changed", () => {
    expect(audienceError("groups", [])).toBe("gateways.audience.pickOne");
    expect(audienceError("groups", ["g-vip"])).toBeNull();
    expect(audienceError("everyone", [])).toBeNull();
    expect(audienceChanged([], "everyone", ["g-vip"])).toBe(false);
    expect(audienceChanged(["g-vip"], "groups", ["g-vip"])).toBe(false);
    expect(audienceChanged(["g-vip"], "everyone", [])).toBe(true);
  });

  it("is set on a gateway the surface's own tenant owns, never on another tenant's from the platform's list", () => {
    const me = { tenant: { id: "t-platform", type: "platform_owner" } } as never;
    expect(ownsAudience({ source: "platform", tenantId: null } as AdminGateway, null, me)).toBe(true);
    expect(ownsAudience({ source: "tenant", tenantId: "t-platform" } as AdminGateway, null, me)).toBe(true);
    expect(ownsAudience({ source: "tenant", tenantId: "r-1" } as AdminGateway, null, me)).toBe(false);
    expect(ownsAudience({ source: "tenant", tenantId: "r-1" } as AdminGateway, "r-1", me)).toBe(true);
  });
});

describe("GatewayAudienceSection", () => {
  it("starts at everyone, and saves the chosen groups as the whole set", async () => {
    const onSaved = vi.fn();
    render(<GatewayAudienceSection gateway={gateway()} surface={surface} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole("radio", { name: /gateways.audience.groups/ }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /VIP/ }));
    fireEvent.click(screen.getByRole("button", { name: "gateways.audience.save" }));

    await waitFor(() => expect(setAudience).toHaveBeenCalledWith("tenant", "gw-1", ["g-vip"]));
    expect(onSaved).toHaveBeenCalledWith(["g-vip"]);
  });

  it("opens a limited gateway to everyone again with an empty set", async () => {
    render(<GatewayAudienceSection gateway={gateway(["g-vip"])} surface={surface} onSaved={vi.fn()} />);
    expect((await screen.findByRole("checkbox", { name: /VIP/ }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: /gateways.audience.everyone/ }));
    fireEvent.click(screen.getByRole("button", { name: "gateways.audience.save" }));

    await waitFor(() => expect(setAudience).toHaveBeenCalledWith("tenant", "gw-1", []));
  });

  it("says there are no groups yet instead of an empty list", async () => {
    groups.mockResolvedValue([]);
    render(<GatewayAudienceSection gateway={gateway()} surface={surface} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole("radio", { name: /gateways.audience.groups/ }));

    expect(await screen.findByText("gateways.audience.noGroups")).toBeTruthy();
    expect((screen.getByRole("button", { name: "gateways.audience.save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the service's refusal and keeps the choice", async () => {
    setAudience.mockRejectedValue(new Error("no"));
    render(<GatewayAudienceSection gateway={gateway()} surface={surface} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole("radio", { name: /gateways.audience.groups/ }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /New/ }));
    fireEvent.click(screen.getByRole("button", { name: "gateways.audience.save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("failed");
    expect((screen.getByRole("checkbox", { name: /New/ }) as HTMLInputElement).checked).toBe(true);
  });
});
