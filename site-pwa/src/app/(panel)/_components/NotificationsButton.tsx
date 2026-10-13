"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Bell,
  CheckCheck,
  MessageSquare,
  RotateCw,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useNotifications } from "../_hooks/useNotifications";
import { formatInstant } from "../_lib/datetime";
import { Button, IconButton, notify, Popover } from "./kit";

/** The control's strings as generated constants (C-06). */
const N = FrontendI18nKeys.common.notifications;

/** One id for the arrival toast, so a second arrival replaces it rather than stacking. */
const ARRIVED_TOAST = "notification-arrived";

/** Above this the badge says "99+": a four-digit pill is wider than the bell. */
const BADGE_CEILING = 99;

/**
 * An icon and a theme class per `NotificationType`, the same shape
 * `financial/_lib/tones.ts` uses and for the same reason: every colour is a
 * theme token, never a raw palette class, because three themes ship and a
 * hard-coded `orange-500` is legible in one of them by luck.
 *
 * Gold is a tone here, not a control — a low balance is a status, which is
 * where gold is allowed; no button in this panel is gold.
 */
const TYPE_TONES: Record<string, { icon: LucideIcon; className: string; labelKey: string }> = {
  system_alert: { icon: AlertCircle, className: "bg-error-bg text-error", labelKey: N.types.systemAlert },
  admin_message: { icon: MessageSquare, className: "bg-leaf-bg text-primary", labelKey: N.types.adminMessage },
  low_balance: { icon: Wallet, className: "bg-gold-bg text-gold", labelKey: N.types.lowBalance },
};

/**
 * A type this build has not heard of is still a message. It renders neutral
 * rather than being dropped: `notification-service` may add a `NotificationType`
 * before this app is redeployed, and a row filtered out here would be a message
 * the user never learns exists.
 */
const UNKNOWN_TONE = { icon: Bell, className: "bg-bg-inner text-text-secondary", labelKey: N.types.other };

/**
 * The notifications dropdown in the top bar (F-093-h): the unread badge, the
 * newest items by type, and the empty state.
 *
 * It goes **before** `AccountSwitcher` with the wallet, which is where
 * `contract.shell.md` rule 5 puts a new control — and it is the control that
 * made the wallet collapse to its icon below `sm`, because the 360px bar had
 * 18px of slack and this needs 40. Sides are logical throughout (`start`/`end`,
 * `ms`/`me`): the same build serves RTL and LTR (rule 4).
 *
 * There is no "see all notifications" footer. Legacy had one and it led
 * nowhere; a destination that does not exist is hidden rather than rendered as
 * a dead link (rule 2), and the row that builds an inbox page fills it in.
 */
export function NotificationsButton() {
  const { t, lang } = useLocale();
  const { items, unreadCount, isLoading, failed, refresh, markRead, markAllRead, arrived } = useNotifications();
  const [open, setOpen] = useState(false);

  // Read inside the toast effect without making `open` a reason to toast again.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // A row that arrives live is toasted (F-093-h1): the badge alone is missed by
  // anyone not looking at the bar. One toast however many landed, none while
  // the panel is open — the row is already on screen — and pressing it opens
  // the panel, where the row is marked read on purpose (rule 5), not here.
  useEffect(() => {
    if (!arrived || openRef.current) return;
    const [first] = arrived.items;
    const single = arrived.items.length === 1;
    const tone = single ? (TYPE_TONES[first.type] ?? UNKNOWN_TONE) : UNKNOWN_TONE;
    const Icon = tone.icon;
    notify.info(
      <button
        type="button"
        onClick={() => {
          notify.dismiss(ARRIVED_TOAST);
          setOpen(true);
        }}
        className="min-w-0 text-start"
      >
        <span className="block font-semibold text-text-primary">
          {single ? first.title : t("common", N.arrived, { count: String(arrived.items.length) })}
        </span>
        {single && <span className="mt-0.5 line-clamp-2 block text-xs text-text-secondary">{first.body}</span>}
      </button>,
      {
        id: ARRIVED_TOAST,
        icon: (
          <span className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${tone.className}`}>
            <Icon size={16} aria-hidden />
          </span>
        ),
      },
    );
    // `t` is not a reason to toast the same arrival again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrived]);

  const badge = useMemo(
    () => (unreadCount > BADGE_CEILING ? `${BADGE_CEILING}+` : String(unreadCount)),
    [unreadCount],
  );

  // The panel is the kit's `Popover` (contract.ux.md K7): portaled out of the
  // bar's `backdrop-filter`, rendered only while open so a hidden panel's
  // buttons never sit in the tab order, closed by Esc and an outside press.
  return (
    <Popover
      label={t("common", N.label)}
      align="end"
      open={open}
      onOpenChange={setOpen}
      className="w-80 overflow-hidden p-0"
      trigger={
        <button
          type="button"
          aria-label={t("common", open ? N.close : N.open)}
          className={`relative rounded-xl border p-2 transition-colors ${
            open
              ? "border-primary bg-primary text-on-accent"
              : "border-card-border bg-leaf-bg text-text-primary hover:border-primary"
          }`}
        >
          <Bell size={20} aria-hidden />
          {unreadCount > 0 && (
            <>
              {/* The number is decoration for a screen reader — the sentence
                  beside it says what it means, and says it with the count. */}
              <span
                aria-hidden
                className="absolute -top-1.5 -end-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-error px-1 font-mono text-3xs font-bold text-bg-inner"
              >
                {badge}
              </span>
              <span className="sr-only">{t("common", N.unread, { count: String(unreadCount) })}</span>
            </>
          )}
        </button>
      }
    >
      <div className="flex items-center justify-between gap-2 border-b border-card-border bg-leaf-bg px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-sm font-bold text-text-primary">
            {t("common", N.label)}
          </h3>
          {unreadCount > 0 && (
            <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-3xs font-bold text-on-accent">
              {t("common", N.new, { count: String(unreadCount) })}
            </span>
          )}
        </div>
        {unreadCount > 0 && (
          <Button size="sm" variant="quiet" icon={<CheckCheck size={12} aria-hidden />} onClick={() => void markAllRead()} className="h-6 px-2 text-3xs">
            {t("common", N.markAllRead)}
          </Button>
        )}
      </div>

      {/* A failed read is not an empty inbox, so this is a line above the
          list and never instead of it: whatever was last read stays on
          screen (`contract.errors.md` — the panel owns this sentence,
          because the route answers no translated text for it). */}
      {failed && (
        <div className="flex items-center justify-between gap-2 border-b border-error-border bg-error-bg px-4 py-2">
          <p role="alert" className="text-xs text-error">
            {t("common", N.unavailable)}
          </p>
          <Button size="sm" variant="quiet" icon={<RotateCw size={12} aria-hidden />} onClick={refresh} className="h-6 px-2 text-3xs text-error hover:text-error">
            {t("common", N.retry)}
          </Button>
        </div>
      )}

      <div className="max-h-80 overflow-y-auto">
        {isLoading && items.length === 0 ? (
          <div className="space-y-3 p-4" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-xl bg-bg-inner" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <Bell size={24} aria-hidden className="mx-auto mb-2 text-text-secondary opacity-60" />
            <p className="text-sm font-medium text-text-primary">{t("common", N.empty)}</p>
            <p className="mt-1 text-xs text-text-secondary">{t("common", N.emptyHint)}</p>
          </div>
        ) : (
          <ul>
            {items.map((item) => {
              const tone = TYPE_TONES[item.type] ?? UNKNOWN_TONE;
              const Icon = tone.icon;
              const when = formatInstant(item.createdAt, lang);
              const isUnread = item.readAt === null;
              return (
                <li
                  key={item.id}
                  className={`border-b border-card-border last:border-0 ${isUnread ? "bg-leaf-bg/40" : ""}`}
                >
                  <div className="flex items-start gap-3 px-4 py-3">
                    <span
                      className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg ${tone.className}`}
                    >
                      <Icon size={16} aria-hidden />
                      <span className="sr-only">{t("common", tone.labelKey)}</span>
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-text-primary">{item.title}</p>
                      <p className="mt-0.5 text-xs break-words text-text-secondary">{item.body}</p>
                      {when && (
                        <p className="mt-1 font-mono text-3xs text-text-secondary opacity-70">{when}</p>
                      )}
                    </div>
                    {/* One row, marked on purpose. Opening the panel marks
                        nothing: a badge that clears itself on a glance is a
                        badge that loses the one message the user meant to
                        come back to. */}
                    {isUnread && (
                      <IconButton
                        size="sm"
                        onClick={() => void markRead(item.id)}
                        aria-label={t("common", N.markRead)}
                        icon={<CheckCheck size={14} aria-hidden />}
                        className="size-7"
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Popover>
  );
}
