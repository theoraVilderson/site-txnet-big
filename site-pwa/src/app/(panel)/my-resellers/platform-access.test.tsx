/**
 * The platform's side of support access, on a reseller's users pages
 * (F-117-g, ADR-0104 (4)(5), audit `contract.md` "Support consent", "Emergency entry").
 *
 * What breaks without anyone seeing it:
 *  - **the banner shown to the reseller's own people**, or to a platform user
 *    who owns this reseller: the door admits them without a consent, so
 *    there is nothing to ask for;
 *  - **"no consent" read as a failure.** The users list refused with
 *    `consent_required` says "ask the reseller", not an error with a retry;
 *  - **a request sent with a reason the service refuses.** The button waits
 *    for 10 characters, the emergency form for 20;
 *  - **an emergency entry on one click.** It notifies the owner at once and
 *    cannot be extended, so it is asked first — and offered only to a holder
 *    of `tenant.emergency_access`;
 *  - **access that looks open after it ran out.** Time left is the service's
 *    `expiresAt` against now, rounded up.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLocale } from "@/context/LocaleContext";
import { authApi, supportConsentApi, type ConsentView, type Me, type SupportConsentList } from "@/lib/auth-api";
import { usePanelSession } from "../_context/PanelSessionContext";
import { ConsentNeeded, PlatformAccessBanner } from "./_components/PlatformAccessBanner";
import { consentRefusal, staffVisitor } from "./_lib/support-access";

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: vi.fn() }));
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  authApi: { ownedResellers: vi.fn() },
  supportConsentApi: { list: vi.fn(), request: vi.fn(), revoke: vi.fn(), enterEmergency: vi.fn(), endEmergency: vi.fn() },
}));

const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);
const S = "supportAccess";
const PLATFORM = "11111111-1111-4111-8111-111111111111";
const RESELLER = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-04T10:00:00Z");

const staff = (permissions: string[] = ["tenant.manage"]): Me => ({
  userId: "staff-1",
  fullName: "Support",
  role: { id: "r", name: "support" },
  permissions,
  tenant: { id: PLATFORM, type: "platform_owner", isOwner: false },
  email: null,
  isImpersonated: false,
});

const consent = (over: Partial<ConsentView>): ConsentView => ({
  id: "c1", scope: "read", state: "requested", reason: null, requestedByUserId: null, requestedAt: null,
  grantedByUserId: null, grantedAt: null, expiresAt: null, revokedByUserId: null, revokedAt: null, ...over,
});
const list = (over: Partial<SupportConsentList> = {}): SupportConsentList => ({ defaultHours: 4, items: [], emergency: [], ...over });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.mocked(useLocale).mockReturnValue({ t, lang: "en" } as never);
  vi.mocked(usePanelSession).mockReturnValue({ me: staff() } as never);
  vi.mocked(authApi.ownedResellers).mockResolvedValue({ resellers: [] } as never);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("staffVisitor", () => {
  it("platform staff on another tenant's page, unless they own it or it is the platform's own", () => {
    expect(staffVisitor(RESELLER, staff(), [])).toBe(true);
    expect(staffVisitor(RESELLER, staff(), [RESELLER])).toBe(false);
    expect(staffVisitor(PLATFORM, staff(), [])).toBe(false);
    expect(staffVisitor(RESELLER, { tenant: { id: RESELLER, type: "reseller" } }, [])).toBe(false);
    expect(staffVisitor(RESELLER, null, [])).toBe(false);
  });
});

describe("consentRefusal", () => {
  it("the door's two refusals, and nothing else", () => {
    expect(consentRefusal({ reason: "consent_required" })).toBe("consent_required");
    expect(consentRefusal({ reason: "consent_read_only" })).toBe("consent_read_only");
    expect(consentRefusal({ reason: "not_allowed" })).toBeNull();
    expect(consentRefusal(null)).toBeNull();
  });
});

describe("PlatformAccessBanner", () => {
  it("shows nothing to a visitor who is not platform staff here", async () => {
    vi.mocked(authApi.ownedResellers).mockResolvedValue({ resellers: [{ id: RESELLER, slug: "acme" }] } as never);
    vi.mocked(supportConsentApi.list).mockResolvedValue(list());
    const { container } = render(<PlatformAccessBanner tenantId={RESELLER} />);
    await waitFor(() => expect(authApi.ownedResellers).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("with no access, asks the reseller once the reason is long enough", async () => {
    vi.mocked(supportConsentApi.list).mockResolvedValue(list());
    vi.mocked(supportConsentApi.request).mockResolvedValue(consent({ state: "requested" }));
    const changed = vi.fn();
    render(<PlatformAccessBanner tenantId={RESELLER} onChange={changed} />);
    expect(await screen.findByText(`${S}.staff.none`)).toBeInTheDocument();

    const send = screen.getByRole("button", { name: `${S}.staff.request.submit` });
    fireEvent.change(screen.getByLabelText(`${S}.staff.request.reason`), { target: { value: "too short" } });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByLabelText(`${S}.scope.act.title`));
    fireEvent.change(screen.getByLabelText(`${S}.staff.request.reason`), { target: { value: "  user 42 cannot connect  " } });
    fireEvent.click(send);
    await waitFor(() => expect(supportConsentApi.request).toHaveBeenCalledWith(RESELLER, { scope: "act", reason: "user 42 cannot connect" }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });

  it("an open request waits for the reseller and may be withdrawn", async () => {
    vi.mocked(supportConsentApi.list).mockResolvedValue(list({ items: [consent({ id: "r1", state: "requested" })] }));
    vi.mocked(supportConsentApi.revoke).mockResolvedValue(consent({ id: "r1", state: "declined" }));
    render(<PlatformAccessBanner tenantId={RESELLER} />);
    expect(await screen.findByText(`${S}.staff.pending`)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `${S}.staff.request.submit` })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: `${S}.staff.withdraw` }));
    await waitFor(() => expect(supportConsentApi.revoke).toHaveBeenCalledWith(RESELLER, "r1"));
  });

  it("a live consent shows its scope and time left", async () => {
    vi.mocked(supportConsentApi.list).mockResolvedValue(list({ items: [consent({ id: "g1", scope: "read", state: "live", expiresAt: "2026-10-04T13:00:30Z" })] }));
    render(<PlatformAccessBanner tenantId={RESELLER} />);
    expect(await screen.findByText(`${S}.live.title:${S}.scope.read.title`)).toBeInTheDocument();
    expect(screen.getByText(`${S}.live.left:3,1`)).toBeInTheDocument();
  });

  it("emergency entry: offered only to its permission's holder, asked first, a 20-character reason", async () => {
    vi.mocked(supportConsentApi.list).mockResolvedValue(list());
    const { unmount } = render(<PlatformAccessBanner tenantId={RESELLER} />);
    await screen.findByText(`${S}.staff.none`);
    expect(screen.queryByRole("button", { name: `${S}.staff.emergency.submit` })).toBeNull();
    unmount();

    vi.mocked(usePanelSession).mockReturnValue({ me: staff(["tenant.manage", "tenant.emergency_access"]) } as never);
    vi.mocked(supportConsentApi.enterEmergency).mockResolvedValue({ id: "e1" } as never);
    render(<PlatformAccessBanner tenantId={RESELLER} />);
    const enter = await screen.findByRole("button", { name: `${S}.staff.emergency.submit` });
    fireEvent.change(screen.getByLabelText(`${S}.staff.emergency.reason`), { target: { value: "abuse report" } });
    expect(enter).toBeDisabled();
    fireEvent.change(screen.getByLabelText(`${S}.staff.emergency.reason`), { target: { value: "court order 2026/114, served today" } });

    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(enter);
    expect(supportConsentApi.enterEmergency).not.toHaveBeenCalled();
    fireEvent.click(enter);
    await waitFor(() => expect(supportConsentApi.enterEmergency).toHaveBeenCalledWith(RESELLER, "court order 2026/114, served today"));
  });

  it("the caller's own running entry shows its time left and ends early", async () => {
    vi.mocked(usePanelSession).mockReturnValue({ me: staff(["*"]) } as never);
    vi.mocked(supportConsentApi.list).mockResolvedValue(
      list({ emergency: [{ id: "e1", userId: "staff-1", reason: "court order 2026/114, served today", state: "live", startedAt: "2026-10-04T09:30:00Z", expiresAt: "2026-10-04T10:30:00Z", endedAt: null }] }),
    );
    vi.mocked(supportConsentApi.endEmergency).mockResolvedValue({ id: "e1" } as never);
    render(<PlatformAccessBanner tenantId={RESELLER} />);
    expect(await screen.findByText(`${S}.staff.emergency.live:0,30`)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `${S}.staff.emergency.submit` })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: `${S}.staff.emergency.end` }));
    await waitFor(() => expect(supportConsentApi.endEmergency).toHaveBeenCalledWith(RESELLER, "e1"));
  });
});

describe("ConsentNeeded", () => {
  it("says to ask the reseller for the door's refusals, and leaves every other one to the page", () => {
    const { container, rerender } = render(<ConsentNeeded error={{ reason: "consent_required" }} />);
    expect(screen.getByRole("status")).toHaveTextContent(`${S}.refusals.consent_required`);
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<ConsentNeeded error={{ reason: "not_allowed" }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("PlatformAccessBanner, a read-only consent", () => {
  it("keeps the request form, so staff can ask for act; an act consent does not", async () => {
    vi.mocked(supportConsentApi.list).mockResolvedValue(list({ items: [consent({ id: "g1", scope: "read", state: "live", expiresAt: "2026-10-04T12:00:00Z" })] }));
    const { unmount } = render(<PlatformAccessBanner tenantId={RESELLER} />);
    expect(await screen.findByRole("button", { name: `${S}.staff.request.submit` })).toBeInTheDocument();
    expect(screen.queryByText(`${S}.staff.none`)).toBeNull();
    unmount();
    vi.mocked(supportConsentApi.list).mockResolvedValue(list({ items: [consent({ id: "g2", scope: "act", state: "live", expiresAt: "2026-10-04T12:00:00Z" })] }));
    render(<PlatformAccessBanner tenantId={RESELLER} />);
    await screen.findByText(`${S}.live.title:${S}.scope.act.title`);
    expect(screen.queryByRole("button", { name: `${S}.staff.request.submit` })).toBeNull();
  });
});
