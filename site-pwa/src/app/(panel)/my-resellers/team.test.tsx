import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { TeamView } from "./[id]/team/_components/TeamView";
import { ConfirmProvider } from "../_components/kit";

/**
 * The Team page (F-1201-c, `panel-web/contract.team.md`). A reseller's team is
 * its seats: role, state and end, invite an existing user (the role set after,
 * at auth — F-1201-a), change a role, move or clear the end, remove with a
 * confirm. The platform's team is the people holding a staff role: no seat, no
 * end, and taking someone off gives them the ordinary user's role.
 */

const K = FrontendI18nKeys.common.tenantTeam;

const { session } = vi.hoisted(() => ({ session: { tenant: { id: "p-1", type: "platform_owner" as const }, permissions: ["*"] } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/my-resellers/r-1/team", useSearchParams: () => null, useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({ lang: "en", isRtl: false, t: (_ns: string, key: string, vars?: object) => (vars ? `${key} ${JSON.stringify(vars)}` : key) }),
}));
vi.mock("@/hooks/useMotionLevel", () => ({ useMotionLevel: () => "reduced" }));
vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: () => ({ me: session, isLoading: false }) }));
vi.mock("./_components/PlatformAccessBanner", () => ({ PlatformAccessBanner: () => null, ConsentNeeded: () => null }));
vi.mock("../_components/kit/DatePicker", () => ({
  DatePicker: ({ label, value, onChange }: { label?: string; value: string | null; onChange: (v: string | null) => void }) => (
    <input aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} />
  ),
}));
vi.mock("@/lib/auth-api", () => ({
  authApi: { ownedResellers: vi.fn(async () => ({ resellers: [] })) },
  tenantRolesApi: { list: vi.fn(), assign: vi.fn() },
  resellerUsersApi: { list: vi.fn() },
}));
vi.mock("@/lib/tenant-api", () => ({ resellerStaffApi: { list: vi.fn(), invite: vi.fn(), setExpiry: vi.fn(), remove: vi.fn() } }));

import { resellerUsersApi, tenantRolesApi } from "@/lib/auth-api";
import { resellerStaffApi } from "@/lib/tenant-api";

const ROLES = [
  { id: "role-desk", name: "Desk", isTemplate: false, isSystemRole: false, permissions: ["support.agent"], members: 1 },
  { id: "role-boss", name: "Boss", isTemplate: false, isSystemRole: false, permissions: ["gateway.manage"], members: 0 },
  { id: "tpl-user", name: "user", isTemplate: true, isSystemRole: true, permissions: [], members: 9 },
];
const SEAT = {
  id: "seat-1", userId: "u-sara", state: "active", invitedByUserId: "u-owner", invitedAt: "2026-10-01T00:00:00Z",
  joinedAt: "2026-10-02T00:00:00Z", accessExpiresAt: "2026-12-01T00:00:00Z", revokedAt: null,
  user: { id: "u-sara", fullName: "Sara", username: "sara", phoneNumber: null }, role: { id: "role-desk", name: "Desk" },
};

const show = (id = "r-1") => render(<ConfirmProvider><TeamView id={id} /></ConfirmProvider>);

describe("TeamView — a reseller's seats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tenantRolesApi.list).mockResolvedValue({ roles: ROLES, grantable: ["support.agent"] });
    vi.mocked(resellerStaffApi.list).mockResolvedValue([SEAT] as never);
  });

  it("lists each seat with its role, state and end", async () => {
    show();
    const row = await screen.findByTestId("seat-seat-1");
    expect(within(row).getByText("Sara")).toBeTruthy();
    expect(within(row).getByText("Desk")).toBeTruthy();
    expect(within(row).getByText(K.state.active)).toBeTruthy();
    expect(resellerStaffApi.list).toHaveBeenCalledWith("r-1");
    expect(resellerUsersApi.list).not.toHaveBeenCalled();
  });

  it("offers only the roles this caller may give, and changes one through auth", async () => {
    vi.mocked(tenantRolesApi.assign).mockResolvedValue({ userId: "u-sara", role: { id: "tpl-user", name: "user" } });
    show();
    fireEvent.click(within(await screen.findByTestId("seat-seat-1")).getByText(K.changeRole));
    const dialog = await screen.findByRole("dialog");
    const select = within(dialog).getByLabelText(K.role) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).not.toContain("role-boss");
    fireEvent.change(select, { target: { value: "tpl-user" } });
    fireEvent.click(within(dialog).getByText(K.save));
    await waitFor(() => expect(tenantRolesApi.assign).toHaveBeenCalledWith("r-1", "u-sara", "tpl-user"));
  });

  it("clears the end without re-inviting", async () => {
    vi.mocked(resellerStaffApi.setExpiry).mockResolvedValue({ ...SEAT, accessExpiresAt: null } as never);
    show();
    fireEvent.click(within(await screen.findByTestId("seat-seat-1")).getByText(K.changeExpiry));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByText(K.clear));
    await waitFor(() => expect(resellerStaffApi.setExpiry).toHaveBeenCalledWith("r-1", "seat-1", null));
    expect(resellerStaffApi.invite).not.toHaveBeenCalled();
  });

  it("invites a found user, then sets the chosen role at auth", async () => {
    vi.mocked(resellerUsersApi.list).mockResolvedValue({ items: [{ id: "u-ali", fullName: "Ali", username: "ali" }], total: 1, page: 1, pageSize: 10 } as never);
    vi.mocked(resellerStaffApi.invite).mockResolvedValue({ ...SEAT, id: "seat-2", userId: "u-ali", state: "invited" } as never);
    vi.mocked(tenantRolesApi.assign).mockResolvedValue({ userId: "u-ali", role: { id: "role-desk", name: "Desk" } });
    show();
    fireEvent.click(await screen.findByText(K.add));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(K.search), { target: { value: "ali" } });
    fireEvent.click(await within(dialog).findByText(K.pick));
    fireEvent.change(within(dialog).getByLabelText(K.role), { target: { value: "role-desk" } });
    fireEvent.click(within(dialog).getByText(K.save));
    await waitFor(() => expect(tenantRolesApi.assign).toHaveBeenCalledWith("r-1", "u-ali", "role-desk"));
    expect(resellerStaffApi.invite).toHaveBeenCalledWith("r-1", { userId: "u-ali" });
    expect(vi.mocked(resellerStaffApi.invite).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(tenantRolesApi.assign).mock.invocationCallOrder[0]);
  });

  it("removes a seat only after a confirm", async () => {
    vi.mocked(resellerStaffApi.remove).mockResolvedValue({ ...SEAT, state: "revoked" } as never);
    show();
    fireEvent.click(within(await screen.findByTestId("seat-seat-1")).getByText(K.remove));
    expect(resellerStaffApi.remove).not.toHaveBeenCalled();
    const confirm = await screen.findByRole("dialog");
    fireEvent.click(within(confirm).getByText(K.remove));
    await waitFor(() => expect(resellerStaffApi.remove).toHaveBeenCalledWith("r-1", "seat-1"));
  });
});

describe("TeamView — the platform's staff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tenantRolesApi.list).mockResolvedValue({ roles: ROLES, grantable: ["*"] });
    vi.mocked(resellerUsersApi.list).mockResolvedValue({
      items: [{ id: "u-reza", fullName: "Reza", username: "reza", role: { id: "role-desk", name: "Desk" } }], total: 1, page: 1, pageSize: 100,
    } as never);
  });

  it("lists people holding a staff role, with no seat and no end, and takes one off by giving the user's role", async () => {
    vi.mocked(tenantRolesApi.assign).mockResolvedValue({ userId: "u-reza", role: { id: "tpl-user", name: "user" } });
    show("p-1");
    const row = await screen.findByTestId("staff-u-reza");
    expect(resellerUsersApi.list).toHaveBeenCalledWith("p-1", expect.objectContaining({ staff: true }));
    expect(resellerStaffApi.list).not.toHaveBeenCalled();
    expect(within(row).queryByText(K.changeExpiry)).toBeNull();
    fireEvent.click(within(row).getByText(K.remove));
    const confirm = await screen.findByRole("dialog");
    fireEvent.click(within(confirm).getByText(K.remove));
    await waitFor(() => expect(tenantRolesApi.assign).toHaveBeenCalledWith("p-1", "u-reza", "tpl-user"));
  });
});
