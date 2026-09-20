"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AnimatePresence,
  motion,
  useAnimationControls,
  useReducedMotion,
  type Variants,
} from "framer-motion";
import { AlertCircle, Loader2, Sparkles, Ticket, Trash2, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ApiError } from "@/lib/api-error";
import { billingApi, type GiftGrant, type GiftRedemption } from "@/lib/billing-api";
import { formatInstant } from "../_lib/datetime";
import { BASE_CURRENCY, formatMoney } from "../_lib/money";

/** The modal's strings as generated constants (C-06). */
const G = FrontendI18nKeys.common.wallet.gift;

interface GiftCodeModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * A code was redeemed. The top bar re-reads its balance on this; it is
   * deliberately **not** handed an amount to add, for the reason in the header
   * comment below. The answer is passed only so a caller can log or show it.
   */
  onRedeemed?: (redemption: GiftRedemption) => void;
}

/**
 * The gift-code box (F-093-g), ported from legacy's `DiscountModal.tsx` with
 * its one bug left behind.
 *
 * Legacy branched on `data.status === "nok"`, set an error — and then ran the
 * success path anyway, because the branch had no `return`. Every answer,
 * refusal included, did `walletBalance + data.amount` into a client store, and
 * on a refusal `amount` is undefined: a dead code showed "gift activated" over
 * a balance of `NaN`. Two rules replace it, and both are older than this file:
 *
 * 1. **A refusal ends the submit.** Failure is an `ApiError` thrown by the
 *    client, so there is no success path to fall into — the sentence billing
 *    already translated goes on screen and nothing else happens
 *    (`contract.errors.md`). Each of the five refusals names where the code
 *    does belong, so this keeps no copy of any of them and no reason code to
 *    branch on.
 * 2. **This does not touch the balance.** It reports that a redemption
 *    happened; `useWalletBalance` re-reads the figure from billing, which is
 *    the only thing that can be right (`contract.shell.md` rule 1). The
 *    `credited` and `balance` shown here are billing's own answer to *this*
 *    call, formatted, never a sum worked out on this side. **No figure on this
 *    screen is ever animated from one value to another** — a number counting
 *    up is a number that is briefly wrong, which is the habit this whole file
 *    exists to break.
 *
 * Legacy also dismissed itself on a timer, and the timer read a `status` from a
 * stale closure to decide whether to. The success panel here stays until it is
 * closed: the user has just been told a number they may want to read twice.
 *
 * **Why it is this animated.** Redeeming a gift is the one moment in the panel
 * that is pure good news, and the rest of the app is deliberately flat. The
 * motion is all on the frame — the card, the check, the burst — and none of it
 * is on the money. Every bit of it collapses to a plain cross-fade under
 * `prefers-reduced-motion`: in the CSS itself where the animation is CSS, and
 * through `useReducedMotion` where it is not.
 *
 * **Why half of it is CSS.** framer-motion is here for the three things CSS
 * cannot do — an exit animation, an `auto` height, an imperative shake. The
 * one-shot entrances and the orbs' infinite pulse are `.gift-rise`,
 * `.gift-pop` and `.gift-orb` in `globals.css` instead, because this input is
 * controlled: every keystroke re-renders this dialog, and each motion component
 * in the tree pays for it. Six of them took the spec that types eight
 * characters from 2.0s to 4.2s, against vitest's 5s ceiling. A new animation
 * here starts in CSS and moves only if it needs one of those three.
 */
export function GiftCodeModal({ open, onClose, onRedeemed }: GiftCodeModalProps) {
  // Rendered into `document.body`, not where it is written.
  //
  // Its caller is `WalletButton`, inside a top bar carrying `backdrop-blur-xl`
  // — and an element with a `backdrop-filter` becomes the **containing block
  // for every fixed-position descendant**. So `fixed inset-0` here did not mean
  // the viewport; it meant that 64px rounded bar, which is why the modal came
  // up invisible, looking for all the world like an `overflow: hidden` on the
  // nav. The bar's `z-20` boxes the stacking order the same way, so `z-50`
  // could never clear the sidebar's `z-40` either. A portal is the fix for both
  // at once, and it is the reason this component may be mounted anywhere.
  //
  // `AnimatePresence` stays mounted so the dialog can animate *out*; the dialog
  // itself does not, which is what makes **mounting the reset** — a closed
  // modal holds no half-typed code and no previous attempt's error, without an
  // effect that has to remember to clear each one.
  if (typeof document === "undefined") return null; // server render: no portal target

  return createPortal(
    <AnimatePresence>
      {open && <GiftCodeDialog onClose={onClose} onRedeemed={onRedeemed} />}
    </AnimatePresence>,
    document.body,
  );
}

/** Eight sparks, evenly spaced, so the burst is the same every time. */
const SPARKS = Array.from({ length: 8 }, (_, i) => (i * 360) / 8);

function GiftCodeDialog({ onClose, onRedeemed }: Omit<GiftCodeModalProps, "open">) {
  const { t, lang } = useLocale();
  const toMessage = useApiErrorMessage();
  const reduce = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const shake = useAnimationControls();

  const [code, setCode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; ref?: string } | null>(null);
  const [redeemed, setRedeemed] = useState<GiftRedemption | null>(null);

  // The code box is what the user came here to fill in.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // The subscription key exists in the clear exactly once (F-502-m, D-35):
  // billing stores only its hash, so a dismissal the user did not mean is a key
  // they never copied. `Escape` — muscle memory — and the backdrop — the miss
  // around the card — are the two ways to close a dialog *without deciding to*,
  // and while the key is up neither closes it.
  //
  // Since F-502-p they no longer do *nothing* either: they ask (F-502-q). The
  // question is worth asking now because it has a real second answer — the key
  // can be reissued from this screen, so "go back and get a new one" is an
  // actual way out rather than a door that had to stay shut. The X and "done"
  // are aimed at, and still close on the first press.
  const keyOnScreen = redeemed?.kind === "free_grant";
  const [askedToClose, setAskedToClose] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (keyOnScreen) setAskedToClose(true);
      else onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, keyOnScreen]);

  // The page behind a modal should not scroll under it.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const trimmed = code.trim();
  const canSubmit = trimmed.length > 0 && !isSubmitting && redeemed === null;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;

    // Cleared per attempt: the previous refusal is no longer the answer
    // (`contract.errors.md`).
    setError(null);
    setIsSubmitting(true);
    try {
      const redemption = await billingApi.redeemGift(trimmed);
      setRedeemed(redemption);
      onRedeemed?.(redemption);
    } catch (e) {
      // The only exit from a failure. There is no `setRedeemed` below it, which
      // is the whole difference from the file this was ported from.
      console.error(e);
      setError({
        message: toMessage(e),
        ref: e instanceof ApiError ? e.ref : undefined,
      });
      // A refusal is felt before it is read. The code stays in the box, so the
      // shake points at the thing the user is about to correct.
      if (!reduce) {
        void shake.start({
          x: [0, -10, 9, -7, 5, 0],
          transition: { duration: 0.45, ease: "easeInOut" },
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  const money = (amount: string) => formatMoney(amount, BASE_CURRENCY, { lang, t });

  /** Under reduced motion every entrance below becomes this and nothing more. */
  const fade: Variants = {
    hidden: { opacity: 0 },
    shown: { opacity: 1, transition: { duration: 0.15 } },
    gone: { opacity: 0, transition: { duration: 0.12 } },
  };

  const card: Variants = reduce
    ? fade
    : {
        hidden: { opacity: 0, scale: 0.92, y: 28 },
        shown: {
          opacity: 1,
          scale: 1,
          y: 0,
          transition: { type: "spring", stiffness: 280, damping: 26, mass: 0.9 },
        },
        gone: { opacity: 0, scale: 0.95, y: 16, transition: { duration: 0.16 } },
      };

  return (
    // Above the sidebar's `z-40` and its `z-30` backdrop (`contract.gift-code.md`
    // rule 8, `contract.shell.md` "State"): a modal the drawer could cover is a
    // modal the user cannot use.
    // `overflow-y-auto` + `min-h-full` is what keeps the card off the top edge.
    // A centred card in a frame that cannot scroll is clipped at **both** ends
    // once it outgrows the viewport, and the half that goes is the half with
    // the title in it — which is what an error message did, since it grows the
    // card by the height of a sentence. Here the frame scrolls instead, and the
    // padding below survives on a short screen.
    <div className="fixed inset-0 z-50 overflow-y-auto overscroll-contain">
      <motion.div
        variants={fade}
        initial="hidden"
        animate="shown"
        exit="gone"
        className="fixed inset-0 bg-black/55 backdrop-blur-lg"
        onClick={keyOnScreen ? () => setAskedToClose(true) : onClose}
        data-testid="gift-backdrop"
        aria-hidden
      />

      <div className="relative flex min-h-full items-center justify-center p-4 sm:p-6">
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={t("common", G.title)}
          variants={card}
          initial="hidden"
          animate="shown"
          exit="gone"
          className="relative w-full max-w-md overflow-hidden rounded-3xl border border-card-border bg-card-bg shadow-2xl backdrop-blur-xl"
        >
          {/* The two orbs legacy lit its modal with — the one thing about it
              worth keeping. Purely decorative, so they are inert and hidden, and
              the pulse is the `.gift-orb` CSS animation rather than a
              framer-motion loop (see `globals.css` for why). */}
          <span
            aria-hidden
            className="gift-orb pointer-events-none absolute -top-24 -end-24 size-52 rounded-full bg-primary/25 blur-[80px]"
          />
          <span
            aria-hidden
            className="gift-orb pointer-events-none absolute -bottom-24 -start-24 size-52 rounded-full bg-gold/20 blur-[80px] [animation-delay:-2.4s]"
          />

          <motion.div animate={shake} className="relative p-6 sm:p-8">
            <div className="mb-7 flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <span className="gift-pop flex size-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/70 text-white shadow-lg shadow-primary-glow [animation-delay:90ms]">
                  <Ticket size={24} aria-hidden />
                </span>
                <div className="min-w-0">
                  <h2 className="gift-rise text-lg font-bold text-text-primary [animation-delay:80ms]">
                    {t("common", G.title)}
                  </h2>
                  <p className="gift-rise mt-0.5 text-xs text-text-secondary [animation-delay:140ms]">
                    {t("common", G.subtitle)}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={t("common", G.close)}
                className="rounded-xl p-2 text-text-secondary transition-[background-color,color,rotate,scale] duration-300 hover:bg-leaf-bg hover:text-text-primary hover:rotate-90 active:scale-90 motion-reduce:hover:rotate-0 motion-reduce:active:scale-100"
              >
                <X size={20} aria-hidden />
              </button>
            </div>

            {redeemed?.kind === "free_grant" ? (
              <ServiceGranted
                redemption={redeemed}
                onClose={onClose}
                asked={askedToClose}
                onAnswered={() => setAskedToClose(false)}
              />
            ) : redeemed ? (
              <Success
                reduce={!!reduce}
                credited={money(redeemed.credited)}
                balance={money(redeemed.balance)}
                onClose={onClose}
                t={t}
              />
            ) : (
              <form onSubmit={onSubmit} className="space-y-4">
                <div className="gift-rise [animation-delay:200ms]">
                  <label
                    htmlFor="gift-code"
                    className="mb-2 block text-[10px] font-black uppercase tracking-widest text-text-secondary opacity-80"
                  >
                    {t("common", G.inputLabel)}
                  </label>
                  <div className="group relative flex items-center">
                    <input
                      id="gift-code"
                      ref={inputRef}
                      type="text"
                      dir="ltr"
                      maxLength={64}
                      autoComplete="off"
                      spellCheck={false}
                      value={code}
                      onChange={(e) => setCode(e.target.value.toUpperCase())}
                      disabled={isSubmitting}
                      placeholder={t("common", G.placeholder)}
                      className={`w-full rounded-2xl border-2 bg-bg-inner px-12 py-5 text-center font-mono text-xl font-black tracking-[0.15em] outline-none transition-all duration-300 placeholder:font-sans placeholder:font-normal placeholder:tracking-normal placeholder:text-text-secondary/30 disabled:opacity-60 ${
                        error
                          ? "border-error text-error"
                          : "border-card-border text-text-primary focus:border-primary focus:shadow-[0_0_30px_var(--color-primary-glow)]"
                      }`}
                    />

                    <AnimatePresence>
                      {code && !isSubmitting && (
                        <motion.button
                          type="button"
                          initial={{ opacity: 0, scale: 0.6 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.6 }}
                          transition={{ duration: 0.15 }}
                          onClick={() => {
                            setCode("");
                            setError(null);
                            inputRef.current?.focus();
                          }}
                          aria-label={t("common", G.clear)}
                          className="absolute start-3 rounded-lg p-2 text-text-secondary/50 transition-colors hover:text-error"
                        >
                          <Trash2 size={16} aria-hidden />
                        </motion.button>
                      )}
                    </AnimatePresence>

                  </div>
                </div>

                {/* The sentence is billing's, already translated — this only lays
                    it out. `role="alert"` because it lands after a submit the
                    user is waiting on (`contract.errors.md`). */}
                <AnimatePresence>
                  {error && (
                    <motion.div
                      role="alert"
                      aria-live="assertive"
                      initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0, y: -6 }}
                      animate={{ opacity: 1, height: "auto", y: 0 }}
                      exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0, y: -6 }}
                      transition={{ duration: 0.22, ease: "easeOut" }}
                      className="overflow-hidden"
                    >
                      <div className="flex items-start gap-3 rounded-2xl border border-error-border bg-error-bg px-4 py-3 text-sm font-medium text-error">
                        <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden />
                        <span className="min-w-0">
                          {error.message}
                          {error.ref && (
                            <span
                              className="mt-1 block font-mono text-[0.65rem] opacity-70"
                              dir="ltr"
                            >
                              {error.ref}
                            </span>
                          )}
                        </span>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* The label swaps without `AnimatePresence` on purpose: the
                    accessible name of a submit button has to be one word at a
                    time, and a cross-fade briefly makes it both. */}
                <button
                  type="submit"
                  disabled={!canSubmit}
                  className="gift-rise group/btn relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-2xl bg-gradient-to-r from-primary to-primary/70 py-4 text-sm font-black text-white shadow-lg shadow-primary-glow transition-[filter,opacity,scale] duration-200 [animation-delay:260ms] hover:brightness-110 enabled:hover:scale-[1.02] enabled:active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none motion-reduce:enabled:hover:scale-100 motion-reduce:enabled:active:scale-100"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 size={18} className="animate-spin" aria-hidden />
                      {t("common", G.submitting)}
                    </>
                  ) : (
                    t("common", G.submit)
                  )}
                  {/* A light sweep across the face on hover. Decorative. */}
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-1000 group-hover/btn:translate-x-full motion-reduce:hidden"
                  />
                </button>
              </form>
            )}
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}

/**
 * A free-service code (F-502-l-c, D-35): a Grant instead of money. Billing keeps
 * only the subscription key's hash, so the key on screen is the one time it
 * exists in the clear — shown with a copy button and a sentence that says so,
 * and nothing here is a money figure. The frame stays flat: no burst, so
 * nothing moves while the user is reading a key.
 *
 * **Asking for a new one (F-502-q).** A copy does not always land — the
 * clipboard write throws on an insecure origin, a selection is half a key, a
 * paste goes to the wrong window — and until F-502-p that was final. The
 * button spends one of five attempts per 15 minutes on a key billing mints in a
 * transaction that kills the old one, and what comes back obeys the same rule
 * as the first: shown this once. A refusal is billing's own sentence and
 * changes nothing (`contract.errors.md`); the key already on screen is still
 * the key, because nothing was minted.
 *
 * The close question is the other half of the same row: `Escape` and the
 * backdrop ask here instead of doing nothing, and "go back" is what makes the
 * button above reachable rather than a dead end.
 */
function ServiceGranted({
  redemption,
  onClose,
  asked,
  onAnswered,
}: {
  redemption: GiftGrant;
  onClose: () => void;
  /** `Escape` or the backdrop was hit while the key is up — answer it here. */
  asked: boolean;
  onAnswered: () => void;
}) {
  const { t, lang } = useLocale();
  const [copied, setCopied] = useState(false);
  // The key billing last answered: the redemption's, until a reissue replaces
  // it. The old one is dead in billing by then, so it must not stay on screen
  // to be copied.
  const [subscriptionKey, setSubscriptionKey] = useState(redemption.subscriptionKey);
  const [reissued, setReissued] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [error, setError] = useState<{ message: string; ref?: string } | null>(null);
  const toMessage = useApiErrorMessage();
  const until = redemption.grant.endsAt ? formatInstant(redemption.grant.endsAt, lang) : null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(subscriptionKey);
      setCopied(true);
    } catch {
      // No clipboard (an old browser, an insecure origin): the key stays
      // selectable, and the button above is the way out if it was not copied.
    }
  };

  async function askForANewKey() {
    if (isRotating) return;
    setError(null);
    setIsRotating(true);
    try {
      const { subscriptionKey: minted } = await billingApi.rotateGrantToken(redemption.grant.id);
      setSubscriptionKey(minted);
      setReissued(true);
      setCopied(false);
    } catch (e) {
      // Nothing was minted, so the key on screen is untouched — only the
      // sentence billing sent is added.
      console.error(e);
      setError({ message: toMessage(e), ref: e instanceof ApiError ? e.ref : undefined });
    } finally {
      setIsRotating(false);
    }
  }

  return (
    <div className="py-2 text-center">
      <div className="mx-auto mb-5 flex size-20 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/70 text-white shadow-xl shadow-primary-glow">
        <Sparkles size={32} aria-hidden />
      </div>
      <p className="text-lg font-black text-text-primary">{t("common", G.serviceTitle)}</p>
      <p className="mt-1.5 text-sm text-text-secondary">
        {until ? t("common", G.serviceUntil, { until }) : t("common", G.servicePermanent)}
      </p>

      <div className="mt-5 rounded-2xl border border-card-border bg-bg-inner p-3 text-start">
        <p className="mb-1.5 text-[10px] font-black uppercase tracking-widest text-text-secondary">{t("common", G.keyLabel)}</p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 select-all break-all font-mono text-xs text-text-primary" dir="ltr">
            {subscriptionKey}
          </code>
          <button
            type="button"
            onClick={() => void copy()}
            className="shrink-0 rounded-xl bg-primary px-3 py-2 text-xs font-bold text-white"
          >
            {t("common", copied ? G.copied : G.copy)}
          </button>
        </div>
        <p className="mt-2 text-[11px] font-bold text-error">{t("common", G.keyOnce)}</p>
        {reissued && (
          <p className="mt-1 text-[11px] font-bold text-text-secondary">{t("common", G.keyReplaced)}</p>
        )}
      </div>

      {/* Billing's sentence, laid out and nothing more — `role="alert"` because
          it lands after a press the user is waiting on (`contract.errors.md`). */}
      {error && (
        <div
          role="alert"
          aria-live="assertive"
          className="mt-3 flex items-start gap-3 rounded-2xl border border-error-border bg-error-bg px-4 py-3 text-start text-sm font-medium text-error"
        >
          <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden />
          <span className="min-w-0">
            {error.message}
            {error.ref && (
              <span className="mt-1 block font-mono text-[0.65rem] opacity-70" dir="ltr">
                {error.ref}
              </span>
            )}
          </span>
        </div>
      )}

      <button
        type="button"
        onClick={() => void askForANewKey()}
        disabled={isRotating}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl border border-card-border py-3 text-xs font-bold text-text-secondary transition-colors duration-200 hover:bg-leaf-bg hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isRotating && <Loader2 size={14} className="animate-spin" aria-hidden />}
        {t("common", isRotating ? G.newKeySending : G.newKey)}
      </button>

      {asked ? (
        // The question `Escape` and the backdrop now ask. It is answered here
        // rather than in a second dialog: the key it is about is on the screen
        // behind it, and covering that up is the thing to avoid.
        <div className="mt-6 rounded-2xl border border-error-border bg-error-bg p-3 text-start">
          <p className="text-[13px] font-bold text-error">{t("common", G.closeAsk)}</p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={onAnswered}
              autoFocus
              className="flex-1 rounded-xl bg-primary py-2.5 text-xs font-bold text-white"
            >
              {t("common", G.stay)}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-xl bg-leaf-bg py-2.5 text-xs font-bold text-text-primary"
            >
              {t("common", G.closeAnyway)}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={onClose}
          className="mt-3 w-full rounded-2xl bg-leaf-bg py-3.5 text-sm font-bold text-text-primary transition-[background-color] duration-200 hover:bg-card-border"
        >
          {t("common", G.done)}
        </button>
      )}
    </div>
  );
}

/**
 * What a redeemed code looks like: a check that draws itself, a burst, and the
 * two figures billing answered — shown exactly as they arrived, never counted
 * up to. The balance leads, because it is the number the wallet will now show.
 *
 * This panel keeps framer-motion where the form gave it up. The per-keystroke
 * cost behind that rule needs a controlled input to re-render the tree, and
 * there is none here — it mounts once, on an answer. What is left is the two
 * things CSS would do badly: a stroke that draws along its own path, and eight
 * sparks whose end point is computed per angle.
 */
function Success({
  reduce,
  credited,
  balance,
  onClose,
  t,
}: {
  reduce: boolean;
  credited: string;
  balance: string;
  onClose: () => void;
  t: ReturnType<typeof useLocale>["t"];
}) {
  return (
    <motion.div
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={
        reduce ? { duration: 0.15 } : { type: "spring", stiffness: 260, damping: 22 }
      }
      className="py-2 text-center"
    >
      <div className="relative mx-auto mb-5 size-20">
        {!reduce &&
          SPARKS.map((angle) => (
            <motion.span
              key={angle}
              aria-hidden
              // Physical `left`, not logical `start`: the offsets below are a
              // physical `x`/`y`, and mixing the two makes the burst land off
              // centre in RTL. The burst is symmetric, so it reads the same in
              // either script.
              className="absolute left-1/2 top-1/2 size-1.5 rounded-full bg-gold"
              initial={{ opacity: 0, x: "-50%", y: "-50%", scale: 0 }}
              animate={{
                opacity: [0, 1, 0],
                scale: [0, 1, 0.4],
                x: `calc(-50% + ${Math.cos((angle * Math.PI) / 180) * 46}px)`,
                y: `calc(-50% + ${Math.sin((angle * Math.PI) / 180) * 46}px)`,
              }}
              transition={{ duration: 0.75, delay: 0.22, ease: "easeOut" }}
            />
          ))}

        <motion.div
          initial={reduce ? false : { scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 16, delay: 0.05 }}
          className="absolute inset-0 flex items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/70 text-white shadow-xl shadow-primary-glow"
        >
          <svg viewBox="0 0 32 32" className="size-10" fill="none" aria-hidden>
            <motion.path
              d="M8 16.5 13.5 22 24 11"
              stroke="currentColor"
              strokeWidth={3.2}
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={reduce ? false : { pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.4, delay: 0.22, ease: "easeOut" }}
            />
          </svg>
        </motion.div>
      </div>

      <p className="text-lg font-black text-text-primary">{t("common", G.successTitle)}</p>
      <p className="mt-1.5 text-sm text-text-secondary">
        {t("common", G.credited, { amount: credited })}
      </p>

      <motion.div
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: reduce ? 0 : 0.3, duration: 0.3 }}
        className="mt-5 flex items-center justify-center gap-2 rounded-2xl border border-card-border bg-gold-bg px-4 py-3 font-mono text-sm font-black text-gold"
      >
        <Sparkles size={16} aria-hidden />
        <span>{t("common", G.newBalance, { balance })}</span>
      </motion.div>

      <button
        type="button"
        onClick={onClose}
        className="mt-6 w-full rounded-2xl bg-leaf-bg py-3.5 text-sm font-bold text-text-primary transition-[background-color,scale] duration-200 hover:bg-card-border hover:scale-[1.02] active:scale-[0.97] motion-reduce:hover:scale-100 motion-reduce:active:scale-100"
      >
        {t("common", G.done)}
      </button>
    </motion.div>
  );
}
