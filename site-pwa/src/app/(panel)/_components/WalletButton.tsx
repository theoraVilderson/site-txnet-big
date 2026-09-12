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
import { PANEL_FINANCIAL } from "@/lib/routes";
import { useWalletBalance } from "../_hooks/useWalletBalance";
import { BASE_CURRENCY, formatMoney } from "../_lib/money";
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
  { id: "top-up", label: W.topUp, icon: PlusCircle, href: null, lead: true }, // F-093-e
  { id: "gift-code", label: W.giftCode, icon: Ticket, href: null, modal: "gift-code" }, // F-093-g
  { id: "history", label: W.history, icon: History, href: PANEL_FINANCIAL }, // F-093-d
];

/**
 * The wallet in the top bar (F-093-c): the balance, and the quick actions that
 * reach the money pages.
 *
 * It goes **before** `AccountSwitcher` and has to fit a 360px bar
 * (`contract.shell.md` rule 5) — which is why the caption collapses below `sm`
 * and only the figure survives. Sides are logical throughout (`start`/`end`,
 * `ms`/`me`): the same build serves RTL and LTR (rule 4).
 *
 * The balance itself is `useWalletBalance`'s, and nothing here adjusts it.
 */
export function WalletButton() {
  const { t, lang } = useLocale();
  const { balance, isLoading, failed, refresh } = useWalletBalance();
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
  // hidden (`contract.shell.md` rule 2) — today that is top-up alone (F-093-e).
  const visible = QUICK_ACTIONS.filter((a) => a.href !== null || a.modal !== undefined);

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

        <span className="flex min-w-0 flex-col text-start leading-tight">
          <span
            className={`hidden text-[10px] font-bold sm:block ${
              open ? "text-white/80" : "text-text-secondary"
            }`}
          >
            {t("common", W.label)}
          </span>
          <span className="font-mono text-sm font-bold">
            {isLoading && balance === null ? (
              <span
                className="inline-block h-4 w-20 animate-pulse rounded-md bg-bg-inner align-middle"
                aria-hidden
              />
            ) : balance === null ? (
              <span className={open ? "text-white/80" : "text-text-secondary"}>
                {t("common", W.unavailable)}
              </span>
            ) : (
              <span className={open ? "text-white" : "text-gold"}>
                {formatMoney(balance, BASE_CURRENCY, { lang, t })}
              </span>
            )}
          </span>
        </span>

        <ChevronDown
          size={14}
          aria-hidden
          className={`ms-1 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {/* Rendered only while open: a hidden-but-mounted menu keeps its links in
          the tab order, which is how a keyboard user lands on a control they
          cannot see. Legacy animated a permanently mounted panel. */}
      {open && (
        <div
          id={menuId}
          className="absolute end-0 z-30 mt-3 w-72 rounded-2xl border border-card-border bg-card-bg p-3 shadow-xl backdrop-blur-xl"
        >
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
