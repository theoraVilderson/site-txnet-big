import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { SetupWizardView } from "./[id]/setup/_components/SetupWizardView";

/**
 * The wizard's pricing, gateway and bot steps, and its brand screen (UX-2-d,
 * `contract.reseller-workspace.md` "The setup wizard"): each step is the
 * workspace screen's own components, inside the wizard and by the path's
 * reseller — no new route; the brand screen comes last and counts toward no
 * progress.
 */

const K = FrontendI18nKeys.common.resellerOnboarding;
const W = K.wizard;
const BOT = FrontendI18nKeys.common.resellerBots;
const BRAND = FrontendI18nKeys.common.resellerBranding;

vi.mock("next/navigation", () => ({ usePathname: () => "/my-resellers/r-1/setup", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({ lang: "en", isRtl: false, availableLocales: ["en"], t: (_ns: string, key: string, vars?: object) => (vars ? `${key} ${JSON.stringify(vars)}` : key) }),
}));
vi.mock("@/hooks/useMotionLevel", () => ({ useMotionLevel: () => "reduced" }));
vi.mock("@/hooks/useLiveReread", () => ({ useLiveReread: () => undefined }));
vi.mock("../_context/PanelSessionContext", () => ({
  usePanelSession: () => ({ me: { tenant: { id: "p-1", type: "platform_owner" }, permissions: [] }, group: { current: { userId: "u-1" } }, isLoading: false }),
}));
vi.mock("@/lib/auth-api", () => ({
  authApi: { ownedResellers: vi.fn(async () => ({ resellers: [] })) },
  resellerUserGroupsApi: { list: vi.fn(async () => []) },
  resellerBotsApi: { list: vi.fn(async () => []), connect: vi.fn(), retire: vi.fn() },
}));
vi.mock("@/lib/tenant-api", () => ({
  resellerOnboardingApi: { get: vi.fn() },
  resellerDomainsApi: { list: vi.fn(async () => []), add: vi.fn(), check: vi.fn() },
  resellerBrandingApi: { get: vi.fn(async () => ({ lineNameTemplate: null })), previewLineName: vi.fn(async () => null), save: vi.fn() },
}));
vi.mock("./_lib/workspace", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useWorkspaceSelf: () => false,
}));

// The screens' own views, as the wizard hands them their surface.
const { seen } = vi.hoisted(() => ({ seen: { gateways: null as null | { tenantId: string | null; embedded?: boolean; onChanged?: () => void }, catalog: null as null | { tenantId: string | null; embedded?: boolean; onChanged?: () => void } } }));
vi.mock("../gateways/_components/GatewaysView", () => ({
  GatewaysView: ({ surface }: { surface: NonNullable<typeof seen.gateways> }) => {
    seen.gateways = surface;
    return <div data-testid="gateways-view" />;
  },
}));
vi.mock("../catalog/_components/CatalogView", async () => {
  const { useCatalogSurface } = await import("../catalog/_lib/surface");
  return {
    CatalogView: () => {
      seen.catalog = useCatalogSurface();
      return <div data-testid="catalog-view" />;
    },
  };
});

import { resellerOnboardingApi, type ResellerOnboarding } from "@/lib/tenant-api";

const view = (done: Partial<Record<"domain" | "gateway" | "bot" | "pricing", boolean>>): ResellerOnboarding => {
  const steps = (["domain", "gateway", "bot", "pricing"] as const).map((key) => ({ key, done: !!done[key], gate: key === "domain" }));
  return { tenantId: "r-1", onboarding: !done.domain, closed: [], steps, complete: steps.every((s) => s.done) };
};

beforeEach(() => {
  seen.gateways = null;
  seen.catalog = null;
  vi.mocked(resellerOnboardingApi.get).mockReset();
});

describe("each step is its screen's own form, inside the wizard", () => {
  it("the gateway step: the gateways screen, embedded, by the path's reseller", async () => {
    vi.mocked(resellerOnboardingApi.get).mockResolvedValue(view({ domain: true }));
    render(<SetupWizardView id="r-1" />);
    expect(await screen.findByTestId("gateways-view")).toBeInTheDocument();
    expect(seen.gateways).toMatchObject({ tenantId: "r-1", embedded: true });
  });

  it("a gateway saved there re-reads the checklist, and the step says it is done", async () => {
    vi.mocked(resellerOnboardingApi.get).mockResolvedValueOnce(view({ domain: true })).mockResolvedValue(view({ domain: true, gateway: true }));
    render(<SetupWizardView id="r-1" />);
    await screen.findByTestId("gateways-view");
    expect(screen.queryByText(W.stepDone)).toBeNull();
    await act(async () => seen.gateways?.onChanged?.());
    expect(await screen.findByText(W.stepDone)).toBeInTheDocument();
  });

  it("the bot step: the connect form", async () => {
    vi.mocked(resellerOnboardingApi.get).mockResolvedValue(view({ domain: true, gateway: true }));
    render(<SetupWizardView id="r-1" />);
    expect(await screen.findByRole("heading", { name: BOT.add.title })).toBeInTheDocument();
  });

  it("the pricing step: the catalog screen, embedded, by the path's reseller", async () => {
    vi.mocked(resellerOnboardingApi.get).mockResolvedValue(view({ domain: true, gateway: true, bot: true }));
    render(<SetupWizardView id="r-1" />);
    expect(await screen.findByTestId("catalog-view")).toBeInTheDocument();
    expect(seen.catalog).toMatchObject({ tenantId: "r-1", embedded: true });
  });
});

describe("the brand screen", () => {
  it("follows the last step, is optional, and counts toward no progress", async () => {
    vi.mocked(resellerOnboardingApi.get).mockResolvedValue(view({ domain: true, gateway: true, bot: true }));
    render(<SetupWizardView id="r-1" />);
    await screen.findByTestId("catalog-view");
    fireEvent.click(screen.getByRole("button", { name: W.skip }));
    expect(await screen.findByRole("heading", { name: W.brand.title })).toBeInTheDocument();
    expect(screen.getByText(W.brand.optional)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: BRAND.lineName.title })).toBeInTheDocument();
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "3");
    expect(bar).toHaveAttribute("aria-valuemax", "4");
  });

  it("is where a fully set-up reseller lands, under the finished screen", async () => {
    vi.mocked(resellerOnboardingApi.get).mockResolvedValue(view({ domain: true, gateway: true, bot: true, pricing: true }));
    render(<SetupWizardView id="r-1" />);
    expect(await screen.findByText(W.finished.title)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: W.brand.title })).toBeInTheDocument();
  });
});
