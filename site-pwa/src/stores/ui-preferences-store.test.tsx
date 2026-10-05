import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authApi } from "@/lib/auth-api";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import {
  DEFAULT_UI_PREFERENCES,
  UI_PREFERENCES_DEBOUNCE_MS,
  onUiPreferencesWriteFailed,
  toggleSidebarCollapsed,
  useUiPreferences,
  type UiPreferences,
} from "./ui-preferences-store";

/**
 * The panel's display preferences (UX-1-l, `contract.ux.md` P4, M2):
 *
 * - loaded once per signed-in user, after `/auth/me`;
 * - a change applies at once and is written 600ms after the last one, several
 *   changes in that window as one PATCH;
 * - a refused write rolls back what it carried — never a newer change — and
 *   says so through the failure listener (the panel's `notify.error`);
 * - `ui.motion` decides the motion level before the OS does;
 * - the sidebar's collapse is `ui.sidebar.collapsed`, written with the folds
 *   it already had.
 */

vi.mock("@/lib/auth-api", () => ({
  authApi: { uiPreferences: vi.fn(), saveUiPreferences: vi.fn() },
}));

const SAVED: UiPreferences = {
  ...DEFAULT_UI_PREFERENCES,
  "ui.motion": "full",
  "ui.sidebar": { collapsed: false, closedSections: ["sales"] },
};

const store = () => useUiPreferences.getState();
const flush = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(UI_PREFERENCES_DEBOUNCE_MS);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  store().reset();
  vi.mocked(authApi.uiPreferences).mockResolvedValue(SAVED);
  vi.mocked(authApi.saveUiPreferences).mockImplementation(async (patch) => ({ ...SAVED, ...patch }) as UiPreferences);
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as never;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("loading", () => {
  it("holds the defaults until loaded, then the saved values — asked once per user", async () => {
    expect(store().prefs).toEqual(DEFAULT_UI_PREFERENCES);
    await act(() => store().load("u-1"));
    await act(() => store().load("u-1"));

    expect(store().prefs).toEqual(SAVED);
    expect(authApi.uiPreferences).toHaveBeenCalledTimes(1);

    await act(() => store().load("u-2"));
    expect(authApi.uiPreferences).toHaveBeenCalledTimes(2);
  });

  it("keeps a change made while the load was on its way", async () => {
    let answer: (p: UiPreferences) => void = () => {};
    vi.mocked(authApi.uiPreferences).mockReturnValue(new Promise((r) => (answer = r)));
    const loading = store().load("u-1");
    store().update({ "ui.motion": "reduced" });
    answer(SAVED);
    await act(() => loading);

    expect(store().prefs["ui.motion"]).toBe("reduced");
    expect(store().prefs["ui.sidebar"]).toEqual(SAVED["ui.sidebar"]);
  });
});

describe("writing", () => {
  it("applies at once and writes 600ms after the last change, as one PATCH", async () => {
    await act(() => store().load("u-1"));
    store().update({ "ui.motion": "reduced" });
    expect(store().prefs["ui.motion"]).toBe("reduced");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UI_PREFERENCES_DEBOUNCE_MS - 100);
    });
    store().update({ "ui.pins": ["/wallet"] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UI_PREFERENCES_DEBOUNCE_MS - 100);
    });
    expect(authApi.saveUiPreferences).not.toHaveBeenCalled();

    await flush();
    expect(authApi.saveUiPreferences).toHaveBeenCalledTimes(1);
    expect(authApi.saveUiPreferences).toHaveBeenCalledWith({ "ui.motion": "reduced", "ui.pins": ["/wallet"] });
  });

  it("rolls a refused write back to the saved value, says so, and keeps a newer change", async () => {
    const failed = vi.fn();
    const off = onUiPreferencesWriteFailed(failed);
    await act(() => store().load("u-1"));
    let refuse: (e: Error) => void = () => {};
    vi.mocked(authApi.saveUiPreferences).mockReturnValueOnce(new Promise((_, r) => (refuse = r)));

    store().update({ "ui.motion": "reduced", "ui.pins": ["/a"] });
    await flush();
    store().update({ "ui.pins": ["/b"] });
    await act(async () => refuse(new Error("429")));

    expect(store().prefs["ui.motion"]).toBe("full");
    expect(store().prefs["ui.pins"]).toEqual(["/b"]);
    expect(failed).toHaveBeenCalledTimes(1);
    off();
  });
});

describe("what the preferences drive", () => {
  it("lets ui.motion decide the motion level before the OS does", async () => {
    const { result } = renderHook(() => useMotionLevel());
    expect(result.current).toBe("full");

    act(() => store().update({ "ui.motion": "reduced" }));
    expect(result.current).toBe("reduced");

    window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as never;
    act(() => store().update({ "ui.motion": "full" }));
    expect(result.current).toBe("full");
    act(() => store().update({ "ui.motion": "system" }));
    expect(result.current).toBe("reduced");
  });

  it("collapses the sidebar through ui.sidebar, keeping the folds it had", async () => {
    await act(() => store().load("u-1"));
    act(() => toggleSidebarCollapsed());
    expect(store().prefs["ui.sidebar"]).toEqual({ collapsed: true, closedSections: ["sales"] });

    await flush();
    expect(authApi.saveUiPreferences).toHaveBeenCalledWith({ "ui.sidebar": { collapsed: true, closedSections: ["sales"] } });
  });
});
