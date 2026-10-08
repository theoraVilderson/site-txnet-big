import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { UserStatusControl } from "./_components/UserStatusControl";

/**
 * BAN-1-f (ADR-0133). The agent restricts, bans and lifts from the
 * conversation's sidebar — each offered by the caller's own key, so an agent
 * without `user.ban` is never shown a ban the server would refuse, and a block
 * always carries the reason the person will read.
 */

const A = FrontendI18nKeys.common.supportAgent.account;
const api = vi.hoisted(() => ({ userStatus: vi.fn(), setUserStatus: vi.fn() }));
const ask = vi.fn(async () => true);
let permissions: string[] = [];

vi.mock("@/lib/auth-api", () => ({ authApi: api }));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({ lang: "en", isRtl: false, t: (_ns: string, key: string) => key }),
}));
vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: () => ({ me: { userId: "agent", permissions } }) }));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => (e: unknown) => String(e) }));
vi.mock("../_components/kit/confirm", () => ({ useConfirm: () => ask }));
vi.mock("../_components/kit/notify", () => ({ notify: { success: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  api.userStatus.mockResolvedValue({ id: "u-1", status: "active", statusReason: null });
  api.setUserStatus.mockImplementation(async (id: string, status: string, reason?: string) => ({ id, status, statusReason: reason ?? null }));
});

describe("the agent's account control", () => {
  it("offers an agent restriction only, and sends the reason with it", async () => {
    permissions = ["support.agent", "restriction.assign"];
    render(<UserStatusControl userId="u-1" />);

    fireEvent.click(await screen.findByRole("button", { name: A.restrict }));
    expect(screen.queryByRole("button", { name: A.ban })).toBeNull();

    const confirm = screen.getByRole("button", { name: A.confirm }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(A.reasonLabel), { target: { value: "chargeback on 1042" } });
    fireEvent.click(confirm);

    await waitFor(() => expect(api.setUserStatus).toHaveBeenCalledWith("u-1", "suspended", "chargeback on 1042"));
    expect(await screen.findByText(A.suspended)).toBeTruthy();
    expect(screen.getByText("chargeback on 1042")).toBeTruthy();
  });

  it("offers a holder of user.ban the ban, and the lift of one after asking", async () => {
    permissions = ["restriction.assign", "user.ban"];
    api.userStatus.mockResolvedValue({ id: "u-1", status: "banned", statusReason: "resold" });
    render(<UserStatusControl userId="u-1" />);

    fireEvent.click(await screen.findByRole("button", { name: A.unban }));

    await waitFor(() => expect(api.setUserStatus).toHaveBeenCalledWith("u-1", "active", undefined));
    expect(ask).toHaveBeenCalled();
  });

  it("draws nothing for a caller with neither key, and asks nothing", () => {
    permissions = ["support.agent"];
    const { container } = render(<UserStatusControl userId="u-1" />);
    expect(container.innerHTML).toBe("");
    expect(api.userStatus).not.toHaveBeenCalled();
  });
});
