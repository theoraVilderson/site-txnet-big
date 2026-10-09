import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { RolesView } from "./[id]/roles/_components/RolesView";
import { ConfirmProvider } from "../_components/kit";

/**
 * The Roles page (F-1201-d, `panel-web/contract.team.md`): the tenant's roles
 * with how many hold each, the templates read-only, and an editor that offers
 * exactly the keys the server says this caller may grant (`grantable`, ADR-0134),
 * grouped by area and labelled from the registry (AC-1-f). A role someone
 * holds cannot be deleted from here.
 */

const K = FrontendI18nKeys.common.tenantRoles;

vi.mock("next/navigation", () => ({ usePathname: () => "/my-resellers/r-1/roles", useSearchParams: () => null }));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({ lang: "en", isRtl: false, t: (_ns: string, key: string, vars?: object) => (vars ? `${key} ${JSON.stringify(vars)}` : key) }),
}));
vi.mock("@/hooks/useMotionLevel", () => ({ useMotionLevel: () => "reduced" }));
vi.mock("../_context/PanelSessionContext", () => ({
  usePanelSession: () => ({ me: { tenant: { id: "p-1", type: "platform_owner" }, permissions: [] }, isLoading: false }),
}));
vi.mock("./_components/PlatformAccessBanner", () => ({ PlatformAccessBanner: () => null, ConsentNeeded: () => null }));
vi.mock("./_lib/workspace", async (importOriginal) => ({ ...(await importOriginal<object>()), useWorkspaceSelf: () => false }));
vi.mock("@/lib/auth-api", () => ({
  authApi: { ownedResellers: vi.fn(async () => ({ resellers: [{ id: "r-1", slug: "alpha" }] })) },
  tenantRolesApi: { list: vi.fn(), permissions: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
}));

import { tenantRolesApi } from "@/lib/auth-api";

const REGISTRY = {
  areas: [
    { area: "support", label: "Support", permissions: [
      { key: "support.agent", label: "Answer support", description: "", platformOnly: false },
      { key: "support.manage", label: "Manage support", description: "", platformOnly: false },
    ] },
    { area: "tenant", label: "Resellers", permissions: [{ key: "tenant.manage", label: "Manage resellers", description: "", platformOnly: true }] },
  ],
};

const ROLES = [
  { id: "role-desk", name: "Desk", isTemplate: false, isSystemRole: false, permissions: ["support.agent"], members: 2 },
  { id: "role-spare", name: "Spare", isTemplate: false, isSystemRole: false, permissions: [], members: 0 },
  { id: "tpl-support", name: "Support", isTemplate: true, isSystemRole: true, permissions: ["support.agent"], members: 0 },
];

const answer = (grantable: string[]) => {
  vi.mocked(tenantRolesApi.list).mockResolvedValue({ roles: ROLES, grantable });
  vi.mocked(tenantRolesApi.permissions).mockResolvedValue(REGISTRY);
};

const show = () => render(<ConfirmProvider><RolesView id="r-1" /></ConfirmProvider>);

describe("RolesView", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists the tenant's roles with their holders, and the templates with nothing to edit", async () => {
    answer(["support.agent"]);
    show();
    const own = await screen.findByTestId("own-roles");
    expect(within(own).getByText("Desk")).toBeTruthy();
    expect(within(own).getByText(`${K.members} {"count":2}`)).toBeTruthy();
    expect(within(own).getAllByText("Answer support").length).toBeGreaterThan(0);
    const templates = screen.getByTestId("template-roles");
    expect(within(templates).getByText("Support")).toBeTruthy();
    expect(within(templates).queryByText(K.edit)).toBeNull();
    expect(tenantRolesApi.list).toHaveBeenCalledWith("r-1");
  });

  it("will not delete a role someone holds", async () => {
    answer(["support.agent"]);
    show();
    const desk = await screen.findByTestId("role-role-desk");
    expect((within(desk).getByText(K.delete).closest("button") as HTMLButtonElement).disabled).toBe(true);
    const spare = screen.getByTestId("role-role-spare");
    expect((within(spare).getByText(K.delete).closest("button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers only the keys this caller may grant, by area, and sends the ticked set", async () => {
    answer(["support.agent"]);
    vi.mocked(tenantRolesApi.create).mockResolvedValue({ role: { id: "role-new", name: "Helpers", isTemplate: false, isSystemRole: false, permissions: ["support.agent"] } });
    show();
    fireEvent.click(await screen.findByText(K.create));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Answer support")).toBeTruthy();
    expect(within(dialog).queryByLabelText("Manage support")).toBeNull();
    expect(within(dialog).queryByLabelText("Manage resellers")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(K.name), { target: { value: "Helpers" } });
    fireEvent.click(within(dialog).getByLabelText("Answer support"));
    fireEvent.click(within(dialog).getByText(K.save));
    await waitFor(() => expect(tenantRolesApi.create).toHaveBeenCalledWith("r-1", { name: "Helpers", permissions: ["support.agent"] }));
  });

  it("offers every key, platform-only ones marked, when the caller may grant `*`", async () => {
    answer(["*"]);
    show();
    fireEvent.click(await screen.findByText(K.create));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Manage support")).toBeTruthy();
    expect(within(dialog).getByLabelText("Manage resellers")).toBeTruthy();
    expect(within(dialog).getByText(K.platformOnly)).toBeTruthy();
  });
});
