import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { SetupWizardView } from "./[id]/setup/_components/SetupWizardView";
import { OnboardingConsoleView } from "./[id]/_components/OnboardingConsoleView";
import { stepHref } from "./_lib/onboarding";
import { setupProgress } from "./_lib/setup";

/**
 * The optional first step, «bring my users» (F-213, `contract.reseller-workspace.md`
 * "The setup wizard"; tenant `contract.onboarding.md` "The checklist").
 *
 * What breaks without anyone seeing it:
 *  - **a reseller already set up pulled back to "incomplete".** The step
 *    counts toward neither the progress bar nor the menu's row (user,
 *    2026-10-22);
 *  - **a skip that is not a skip.** "I have no users to bring" stores it and
 *    re-reads; a skipped step says so and can be taken back;
 *  - **a link to the platform's own page.** It goes to this reseller's
 *    migration page, on the address the visitor uses.
 */

const K = FrontendI18nKeys.common.resellerOnboarding;
const I = K.wizard.import;

vi.mock("next/navigation", () => ({ usePathname: () => "/my-resellers/r-1/setup", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({ lang: "en", isRtl: false, t: (_ns: string, key: string, vars?: object) => (vars ? `${key} ${JSON.stringify(vars)}` : key) }),
}));
vi.mock("@/hooks/useMotionLevel", () => ({ useMotionLevel: () => "reduced" }));
vi.mock("@/hooks/useLiveReread", () => ({ useLiveReread: vi.fn() }));
vi.mock("../_context/PanelSessionContext", () => ({
  usePanelSession: () => ({ me: { tenant: { id: "p-1", type: "platform_owner" }, permissions: [] }, group: { current: { userId: "u-1" } }, isLoading: false }),
}));
vi.mock("@/lib/auth-api", () => ({ authApi: { ownedResellers: vi.fn(async () => ({ resellers: [] })) } }));
vi.mock("@/lib/tenant-onboarding-api", () => ({ resellerOnboardingApi: { get: vi.fn(), skip: vi.fn(), unskip: vi.fn() } }));
// The other steps' screens are UX-2-d's (`setup-steps.test.tsx`).
vi.mock("../gateways/_components/GatewaysView", () => ({ GatewaysView: () => <div data-testid="gateways-view" /> }));
vi.mock("../catalog/_components/CatalogView", () => ({ CatalogView: () => <div data-testid="catalog-view" /> }));
vi.mock("./_lib/workspace", async (importOriginal) => ({ ...(await importOriginal<object>()), useWorkspaceSelf: () => false }));
import { resellerOnboardingApi, type OnboardingStepKey, type ResellerOnboarding } from "@/lib/tenant-onboarding-api";

const REQUIRED = ["domain", "gateway", "bot", "pricing"] as const;

const view = (imported: { done?: boolean; skipped?: boolean }, done: OnboardingStepKey[] = []): ResellerOnboarding => {
  const steps = [
    { key: "import" as const, done: !!imported.done || !!imported.skipped, gate: false, optional: true, skipped: !!imported.skipped },
    ...REQUIRED.map((key) => ({ key, done: done.includes(key), gate: key === "domain", optional: false, skipped: false })),
  ];
  return { tenantId: "r-1", onboarding: !done.includes("domain"), closed: [], steps, complete: steps.every((s) => s.optional || s.done) };
};

beforeEach(() => {
  vi.mocked(resellerOnboardingApi.get).mockReset();
  vi.mocked(resellerOnboardingApi.skip).mockReset().mockResolvedValue(undefined);
  vi.mocked(resellerOnboardingApi.unskip).mockReset().mockResolvedValue(undefined);
});

describe("what counts", () => {
  it("is the required steps alone: the optional step moves neither the count nor the total", () => {
    expect(setupProgress(view({}, ["domain", "gateway"]))).toMatchObject({ done: 2, total: 4, complete: false });
    expect(setupProgress(view({ skipped: true }, ["domain", "gateway"]))).toMatchObject({ done: 2, total: 4 });
    expect(setupProgress(view({}, [...REQUIRED]))).toMatchObject({ done: 4, total: 4, complete: true });
  });

  it("links the step to this reseller's migration page", () => {
    expect(stepHref("import", "r-1")).toBe("/my-resellers/r-1/migration");
    expect(stepHref("import", "r-1", true)).toBe("/reseller/migration");
  });
});

describe("the wizard's import step", () => {
  it("opens on it, labelled optional, with the progress bar of the four", async () => {
    vi.mocked(resellerOnboardingApi.get).mockResolvedValue(view({}, ["domain"]));
    render(<SetupWizardView id="r-1" />);
    expect(await screen.findByRole("heading", { name: K.steps.import.title })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(K.wizard.optionalStep.replace(".", "\\.")))).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "4");
    expect(screen.getByRole("link", { name: I.open })).toHaveAttribute("href", "/my-resellers/r-1/migration");
  });

  it("stores a skip and re-reads; a skipped step can be taken back", async () => {
    vi.mocked(resellerOnboardingApi.get).mockResolvedValueOnce(view({})).mockResolvedValue(view({ skipped: true }));
    render(<SetupWizardView id="r-1" />);
    fireEvent.click(await screen.findByRole("button", { name: I.skip }));
    await waitFor(() => expect(resellerOnboardingApi.skip).toHaveBeenCalledWith("r-1", "import"));
    expect(await screen.findByText(I.skipped)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: I.undo }));
    await waitFor(() => expect(resellerOnboardingApi.unskip).toHaveBeenCalledWith("r-1", "import"));
  });

  it("says the users came over when a run did it — nothing to skip or undo", async () => {
    vi.mocked(resellerOnboardingApi.get).mockResolvedValue(view({ done: true }));
    render(<SetupWizardView id="r-1" />);
    expect(await screen.findByText(I.done)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: I.skip })).toBeNull();
    expect(screen.queryByRole("button", { name: I.undo })).toBeNull();
  });
});

describe("the home", () => {
  it("lists it under its own optional heading, outside the count", async () => {
    vi.mocked(resellerOnboardingApi.get).mockResolvedValue(view({ skipped: true }, ["domain"]));
    render(<OnboardingConsoleView id="r-1" />);
    expect(await screen.findByRole("heading", { name: K.optionalSteps })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: K.steps.import.title })).toBeInTheDocument();
    expect(screen.getByText(K.skipped)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "4");
  });
});
