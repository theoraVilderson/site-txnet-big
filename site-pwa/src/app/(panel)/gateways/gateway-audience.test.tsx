import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminGateway } from "@/lib/billing-api";
import type { AudienceGroup } from "@/lib/auth-api";
import { GatewayAudienceSection } from "./_components/GatewayAudienceSection";
import { ownsAudience, type GatewaySurface } from "./_lib/surface";

/**
 * Who a gateway is offered to (F-102-g-e) through the shared audience picker
 * (GR-1-x): every user, or chosen groups this caller may pick (ADR-0143). Its
 * own save, beside the editor's — billing replaces the whole set.
 */

vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({ t: (_ns: string, key: string, vars?: Record<string, unknown>) => (vars ? `${key}|${JSON.stringify(vars)}` : key) }),
}));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => () => "failed" }));
const audienceGroups = vi.fn();
vi.mock("@/lib/auth-api", () => ({ audienceGroups: (tenantId: string | null) => audienceGroups(tenantId) }));

const GROUPS: AudienceGroup[] = [
  { id: "g-vip", name: "VIP", givesKeys: false, userCount: 3 },
  { id: "g-new", name: "New", givesKeys: false, userCount: 5 },
];
const gateway = (userGroupIds: string[] = []) => ({ source: "tenant", id: "gw-1", tenantId: "r-1", userGroupIds }) as unknown as AdminGateway;

const setAudience = vi.fn();
const surface = { tenantId: "r-1", api: { setAudience } } as unknown as GatewaySurface;

beforeEach(() => {
  vi.clearAllMocks();
  audienceGroups.mockResolvedValue(GROUPS);
  setAudience.mockImplementation(async (_s: string, _id: string, ids: string[]) => ({ userGroupIds: ids }));
});

describe("ownsAudience", () => {
  it("is set on a gateway the surface's own tenant owns, never on another tenant's from the platform's list", () => {
    const me = { tenant: { id: "t-platform", type: "platform_owner" } } as never;
    expect(ownsAudience({ source: "platform", tenantId: null } as AdminGateway, null, me)).toBe(true);
    expect(ownsAudience({ source: "tenant", tenantId: "t-platform" } as AdminGateway, null, me)).toBe(true);
    expect(ownsAudience({ source: "tenant", tenantId: "r-1" } as AdminGateway, null, me)).toBe(false);
    expect(ownsAudience({ source: "tenant", tenantId: "r-1" } as AdminGateway, "r-1", me)).toBe(true);
  });
});

describe("GatewayAudienceSection", () => {
  it("reads the reseller's pickable groups, starts at every user, and saves the chosen ones as the whole set", async () => {
    const onSaved = vi.fn();
    render(<GatewayAudienceSection gateway={gateway()} surface={surface} onSaved={onSaved} />);

    expect((await screen.findByRole("checkbox", { name: /audience.everyone/ }) as HTMLInputElement).checked).toBe(true);
    expect(audienceGroups).toHaveBeenCalledWith("r-1");
    fireEvent.click(screen.getByRole("checkbox", { name: /VIP/ }));
    fireEvent.click(screen.getByRole("button", { name: "gateways.audience.save" }));

    await waitFor(() => expect(setAudience).toHaveBeenCalledWith("tenant", "gw-1", ["g-vip"]));
    expect(onSaved).toHaveBeenCalledWith(["g-vip"]);
  });

  it("opens a limited gateway to every user again with an empty set", async () => {
    render(<GatewayAudienceSection gateway={gateway(["g-vip"])} surface={surface} onSaved={vi.fn()} />);
    expect((await screen.findByRole("checkbox", { name: /VIP/ }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: /audience.everyone/ }));
    fireEvent.click(screen.getByRole("button", { name: "gateways.audience.save" }));

    await waitFor(() => expect(setAudience).toHaveBeenCalledWith("tenant", "gw-1", []));
  });

  it("keeps a group the gateway has that this caller may not pick, removable", async () => {
    render(<GatewayAudienceSection gateway={gateway(["g-admin"])} surface={surface} onSaved={vi.fn()} />);

    const kept = await screen.findByRole("checkbox", { name: /audience.kept/ });
    expect((kept as HTMLInputElement).checked).toBe(true);
    fireEvent.click(kept);
    fireEvent.click(screen.getByRole("button", { name: "gateways.audience.save" }));

    await waitFor(() => expect(setAudience).toHaveBeenCalledWith("tenant", "gw-1", []));
  });

  it("shows the service's refusal and keeps the choice", async () => {
    setAudience.mockRejectedValue(new Error("no"));
    render(<GatewayAudienceSection gateway={gateway()} surface={surface} onSaved={vi.fn()} />);

    fireEvent.click(await screen.findByRole("checkbox", { name: /New/ }));
    fireEvent.click(screen.getByRole("button", { name: "gateways.audience.save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("failed");
    expect((screen.getByRole("checkbox", { name: /New/ }) as HTMLInputElement).checked).toBe(true);
  });
});
