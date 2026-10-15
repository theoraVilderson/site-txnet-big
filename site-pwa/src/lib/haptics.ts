/**
 * The phone's feedback inside Telegram's Mini App (`contract.ux.md` M6).
 *
 * Only where `window.Telegram.WebApp.HapticFeedback` exists; anywhere else —
 * an ordinary browser, Bale, a server render — every call is nothing, but
 * `copied`'s vibrate where the browser has one. A host
 * that throws (an old client) is nothing too: a tap that does not buzz is not
 * a failure the person should see.
 */
type HapticFeedback = {
  impactOccurred?: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
  notificationOccurred?: (type: "success" | "error" | "warning") => void;
};

/** The buzz on a copy, outside the Mini App (contract.manual-transfer.md "Amount"). */
const COPY_BUZZ_MS = 10;

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
  /**
   * A value copied (F-803-i): Telegram's light impact, or a 10 ms buzz where
   * the browser has `navigator.vibrate` — the one call outside the Mini App,
   * because a copy gives no other sign on a phone held at arm's length.
   */
  copied: () => {
    if (feedback()) return quietly((f) => f.impactOccurred?.("light"));
    if (typeof navigator !== "undefined") navigator.vibrate?.(COPY_BUZZ_MS);
  },
  /** With `notify.error`. */
  error: () => quietly((f) => f.notificationOccurred?.("error")),
};
