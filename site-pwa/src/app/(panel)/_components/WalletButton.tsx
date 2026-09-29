"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import {
  ChevronDown,
  History,
  PlusCircle,
  RotateCw,
  Ticket,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { PANEL_DEPOSIT, PANEL_FINANCIAL } from "@/lib/routes";
import { useWalletBalance } from "../_hooks/useWalletBalance";
import { formatMoney, isNonZero } from "../_lib/money";
import { GiftCodeModal } from "./GiftCodeModal";

/** The control's strings as generated constants (C-06). */
const W = FrontendI18nKeys.common.wallet;

/**
 * One quick action.
 *
 * `href` is a page; `modal` is one of this panel's own overlays. `href: null`
 * with no `modal` is the shell's own convention for a destination that does not
 * exist yet (`contract.shell.md` rule 2): the entry is **hidden**, never
 * rendered as a dead link, and the row that builds it fills this in. F-093-g
 * filled in the gift code with a `modal` rather than an `href` because a code
 * box is not worth a route — there is nothing to link to, bookmark or come back
 * to, and a page would leave the wallet to show a single input.
 */
interface QuickAction {
  id: string;
  label: string;
  icon: LucideIcon;
  href: string | null;
  /** Opens an overlay instead of navigating. Exclusive with `href`. */
  modal?: "gift-code";
  /** Highlighted as the action the panel wants (legacy's full-width deposit button). */
  lead?: boolean;
}

/**
 * The actions legacy's `Vault.tsx` offered, in its order. Each waits on its own
 * row, and one that has not landed is hidden rather than rendered dead — so
 * this list shrinks and grows without the dropdown needing to know why.
 *
 * Legacy's fourth entry ("buy TXNet services") is not here: it linked to
 * `/services`, which is the sidebar's own `my-services` entry, and a second
 * route to one page is what `activeHref` then has to disambiguate.
 */
const QUICK_ACTIONS: readonly QuickAction[] = [
  { id: "top-up", label: W.topUp, icon: PlusCircle, href: PANEL_DEPOSIT, lead: true }, // F-093-e
  { id: "gift-code", label: W.giftCode, icon: Ticket, href: null, modal: "gift-code" }, // F-093-g
  { id: "history", label: W.history, icon: History, href: PANEL_FINANCIAL }, // F-093-d
];

/**
 * The wallet in the top bar (F-093-c): the balance, and the quick actions that
 * reach the money pages.
 *
 * It goes **before** `AccountSwitcher` and has to fit a 360px bar
 * (`contract.shell.md` rule 5). **Below `sm` it is the icon alone**: the
 * caption, the figure and the chevron all move out, and the figure reappears in
 * the dropdown's own header. That is F-093-h's doing — the bar had 18px of
 * slack at 360px and the notifications bell needs 40 — but the figure is the
 * one that left, because rule 5 names it as the bar's only unbounded term: it
 * has no truncation, so a long enough balance put the row over budget on its
 * own. Moving it costs one tap and bounds the bar for the control after this
 * one; truncating it in place would have printed a wrong number, which rule 1
 * below exists to prevent.
 *
 * Sides are logical throughout (`start`/`end`, `ms`/`me`): the same build
 * serves RTL and LTR (rule 4).
 *
 * The balance itself is `useWalletBalance`'s, and nothing here adjusts it.
 */
export function WalletButton() {
  const { t, lang } = useLocale();
  // The figure is what can be spent (F-118-j): money held for a service is
  // not, and a balance that included it would promise a purchase it refuses.
  const { available: balance, held, currencyCode, isLoading, failed, refresh } = useWalletBalance();
  const holding = isNonZero(held);
  const [open, setOpen] = useState(false);
  const [giftOpen, setGiftOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // `pointerdown` rather than `click`, so a press that starts outside closes the
  // menu before the thing under it reacts to the same gesture.
  // Suspended while the modal is up: its backdrop covers this control, so an
  // outside press is aimed at the modal, and an Escape there is the modal's to
  // answer. Without this, one key closes both and the dropdown is gone when the
  // user comes back to it.
  useEffect(() => {
    if (!open || giftOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, giftOpen]);

  // An entry with neither destination is the "not built yet" state, and stays
  // hidden (`contract.shell.md` rule 2). Every entry has one since F-093-e;
  // the filter stays, because rule 4 is how the next one is added.
  const visible = QUICK_ACTIONS.filter((a) => a.href !== null || a.modal !== undefined);

  // One figure, two homes: the button from `sm` up, the dropdown's header at
  // every width. It is `useWalletBalance`'s string formatted — never a sum
  // worked out here (`contract.shell.md`, the wallet control's rule 1).
  const figure =
    isLoading && balance === null ? (
      <span
        className="inline-block h-4 w-20 animate-pulse rounded-md bg-bg-inner align-middle"
        aria-hidden
      />
    ) : balance === null || currencyCode === null ? (
      <span className={open ? "text-white/80" : "text-text-secondary"}>
        {t("common", W.unavailable)}
      </span>
    ) : (
      <span className={open ? "text-white" : "text-gold"}>
        {formatMoney(balance, currencyCode, { lang, t })}
      </span>
    );

  function openModal(modal: NonNullable<QuickAction["modal"]>) {
    setOpen(false);
    if (modal === "gift-code") setGiftOpen(true);
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("common", open ? W.close : W.open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        className={`flex items-center gap-2 rounded-xl border px-2 py-1.5 transition-colors sm:gap-3 sm:px-3 ${
          open
            ? "border-primary bg-primary text-white"
            : "border-card-border bg-leaf-bg text-text-primary hover:border-primary"
        }`}
      >
        <span
          className={`flex size-7 shrink-0 items-center justify-center rounded-lg sm:size-8 ${
            open ? "bg-white/20 text-white" : "bg-primary text-white"
          }`}
        >
          <Wallet size={16} aria-hidden />
        </span>

        {/* The figure and the chevron are the bar's whole cost below `sm`, and
            the figure is the unbounded one. They live in the dropdown's header
            there instead — see the component note. */}
        <span className="hidden min-w-0 flex-col text-start leading-tight sm:flex">
          <span
            className={`text-[10px] font-bold ${open ? "text-white/80" : "text-text-secondary"}`}
          >
            {t("common", holding ? W.available : W.label)}
          </span>
          <span className="font-mono text-sm font-bold">{figure}</span>
        </span>

        <ChevronDown
          size={14}
          aria-hidden
          className={`ms-1 hidden shrink-0 transition-transform sm:block ${open ? "rotate-180" : ""}`}
        />
      </button>

      {/* Rendered only while open: a hidden-but-mounted menu keeps its links in
          the tab order, which is how a keyboard user lands on a control they
          cannot see. Legacy animated a permanently mounted panel. */}
      {open && (
        <div
          id={menuId}
          className="absolute end-0 z-30 mt-3 w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-card-border bg-card-bg p-3 shadow-xl backdrop-blur-xl"
        >
          {/* The figure's home below `sm`, where the button is the icon alone.
              It is shown at every width rather than only there: a balance that
              appears and disappears with the viewport is one the user has to
              hunt for, and this is the panel that every wallet action starts
              from. */}
          <div className="mb-3 flex items-center justify-between gap-2 rounded-xl bg-leaf-bg px-3 py-2 sm:hidden">
            <span className="text-[10px] font-bold text-text-secondary">{t("common", holding ? W.available : W.label)}</span>
            <span className="font-mono text-sm font-bold">{figure}</span>
          </div>

          {/* Held money apart (F-118-j): part of the wallet, not spendable. */}
          {holding && currencyCode !== null && (
            <div className="mb-3 rounded-xl border border-card-border px-3 py-2">
              <p className="text-xs font-bold text-text-primary" dir="auto">
                {t("common", W.held, { amount: formatMoney(held, currencyCode, { lang, t }) })}
              </p>
              <p className="mt-0.5 text-[10px] leading-4 text-text-secondary">{t("common", W.heldHint)}</p>
            </div>
          )}

          <div className="mb-3 flex items-center justify-between px-1">
            <span className="text-xs font-bold text-text-secondary">
              {t("common", W.quickActions)}
            </span>
            {failed && (
              <button
                type="button"
                onClick={refresh}
                className="flex items-center gap-1 rounded-lg px-2 py-0.5 text-[10px] text-text-secondary hover:bg-leaf-bg hover:text-text-primary"
              >
                <RotateCw size={12} aria-hidden />
                {t("common", W.retry)}
              </button>
            )}
          </div>

          {visible.length === 0 ? (
            <p className="px-1 py-4 text-center text-xs text-text-secondary">
              {t("common", W.noActions)}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {visible.map(({ id, label, icon: Icon, href, modal, lead }) => {
                const className = lead
                  ? "col-span-2 flex items-center justify-center gap-2 rounded-xl bg-primary p-3 text-sm font-bold text-white hover:brightness-110"
                  : "flex flex-col items-center justify-center gap-1.5 rounded-xl bg-leaf-bg p-3 text-xs font-medium text-text-primary hover:bg-card-border";
                const inside = (
                  <>
                    <Icon size={lead ? 18 : 20} aria-hidden />
                    {label && <span>{t("common", label)}</span>}
                  </>
                );
                // A modal entry is a `button`, not a `Link` with a dead href: a
                // link that navigates nowhere is announced as a link and
                // offered to "open in a new tab".
                return modal ? (
                  <button key={id} type="button" onClick={() => openModal(modal)} className={className}>
                    {inside}
                  </button>
                ) : (
                  <Link key={id} href={href as string} onClick={() => setOpen(false)} className={className}>
                    {inside}
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Outside the dropdown's own `open &&`: opening it closes the dropdown,
          and a modal unmounted by that would take the user's half-typed code
          with it. A redemption makes the top bar re-read its balance — it is
          never handed an amount to add (`contract.shell.md` rule 1). */}
      <GiftCodeModal open={giftOpen} onClose={() => setGiftOpen(false)} onRedeemed={refresh} />
    </div>
  );
}
