"use client";

import { create } from "zustand";
import { authApi } from "@/lib/auth-api";
import type { MotionPreference } from "@/lib/motion";

/**
 * A person's display preferences (UX-1-l, `contract.ux.md` P2/P4), the shape
 * `GET /api/auth/me/ui-preferences` answers (auth-api
 * `contract.ui-preferences.md`). Every key is always present.
 */
export type UiPreferences = {
  "ui.motion": MotionPreference;
  "ui.dashboard": { order: string[]; hidden: string[] };
  "ui.pins": string[];
  "ui.sidebar": { collapsed: boolean; closedSections: string[] };
};
export type UiPreferencesPatch = Partial<UiPreferences>;

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  "ui.motion": "system",
  "ui.dashboard": { order: [], hidden: [] },
  "ui.pins": [],
  "ui.sidebar": { collapsed: false, closedSections: [] },
};

/** P4: a change is written this long after the last one. */
export const UI_PREFERENCES_DEBOUNCE_MS = 600;

type Key = keyof UiPreferences;

interface UiPreferencesState {
  /** What the panel applies: the saved values with every unsaved change over them. */
  prefs: UiPreferences;
  /** The user they were loaded for; `null` before the first load. */
  userId: string | null;
  /** The last values the server answered — what a refused write rolls back to. */
  confirmed: UiPreferences;
  /** Changed, not yet sent. */
  pending: UiPreferencesPatch;
  /** Sent, not yet answered. */
  inflight: UiPreferencesPatch;

  /** Once per user, after `/auth/me`; a second call for the same user is nothing. */
  load: (userId: string) => Promise<void>;
  /** Applies at once; written 600ms after the last change. */
  update: (patch: UiPreferencesPatch) => void;
  /** Back to the defaults, nothing pending — a spec's clean slate. */
  reset: () => void;
}

let timer: ReturnType<typeof setTimeout> | null = null;
const failureListeners = new Set<() => void>();

/**
 * Called when a write is refused, after its keys were rolled back. The panel
 * says so with `notify.error` (`PanelPreferences`); the store itself draws
 * nothing, so it stays usable from code that has no toaster.
 */
export function onUiPreferencesWriteFailed(listener: () => void): () => void {
  failureListeners.add(listener);
  return () => failureListeners.delete(listener);
}

const without = (patch: UiPreferencesPatch, keys: readonly string[]): UiPreferencesPatch =>
  Object.fromEntries(Object.entries(patch).filter(([k]) => !keys.includes(k))) as UiPreferencesPatch;

/**
 * The panel's preferences store (UX-1-l): loaded once after `/auth/me`,
 * optimistic, written with a 600ms debounce. A refused write rolls back only
 * the keys it carried, and only where no newer change has been made since.
 * Unsent and unanswered changes survive a load that lands after them.
 */
export const useUiPreferences = create<UiPreferencesState>((set, get) => {
  const flush = async () => {
    timer = null;
    const { pending, userId } = get();
    const keys = Object.keys(pending);
    if (keys.length === 0) return;
    set({ pending: {}, inflight: { ...get().inflight, ...pending } });
    try {
      const answer = await authApi.saveUiPreferences(pending);
      if (get().userId !== userId) return;
      const inflight = without(get().inflight, keys);
      set({ confirmed: answer, inflight, prefs: { ...answer, ...inflight, ...get().pending } });
    } catch {
      if (get().userId !== userId) return;
      const { confirmed, pending: newer, prefs } = get();
      const inflight = without(get().inflight, keys);
      const restored = Object.fromEntries(
        keys.filter((k) => !(k in newer) && !(k in inflight)).map((k) => [k, confirmed[k as Key]]),
      );
      set({ inflight, prefs: { ...prefs, ...restored } });
      failureListeners.forEach((listener) => listener());
    }
  };

  return {
    prefs: DEFAULT_UI_PREFERENCES,
    userId: null,
    confirmed: DEFAULT_UI_PREFERENCES,
    pending: {},
    inflight: {},

    load: async (userId) => {
      if (get().userId === userId) return;
      // Another account's unsent changes are not this one's to write.
      if (get().userId !== null) {
        if (timer) clearTimeout(timer);
        timer = null;
        set({ prefs: DEFAULT_UI_PREFERENCES, confirmed: DEFAULT_UI_PREFERENCES, pending: {}, inflight: {} });
      }
      set({ userId });
      try {
        const saved = await authApi.uiPreferences();
        if (get().userId !== userId) return;
        const { inflight, pending } = get();
        set({ confirmed: saved, prefs: { ...saved, ...inflight, ...pending } });
      } catch {
        // The defaults stand; a later change is still written.
      }
    },

    update: (patch) => {
      set((s) => ({ prefs: { ...s.prefs, ...patch }, pending: { ...s.pending, ...patch } }));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), UI_PREFERENCES_DEBOUNCE_MS);
    },

    reset: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      set({ prefs: DEFAULT_UI_PREFERENCES, userId: null, confirmed: DEFAULT_UI_PREFERENCES, pending: {}, inflight: {} });
    },
  };
});

/** The sidebar's collapse (N3) is `ui.sidebar.collapsed`, written with the folds it already holds. */
export function toggleSidebarCollapsed(): void {
  const { prefs, update } = useUiPreferences.getState();
  const sidebar = prefs["ui.sidebar"];
  update({ "ui.sidebar": { ...sidebar, collapsed: !sidebar.collapsed } });
}
