import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { SetupWizardView } from "./[id]/setup/_components/SetupWizardView";
import { OnboardingConsoleView } from "./[id]/_components/OnboardingConsoleView";
import { firstUndoneIndex, setupSlide } from "./_lib/setup";

/**
 * The setup wizard at `/reseller/setup` (UX-2-c, `contract.reseller-workspace.md`
 * "The setup wizard"): one step at a time in the onboarding route's order, a
 * progress bar counted from the route, the domain step's DNS records with
 * copy, and a live re-read on `tenant.domain.changed` — never a poll.
 */

const K = FrontendI18nKeys.common.resellerOnboarding;
const W = K.wizard;

vi.mock("next/navigation", () => ({ usePathname: () => "/my-resellers/r-1/setup", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({ lang: "en", isRtl: false, t: (_ns: string, key: string, vars?: object) => (vars ? `${key} ${JSON.stringify(vars)}` : key) }),
}));
vi.mock("@/hooks/useMotionLevel", () => ({ useMotionLevel: () => "reduced" }));
vi.mock("../_context/PanelSessionContext", () => ({
  usePanelSession: () => ({ me: { tenant: { id: "p-1", type: "platform_owner" }, permissions: [] }, group: { current: { userId: "u-1" } }, isLoading: false }),
}));
vi.mock("@/lib/auth-api", () => ({
  authApi: { ownedResellers: vi.fn(async () => ({ resellers: [] })) },
  audienceGroups: vi.fn(async () => []),
  resellerBotsApi: { list: vi.fn(async () => []) },
}));
// The other steps' screens are UX-2-d's (`setup-steps.test.tsx`).
vi.mock("../gateways/_components/GatewaysView", () => ({ GatewaysView: () => <div data-testid="gateways-view" /> }));
vi.mock("../catalog/_components/CatalogView", () => ({ CatalogView: () => <div data-testid="catalog-view" /> }));
vi.mock("@/lib/tenant-onboarding-api", () => ({ resellerOnboardingApi: { get: vi.fn(), skip: vi.fn(), unskip: vi.fn() } }));
vi.mock("@/lib/tenant-api", () => ({
  resellerDomainsApi: { list: vi.fn(), add: vi.fn(), check: vi.fn() },
}));
const { live } = vi.hoisted(() => ({ live: [] as { channel: string | null; types: readonly string[] | "any"; reread: () => void }[] }));
vi.mock("@/hooks/useLiveReread", () => ({
  useLiveReread: (channel: string | null, types: readonly string[] | "any", reread: () => void) => {
    live.push({ channel, types, reread });
  },
}));
vi.mock("./_lib/workspace", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useWorkspaceSelf: () => false,
}));

import { resellerDomainsApi } from "@/lib/tenant-api";
import { resellerOnboardingApi, type ResellerOnboarding } from "@/lib/tenant-onboarding-api";

const view = (done: Partial<Record<"domain" | "gateway" | "bot" | "pricing", boolean>>): ResellerOnboarding => {
  const steps = (["domain", "gateway", "bot", "pricing"] as const).map((key) => ({ key, done: !!done[key], gate: key === "domain", optional: false, skipped: false }));
  return { tenantId: "r-1", onboarding: !done.domain, closed: done.domain ? [] : ["register"], steps, complete: steps.every((s) => s.done) };
};

const PENDING = {
  id: "d-1",
  domainValue: "panel.shop.example",
  purpose: "panel",
  status: "pending",
  record: { type: "TXT", name: "_txnet.panel.shop.example", value: "txnet-verify=abc" },
  cnameTarget: "shop.edge.txnet.example",
  edge: { status: "none", record: null, lastError: null },
  verifiedAt: null,
  lastCheckedAt: null,
  lastCheck: null,
};

const domainEvents = () => live.filter((l) => Array.isArray(l.types) && l.types.includes("tenant.domain.changed"));

beforeEach(() => {
  live.length = 0;
  vi.mocked(resellerOnboardingApi.get).mockReset();
  vi.mocked(resellerDomainsApi.list).mockResolvedValue([PENDING] as never);
});

describe("which step it opens at", () => {
  it("is the first undone step in the route's order — 'later' is not stored", () => {
    expect(firstUndoneIndex(view({ domain: true }).steps)).toBe(1);
    expect(firstUndoneIndex(view({ domain: true, gateway: true, bot: true }).steps)).toBe(3);
    expect(firstUndoneIndex(view({}).steps)).toBe(0);
    // All done: the first step, the wizard draws its finished screen instead.
    expect(firstUndoneIndex(view({ domain: true, gateway: true, bot: true, pricing: true }).steps)).toBe(0);
  });

  it("opens there, with the progress bar counted from the route", async () => {
    vi.mocked(resellerOnboardingApi.get).mockResolvedValue(view({ domain: true, pricing: true }));
    render(<SetupWizardView id="r-1" />);
    expect(await screen.findByRole("heading", { name: K.steps.gateway.title })).toBeInTheDocument();
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "2");
    expect(bar).toHaveAttribute("aria-valuemax", "4");
    expect(screen.getByRole("link", { name: W.later })).toHaveAttribute("href", "/my-resellers/r-1");
  });
});

describe("the domain step", () => {
  it("shows the domain's DNS records, each with a copy button", async () => {
    vi.mocked(resellerOnboardingApi.get).mockResolvedValue(view({}));
    render(<SetupWizardView id="r-1" />);
    expect((await screen.findAllByText("txnet-verify=abc")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("shop.edge.txnet.example").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: FrontendI18nKeys.common.resellerDomains.copy }).length).toBeGreaterThanOrEqual(2);
  });

  it("re-reads the checklist on tenant.domain.changed, and says the reseller is open", async () => {
    vi.mocked(resellerOnboardingApi.get).mockResolvedValueOnce(view({})).mockResolvedValue(view({ domain: true }));
    render(<SetupWizardView id="r-1" />);
    await screen.findAllByText("txnet-verify=abc");
    expect(screen.queryByText(W.domainOpen)).toBeNull();

    const subscriptions = domainEvents();
    expect(subscriptions.some((l) => l.channel === "user:u-1")).toBe(true);
    await act(async () => {
      for (const s of subscriptions) s.reread();
    });
    expect(await screen.findByText(W.domainOpen)).toBeInTheDocument();
    expect(vi.mocked(resellerOnboardingApi.get).mock.calls.length).toBeGreaterThan(1);
  });
});

describe("moving through it", () => {
  it("walks forward and back in the route's order", async () => {
    vi.mocked(resellerOnboardingApi.get).mockResolvedValue(view({}));
    render(<SetupWizardView id="r-1" />);
    await screen.findByRole("heading", { name: K.steps.domain.title });
    // The domain is not done: forward reads "skip for now", and nothing is stored.
    fireEvent.click(screen.getByRole("button", { name: W.skip }));
    expect(await screen.findByRole("heading", { name: K.steps.gateway.title })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: W.back }));
    expect(await screen.findByRole("heading", { name: K.steps.domain.title })).toBeInTheDocument();
  });

  it("draws the finished screen when every step is done", async () => {
    vi.mocked(resellerOnboardingApi.get).mockResolvedValue(view({ domain: true, gateway: true, bot: true, pricing: true }));
    render(<SetupWizardView id="r-1" />);
    expect(await screen.findByText(W.finished.title)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "4"));
  });
});

describe("the way in", () => {
  it("is on the home while setup is not complete, and gone once it is", async () => {
    vi.mocked(resellerOnboardingApi.get).mockResolvedValue(view({ domain: true }));
    const { unmount } = render(<OnboardingConsoleView id="r-1" />);
    expect(await screen.findByRole("link", { name: W.start })).toHaveAttribute("href", "/my-resellers/r-1/setup");
    unmount();

    vi.mocked(resellerOnboardingApi.get).mockResolvedValue(view({ domain: true, gateway: true, bot: true, pricing: true }));
    render(<OnboardingConsoleView id="r-1" />);
    await screen.findByRole("progressbar");
    expect(screen.queryByRole("link", { name: W.start })).toBeNull();
  });
});

describe("motion", () => {
  it("slides by direction and reading order at full, fades only at reduced (M3)", () => {
    expect(setupSlide("full", 1, false)).toEqual({ x: 24, opacity: 0 });
    expect(setupSlide("full", 1, true)).toEqual({ x: -24, opacity: 0 });
    expect(setupSlide("full", -1, false)).toEqual({ x: -24, opacity: 0 });
    expect(setupSlide("reduced", 1, false)).toEqual({ opacity: 0 });
  });
});
