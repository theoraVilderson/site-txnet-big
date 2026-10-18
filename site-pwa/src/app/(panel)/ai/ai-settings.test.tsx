import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { aiAdminApi, type AiSettings, type AiTypeActivity } from "@/lib/ai-api";
import { ConfirmProvider } from "../_components/kit/confirm";
import { AiSettingsPanel } from "./_components/AiSettingsPanel";

/**
 * F-038-j4: AI settings any admin can set without knowing what 0.6 means.
 *
 * The failures worth a spec: a level that silences a type, chosen with nothing
 * said (win_back's 0.55 under the balanced 0.60 — the case found on dev); a
 * discount type shown as ready with no offer to give; a save that sends what
 * was not changed, or a threshold or holdout share the server refuses; an
 * engine "on" that does not run, shown as running.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: () => ({ t, lang: "en" }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/useMotionLevel", () => ({ useMotionLevel: () => "reduced" }));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => () => "generic" }));
vi.mock("../_components/kit/notify", () => ({ notify: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/ai-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-api")>()),
  aiAdminApi: { settings: vi.fn(), saveSettings: vi.fn(), settingsActivity: vi.fn() },
}));

const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);

const settings: AiSettings = {
  engineEnabled: true,
  engineRuns: true,
  confidenceThreshold: "0.60",
  holdoutPercent: 10,
  disabledActionTypes: [],
  actionTypes: ["renew", "win_back", "retain_offer", "trial_convert"],
};
const activity = (type: AiTypeActivity["type"], over: Partial<AiTypeActivity> = {}): AiTypeActivity => ({
  type, sent: 0, queued: 0, heldByThreshold: 0, heldOtherwise: 0, confidence: null, waitsOn: null, ...over,
});
const types: AiTypeActivity[] = [
  activity("renew", { sent: 12, confidence: { min: "0.6", max: "0.7" } }),
  activity("win_back", { heldByThreshold: 4, confidence: { min: "0.55", max: "0.55" } }),
  activity("retain_offer", { waitsOn: "active_offer" }),
  activity("trial_convert", { waitsOn: "not_available" }),
];

const onOpenOffers = vi.fn();
const view = () => render(<ConfirmProvider><AiSettingsPanel onOpenOffers={onOpenOffers} /></ConfirmProvider>);
const row = (type: string) => screen.getByTestId(`ai-type-${type}`);
const save = () => fireEvent.click(screen.getByRole("button", { name: "kit.saveBar.save" }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(aiAdminApi.settings).mockResolvedValue({ settings });
  vi.mocked(aiAdminApi.settingsActivity).mockResolvedValue({ windowDays: 30, types });
  vi.mocked(aiAdminApi.saveSettings).mockImplementation(async (p) => ({ settings: { ...settings, ...p } }));
});

describe("AI settings in plain words (F-038-j4)", () => {
  it("says what went out in the window, and each type's state from its activity", async () => {
    view();
    expect(await screen.findByText("ai.settings.summarySent:30,12")).toBeTruthy();
    expect(within(row("renew")).getByText("ai.settings.state.sent:12")).toBeTruthy();
    expect(within(row("win_back")).getByText("ai.settings.state.silenced")).toBeTruthy();
    expect(within(row("trial_convert")).getByText("ai.settings.state.notAvailable")).toBeTruthy();
    expect(within(row("renew")).getByText("ai.typeHelp.renew")).toBeTruthy();
  });

  it("a discount type with no offer says so and opens the offers tab", async () => {
    view();
    await screen.findByTestId("ai-type-retain_offer");
    expect(within(row("retain_offer")).getByText("ai.settings.state.needsOffer")).toBeTruthy();
    fireEvent.click(within(row("retain_offer")).getByRole("button", { name: "ai.settings.makeOffer" }));
    expect(onOpenOffers).toHaveBeenCalled();
  });

  it("names the types a level silences before it is saved, and saves the level's threshold", async () => {
    view();
    expect(await screen.findByText("ai.settings.silenced:ai.types.win_back")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /ai.settings.levels.more/ }));
    expect(screen.getByText("ai.settings.silencedNone")).toBeTruthy();
    expect(within(row("win_back")).queryByText("ai.settings.state.silenced")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /ai.settings.levels.careful/ }));
    expect(screen.getByText("ai.settings.silenced:ai.types.win_back")).toBeTruthy();
    // renew was seen at 0.6 and 0.7: the careful level holds some, not all.
    expect(within(row("renew")).getByText("ai.settings.state.partly")).toBeTruthy();
    save();
    await waitFor(() => expect(aiAdminApi.saveSettings).toHaveBeenCalledWith({ confidenceThreshold: "0.70" }));
  });

  it("a threshold that is no level is said as custom, never shown as one", async () => {
    vi.mocked(aiAdminApi.settings).mockResolvedValue({ settings: { ...settings, confidenceThreshold: "0.65" } });
    view();
    expect(await screen.findByText("ai.settings.levelCustom:0.65")).toBeTruthy();
    for (const r of screen.getAllByRole("radio")) expect(r.getAttribute("aria-checked")).toBe("false");
  });

  it("sends only what changed: switching one type off", async () => {
    view();
    fireEvent.click(within(await screen.findByTestId("ai-type-renew")).getByRole("switch"));
    save();
    await waitFor(() => expect(aiAdminApi.saveSettings).toHaveBeenCalledWith({ disabledActionTypes: ["renew"] }));
  });

  it("never sends a threshold or holdout share the server refuses; the holdout said as one in a hundred", async () => {
    view();
    const threshold = await screen.findByLabelText("ai.settings.threshold");
    fireEvent.change(threshold, { target: { value: "1.5" } });
    expect(screen.getByRole("button", { name: "kit.saveBar.save" })).toHaveProperty("disabled", true);
    fireEvent.change(threshold, { target: { value: "0.7" } });
    fireEvent.change(screen.getByLabelText("ai.settings.holdout"), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: "kit.saveBar.save" })).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("ai.settings.holdout"), { target: { value: "15" } });
    expect(screen.getByText("ai.settings.holdoutExample:15")).toBeTruthy();
    save();
    await waitFor(() => expect(aiAdminApi.saveSettings).toHaveBeenCalledWith({ confidenceThreshold: "0.7", holdoutPercent: 15 }));
  });

  it("says so when the switch is on but the engine does not run", async () => {
    vi.mocked(aiAdminApi.settings).mockResolvedValue({ settings: { ...settings, engineRuns: false } });
    view();
    expect(await screen.findByText("ai.settings.notRunning")).toBeTruthy();
  });

  it("the page still sets everything when the activity cannot be read", async () => {
    vi.mocked(aiAdminApi.settingsActivity).mockRejectedValue(new Error("down"));
    view();
    fireEvent.click(within(await screen.findByTestId("ai-type-renew")).getByRole("switch"));
    // "off" is known without activity; anything about what a type did is not claimed.
    expect(within(row("renew")).getByText("ai.settings.state.off")).toBeTruthy();
    expect(within(row("win_back")).queryByText(/ai.settings.state/)).toBeNull();
    expect(screen.queryByText(/ai.settings.summary/)).toBeNull();
    save();
    await waitFor(() => expect(aiAdminApi.saveSettings).toHaveBeenCalledWith({ disabledActionTypes: ["renew"] }));
  });
});
