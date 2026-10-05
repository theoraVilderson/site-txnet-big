/**
 * The phone's feedback inside Telegram's Mini App (`contract.ux.md` M6).
 *
 * Only where `window.Telegram.WebApp.HapticFeedback` exists; anywhere else —
 * an ordinary browser, Bale, a server render — every call is nothing. A host
 * that throws (an old client) is nothing too: a tap that does not buzz is not
 * a failure the person should see.
 */
type HapticFeedback = {
  impactOccurred?: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
  notificationOccurred?: (type: "success" | "error" | "warning") => void;
};

function feedback(): HapticFeedback | null {
  if (typeof window === "undefined") return null;
  const tg = (window as unknown as { Telegram?: { WebApp?: { HapticFeedback?: HapticFeedback } } }).Telegram;
  return tg?.WebApp?.HapticFeedback ?? null;
}

function quietly(call: (f: HapticFeedback) => void) {
  const f = feedback();
  if (!f) return;
  try {
    call(f);
  } catch {
    // See the file comment: never surfaced.
  }
}

export const haptic = {
  /** A primary button pressed. */
  tap: () => quietly((f) => f.impactOccurred?.("light")),
  /** With a celebration (M5). */
  success: () => quietly((f) => f.notificationOccurred?.("success")),
  /** With `notify.error`. */
  error: () => quietly((f) => f.notificationOccurred?.("error")),
};
