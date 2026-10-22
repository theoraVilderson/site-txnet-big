import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { OnboardingConsoleView } from "./[id]/_components/OnboardingConsoleView";
import { ResellerSettingsView } from "./[id]/settings/_components/ResellerSettingsView";

/**
 * The workspace's home and its settings page (UX-2-b, `contract.resellers.md`
 * "A reseller's workspace"). The home was one page stacking the gate, the
 * steps and seven settings cards; the menu's settings section needed a page
 * of its own, so the cards moved there and the home kept what says how far
 * the reseller is: the gate, setup progress and shortcuts.
 */

const K = FrontendI18nKeys.common.resellerOnboarding;

vi.mock("next/navigation", () => ({ usePathname: () => "/my-resellers/r-1" }));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({ lang: "en", isRtl: false, t: (_ns: string, key: string, vars?: object) => (vars ? `${key} ${JSON.stringify(vars)}` : key) }),
}));
vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: () => ({ me: null, isLoading: false }) }));
vi.mock("@/lib/auth-api", () => ({ authApi: { ownedResellers: vi.fn(async () => ({ resellers: [] })) } }));
vi.mock("@/lib/tenant-onboarding-api", () => ({ resellerOnboardingApi: { get: vi.fn() } }));
const { card } = vi.hoisted(() => ({ card: (name: string) => () => <div data-testid={name} /> }));
vi.mock("../_components/OperatingCurrencyCard", () => ({ OperatingCurrencyCard: card("currency") }));
vi.mock("../_components/TenantTimeZoneCard", () => ({ TenantTimeZoneCard: card("time-zone") }));
vi.mock("./[id]/_components/ResellerLimitsCard", () => ({ ResellerLimitsCard: card("limits") }));
vi.mock("./[id]/_components/SupportAccessCard", () => ({ SupportAccessCard: card("support-access") }));
vi.mock("./[id]/_components/DataExportCard", () => ({ DataExportCard: card("data-export") }));
vi.mock("../_components/SelfMoveSettings", () => ({ SelfMoveSettings: card("self-move") }));
vi.mock("./[id]/_components/QuotaCards", () => ({
  ProductQuotasCard: card("product-quotas"),
  OverageCapCard: card("overage-cap"),
  PackageChangeCard: card("package-change"),
}));

const CARDS = ["currency", "time-zone", "limits", "product-quotas", "overage-cap", "package-change", "self-move", "support-access", "data-export"];

import { resellerOnboardingApi } from "@/lib/tenant-onboarding-api";

beforeEach(() => {
  vi.mocked(resellerOnboardingApi.get).mockResolvedValue({
    tenantId: "r-1",
    onboarding: true,
    closed: ["signup"],
    complete: false,
    steps: [
      { key: "domain", done: false, gate: true, optional: false, skipped: false },
      { key: "gateway", done: true, gate: false, optional: false, skipped: false },
      { key: "bot", done: false, gate: false, optional: false, skipped: false },
      { key: "pricing", done: true, gate: false, optional: false, skipped: false },
    ],
  } as never);
});

describe("the workspace home", () => {
  it("keeps the gate, says how far setup is, and links its settings", async () => {
    render(<OnboardingConsoleView id="r-1" />);
    expect(await screen.findByText(K.state.closed.title)).toBeInTheDocument();
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "2");
    expect(bar).toHaveAttribute("aria-valuemax", "4");
    expect(screen.getByText(`${K.progress} ${JSON.stringify({ done: 2, total: 4 })}`)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: K.shortcuts })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: K.more.settings.title }).closest("section")?.querySelector("a")).toHaveAttribute(
      "href",
      "/my-resellers/r-1/settings",
    );
  });

  it("no longer stacks the settings cards", async () => {
    render(<OnboardingConsoleView id="r-1" />);
    await screen.findByRole("progressbar");
    for (const id of CARDS) expect(screen.queryByTestId(id)).toBeNull();
  });
});

describe("the workspace settings page", () => {
  it("holds every card the home stacked, under its own header", () => {
    render(<ResellerSettingsView id="r-1" />);
    expect(screen.getByRole("heading", { name: K.settingsPage.title })).toBeInTheDocument();
    for (const id of CARDS) expect(screen.getByTestId(id)).toBeInTheDocument();
  });
});
