import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResellerPanelButton } from "./ResellerPanelButton";

/**
 * The sidebar's "my reseller" block (F-061-n). Two things the owner does with
 * a reseller, kept apart: **configure it** (its workspace — users, catalog,
 * gateways…) and **go to its panel** (the handoff, F-061-f). On the platform
 * both are offered; on the reseller's own domain only the first, at an
 * address with no id in it — `/my-resellers/<id>` there told a customer-facing
 * domain how the platform manages it.
 */

const push = vi.fn();
let pathname = "/";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => pathname }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({ t: (_ns: string, key: string) => key }),
}));
let me: unknown = null;
vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: () => ({ me }) }));
const issueHandoff = vi.fn();
vi.mock("@/lib/auth-api", () => ({ authApi: { issueHandoff: (id: string) => issueHandoff(id), ownedResellers: async () => ({ resellers: [] }) } }));

const assign = vi.fn();
const PLATFORM_ME = { tenant: { id: "t-platform", type: "platform_owner", isOwner: false }, permissions: [] };
const ARIAN = { id: "r-1", slug: "arian", here: false, hasPanel: true, live: true };

beforeEach(() => {
  vi.clearAllMocks();
  pathname = "/";
  me = PLATFORM_ME;
  Object.defineProperty(window, "location", { value: { assign }, writable: true });
  issueHandoff.mockResolvedValue({ origin: "https://arianvpn.ir", code: "c0de", expiresIn: 60 });
});

describe("ResellerPanelButton on the platform", () => {
  it("offers the reseller's settings by id, and its panel as a separate action", async () => {
    render(<ResellerPanelButton resellers={[ARIAN]} />);

    expect(screen.getByText("arian")).toBeTruthy();
    // Its own live reseller has no id in the address on the platform either (user, 2026-10-08).
    expect(screen.getByRole("link", { name: /resellerNav.settings/ }).getAttribute("href")).toBe("/reseller");

    fireEvent.click(screen.getByRole("button", { name: /resellerNav.open/ }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://arianvpn.ir/auth/handoff#c0de"));
  });

  it("does not offer a handoff that would be refused, and says why", () => {
    render(<ResellerPanelButton resellers={[{ ...ARIAN, hasPanel: false }]} />);

    const open = screen.getByRole("button", { name: /resellerNav.open/ }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    expect(screen.getByText("resellerNav.noPanel")).toBeTruthy();
    fireEvent.click(open);
    expect(issueHandoff).not.toHaveBeenCalled();
  });

  it("marks the settings link current anywhere inside that workspace", () => {
    pathname = "/reseller/gateways";
    render(<ResellerPanelButton resellers={[ARIAN]} />);

    expect(screen.getByRole("link", { name: /resellerNav.settings/ }).getAttribute("aria-current")).toBe("page");
  });
});

describe("ResellerPanelButton, a terminated reseller", () => {
  it("is still reached by id, beside the live one at /reseller", () => {
    render(<ResellerPanelButton resellers={[{ ...ARIAN, id: "r-old", slug: "old", live: false }, ARIAN]} />);

    expect(screen.getAllByRole("link", { name: /resellerNav.settings/ }).map((a) => a.getAttribute("href"))).toEqual([
      "/my-resellers/r-old",
      "/reseller",
    ]);
  });
});

describe("ResellerPanelButton on the reseller's own domain", () => {
  // The owner's session on its reseller's domain is the platform's tenant
  // (ADR-0059); the door's `here` is what says whose domain this is.
  it("offers the owner only its settings, at an address with no id, and no handoff", () => {
    me = PLATFORM_ME;
    render(<ResellerPanelButton resellers={[{ ...ARIAN, here: true }]} />);

    expect(screen.getByRole("link", { name: /resellerNav.settings/ }).getAttribute("href")).toBe("/reseller");
    expect(screen.queryByRole("button", { name: /resellerNav.open/ })).toBeNull();
    expect(document.body.innerHTML).not.toContain("r-1");
  });

  it("offers it to a staff seat holding tenant.manage, which owns nothing", () => {
    me = { tenant: { id: "r-1", type: "reseller", isOwner: false }, permissions: ["tenant.manage"] };
    render(<ResellerPanelButton resellers={[]} />);

    expect(screen.getByRole("link", { name: /resellerNav.settings/ }).getAttribute("href")).toBe("/reseller");
  });

  it("offers nothing to a customer of the reseller", () => {
    me = { tenant: { id: "r-1", type: "reseller", isOwner: false }, permissions: [] };
    const { container } = render(<ResellerPanelButton resellers={[]} />);

    expect(container.innerHTML).toBe("");
  });
});
