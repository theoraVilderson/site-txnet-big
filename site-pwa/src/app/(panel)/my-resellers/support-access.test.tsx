/**
 * The reseller's "support access" card on its workspace console (F-117-f,
 * ADR-0104 (4)(6), audit `contract.md` "Support consent").
 *
 * What breaks without anyone seeing it:
 *  - **a request granted on terms the reseller did not choose.** Approving
 *    sends the request's id with the scope and hours picked on the card,
 *    never the scope the platform asked for by default;
 *  - **a revoke that cannot be undone sent on one click.** It is asked first;
 *  - **a time left that says "0 minutes" while access is still open.** It is
 *    rounded up, and an expired grant reads as expired, not as 0;
 *  - **the card shown to the platform's staff.** They are refused the trail
 *    (`reseller_only`); the card then shows nothing — their side is on the
 *    users pages (F-117-g);
 *  - **an emergency entry hidden.** Tier C is listed with its reason, apart
 *    from consents, since the reseller never granted it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLocale } from "@/context/LocaleContext";
import { ApiError } from "@/lib/api-error";
import { supportConsentApi, type ConsentView, type SupportConsentList } from "@/lib/auth-api";
import { SupportAccessCard } from "./[id]/_components/SupportAccessCard";
import { consentSides, hoursOf, supportRefusalKey, timeLeft } from "./_lib/support-access";

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  supportConsentApi: {
    list: vi.fn(),
    activity: vi.fn(),
    grant: vi.fn(),
    revoke: vi.fn(),
    setPolicy: vi.fn(),
    request: vi.fn(),
    enterEmergency: vi.fn(),
    endEmergency: vi.fn(),
  },
}));

const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);
const S = "supportAccess";
const RESELLER = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-04T10:00:00Z");

const consent = (over: Partial<ConsentView>): ConsentView => ({
  id: "c1",
  scope: "read",
  state: "requested",
  reason: null,
  requestedByUserId: null,
  requestedAt: null,
  grantedByUserId: null,
  grantedAt: null,
  expiresAt: null,
  revokedByUserId: null,
  revokedAt: null,
  ...over,
});

const list = (over: Partial<SupportConsentList> = {}): SupportConsentList => ({ defaultHours: 4, items: [], emergency: [], ...over });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.mocked(useLocale).mockReturnValue({ t, lang: "en" } as never);
  vi.mocked(supportConsentApi.activity).mockResolvedValue({ page: 1, items: [] });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("timeLeft", () => {
  it("rounds up to the minute, and is null once the grant has run out", () => {
    expect(timeLeft("2026-10-04T12:30:00Z", NOW)).toEqual({ hours: 2, minutes: 30 });
    expect(timeLeft("2026-10-04T10:00:20Z", NOW)).toEqual({ hours: 0, minutes: 1 });
    expect(timeLeft("2026-10-04T10:00:00Z", NOW)).toBeNull();
    expect(timeLeft(null, NOW)).toBeNull();
  });
});

describe("consentSides", () => {
  it("the open request and the live grant apart from the rest, as the service named their state", () => {
    const req = consent({ id: "r", state: "requested" });
    const live = consent({ id: "l", state: "live", expiresAt: "2026-10-04T12:00:00Z" });
    const old = consent({ id: "o", state: "expired" });
    expect(consentSides([req, live, old])).toEqual({ pending: req, live, past: [old] });
    expect(consentSides([old])).toEqual({ pending: null, live: null, past: [old] });
  });
});

describe("hoursOf", () => {
  it("a whole number from 1 to 24, else nothing to send", () => {
    expect(hoursOf("4")).toBe(4);
    expect(hoursOf(" 24 ")).toBe(24);
    expect(hoursOf("0")).toBeUndefined();
    expect(hoursOf("25")).toBeUndefined();
    expect(hoursOf("1.5")).toBeUndefined();
  });
});

describe("supportRefusalKey", () => {
  it("names the consent surface's and the door's refusals, and nothing else", () => {
    expect(supportRefusalKey(new ApiError("x", { status: 409, reason: "request_pending" }))).toBe(`${S}.refusals.request_pending`);
    expect(supportRefusalKey({ reason: "consent_required" })).toBe(`${S}.refusals.consent_required`);
    expect(supportRefusalKey({ reason: "something_else" })).toBeNull();
  });
});

describe("SupportAccessCard", () => {
  it("approves a pending request on the scope and hours chosen here, with the request's id", async () => {
    vi.mocked(supportConsentApi.list).mockResolvedValue(
      list({ items: [consent({ id: "req-1", scope: "act", state: "requested", reason: "user cannot connect since Monday", requestedAt: "2026-10-04T09:00:00Z" })] }),
    );
    vi.mocked(supportConsentApi.grant).mockResolvedValue(consent({ id: "req-1", state: "live" }));
    render(<SupportAccessCard tenantId={RESELLER} />);
    await waitFor(() => expect(screen.getByText("user cannot connect since Monday")).toBeInTheDocument());
    expect(supportConsentApi.list).toHaveBeenCalledWith(RESELLER);

    fireEvent.click(screen.getByLabelText(`${S}.scope.read.title`));
    fireEvent.change(screen.getByLabelText(`${S}.grant.hours`), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: `${S}.pending.approve` }));
    await waitFor(() => expect(supportConsentApi.grant).toHaveBeenCalledWith(RESELLER, { scope: "read", hours: 2, requestId: "req-1" }));
  });

  it("declines a request by ending it", async () => {
    vi.mocked(supportConsentApi.list).mockResolvedValue(list({ items: [consent({ id: "req-1", state: "requested", reason: "a reason of ten" })] }));
    vi.mocked(supportConsentApi.revoke).mockResolvedValue(consent({ id: "req-1", state: "declined" }));
    render(<SupportAccessCard tenantId={RESELLER} />);
    fireEvent.click(await screen.findByRole("button", { name: `${S}.pending.decline` }));
    await waitFor(() => expect(supportConsentApi.revoke).toHaveBeenCalledWith(RESELLER, "req-1"));
  });

  it("shows a live grant's time left, and revokes it only after asking", async () => {
    vi.mocked(supportConsentApi.list).mockResolvedValue(list({ items: [consent({ id: "g1", scope: "act", state: "live", grantedAt: "2026-10-04T09:00:00Z", expiresAt: "2026-10-04T11:15:00Z" })] }));
    vi.mocked(supportConsentApi.revoke).mockResolvedValue(consent({ id: "g1", state: "revoked" }));
    render(<SupportAccessCard tenantId={RESELLER} />);
    expect(await screen.findByText(`${S}.live.left:1,15`)).toBeInTheDocument();

    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: `${S}.live.revoke` }));
    expect(supportConsentApi.revoke).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: `${S}.live.revoke` }));
    await waitFor(() => expect(supportConsentApi.revoke).toHaveBeenCalledWith(RESELLER, "g1"));
  });

  it("grants with no request, on the reseller's default length unless one is typed", async () => {
    vi.mocked(supportConsentApi.list).mockResolvedValue(list({ defaultHours: 6 }));
    vi.mocked(supportConsentApi.grant).mockResolvedValue(consent({ state: "live" }));
    render(<SupportAccessCard tenantId={RESELLER} />);
    expect(await screen.findByLabelText(`${S}.grant.hours`)).toHaveValue("6");
    fireEvent.click(screen.getByRole("button", { name: `${S}.grant.submit` }));
    await waitFor(() => expect(supportConsentApi.grant).toHaveBeenCalledWith(RESELLER, { scope: "read", hours: 6 }));
  });

  it("lists the platform's trail and an emergency entry with its reason", async () => {
    vi.mocked(supportConsentApi.list).mockResolvedValue(
      list({ emergency: [{ id: "e1", userId: "u9", reason: "legal order 2026/114 received today", state: "live", startedAt: "2026-10-04T09:30:00Z", expiresAt: "2026-10-04T10:30:00Z", endedAt: null }] }),
    );
    vi.mocked(supportConsentApi.activity).mockResolvedValue({
      page: 1,
      items: [{ id: "a1", at: "2026-10-04T09:40:00Z", actorUserId: "u9", tier: "emergency", consentId: null, entryId: "e1", scope: "act", act: "GET /auth/tenants/:tenantId/users", target: {} }],
    });
    render(<SupportAccessCard tenantId={RESELLER} />);
    expect(await screen.findByText("legal order 2026/114 received today")).toBeInTheDocument();
    expect(screen.getByText("GET /auth/tenants/:tenantId/users")).toBeInTheDocument();
    expect(screen.getAllByText(`${S}.tiers.emergency`).length).toBeGreaterThan(0);
    expect(supportConsentApi.activity).toHaveBeenCalledWith(RESELLER, 1);
  });

  it("shows nothing to the platform's staff, who are refused the trail", async () => {
    vi.mocked(supportConsentApi.list).mockResolvedValue(list());
    vi.mocked(supportConsentApi.activity).mockRejectedValue(new ApiError("x", { status: 403, reason: "reseller_only" }));
    const { container } = render(<SupportAccessCard tenantId={RESELLER} />);
    await waitFor(() => expect(supportConsentApi.activity).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
