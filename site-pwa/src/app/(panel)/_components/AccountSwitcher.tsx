"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  Check,
  ChevronDown,
  LogOut,
  Plus,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { authApi } from "@/lib/auth-api";
import { useLocale } from "@/context/LocaleContext";
import { usePanelSession } from "../_context/PanelSessionContext";
import { PANEL_ACCOUNTS_ADD, AUTH_LOGIN } from "@/lib/routes";
import { useApiErrorMessage } from "@/hooks/useApiError";

import { FrontendI18nKeys } from "@/generated/i18n-keys";

/** The `common` namespace as generated constants (F-083, C-06). */
const C = FrontendI18nKeys.common;

/**
 * Current account, the rest of the group, "add an account" (F-0209).
 *
 * Without this the capability is invisible: F-0205 through F-0207 are three
 * API routes and nothing a user can point at.
 *
 * A successful switch does a **full** navigation (`window.location`), not a
 * client-side `router.push`. Everything this app has already fetched belongs
 * to the account being left — and the session it was fetched with has just
 * been revoked server-side. Throwing the whole page away is the only honest
 * way to change who the tab is.
 */
export function AccountSwitcher() {
  const { t } = useLocale();
  const router = useRouter();
  const { group, isLoading, reload } = usePanelSession();
  const [isOpen, setIsOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const toMessage = useApiErrorMessage();
  const [error, setError] = useState<string | null>(null);
  /**
   * Which member the user has asked to remove, and has not yet confirmed.
   *
   * The confirm is inline — the row turns into the question — rather than a
   * `window.confirm`: the remove control sits directly beside the row that
   * *switches* to the same account, so the one thing this step has to do is
   * name the account being removed in place, where the user is already looking.
   */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmingSignOutAll, setConfirmingSignOutAll] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false);
        setConfirmingId(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  if (isLoading || !group) {
    return (
      <div className="h-9 w-28 animate-pulse rounded-xl bg-bg-inner" aria-hidden />
    );
  }

  const handleSwitch = async (userId: string) => {
    setPendingId(userId);
    setError(null);
    try {
      await authApi.switchAccount(userId);
      window.location.assign("/");
    } catch (e) {
      setError(toMessage(e));
      setPendingId(null);
    }
  };

  /**
   * Remove a member from this browser's group (F-0208).
   *
   * Removing the *current* account revokes this browser's own session, so that
   * case reloads the page rather than re-reading the group: the token this tab
   * holds is already dead, and `reload()` would only turn that into a bounce to
   * the login screen one render later. Removing anyone else leaves the session
   * alone, so the menu simply re-reads and stays open.
   */
  const handleRemove = async (userId: string) => {
    const isSelf = userId === group.current.userId;
    setPendingId(userId);
    setError(null);
    try {
      await authApi.removeAccount(userId);
      if (isSelf) {
        window.location.assign("/");
        return;
      }
      await reload();
      setConfirmingId(null);
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-leaf-bg hover:text-primary"
      >
        <UserRound size={18} />
        <span className="hidden max-w-[10rem] truncate font-bold sm:inline">
          {group.current.fullName}
        </span>
        <ChevronDown
          size={14}
          className={`transition-transform ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className="absolute end-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-xl border border-card-border bg-card-bg shadow-xl shadow-card-shadow backdrop-blur-xl"
          >
            <div className="flex items-center justify-between gap-2 border-b border-card-border px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-primary">
                  {group.current.fullName}
                </p>
                <p className="truncate text-xs text-text-secondary" dir="ltr">
                  {group.current.phoneMasked}
                </p>
              </div>
              <Check size={16} className="shrink-0 text-primary" />
            </div>

            {/*
              Leaving the group yourself (F-0208, "from either side"). Only
              shown when there is a group to leave — and it is the account that
              was *added* by someone else which most needs this, since without
              it that account has no way out of a set it did not build.
            */}
            {group.groupId && (
              confirmingId === group.current.userId ? (
                <div className="flex items-center gap-2 border-b border-card-border bg-leaf-bg px-4 py-2.5">
                  <span className="min-w-0 flex-1 text-xs text-text-primary">
                    {t("common", C.accounts.leaveConfirm)}
                  </span>
                  <button
                    type="button"
                    disabled={pendingId !== null}
                    onClick={() => handleRemove(group.current.userId)}
                    className="shrink-0 rounded-lg px-2 py-1 text-xs font-bold text-error transition-colors hover:bg-card-bg disabled:opacity-60"
                  >
                    {pendingId === group.current.userId
                      ? t("common", C.accounts.removing)
                      : t("common", C.accounts.removeYes)}
                  </button>
                  <button
                    type="button"
                    aria-label={t("common", C.accounts.removeCancel)}
                    onClick={() => setConfirmingId(null)}
                    className="shrink-0 rounded-lg p-1 text-text-secondary transition-colors hover:bg-card-bg"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  disabled={pendingId !== null}
                  onClick={() => setConfirmingId(group.current.userId)}
                  className="flex w-full items-center gap-2 border-b border-card-border px-4 py-2 text-xs text-text-secondary transition-colors hover:bg-leaf-bg hover:text-error disabled:opacity-60"
                >
                  <Trash2 size={13} className="shrink-0" />
                  {t("common", C.accounts.leave)}
                </button>
              )
            )}

            {group.members.length > 0 && (
              <div className="py-1">
                <p className="px-4 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wide text-text-secondary">
                  {t("common", C.accounts.switchTo)}
                </p>
                {group.members.map((member) =>
                  confirmingId === member.userId ? (
                    <div
                      key={member.userId}
                      className="flex items-center gap-2 bg-leaf-bg px-4 py-2.5"
                    >
                      <span className="min-w-0 flex-1 text-xs text-text-primary">
                        {t("common", C.accounts.removeConfirm).replace(
                          "{{name}}",
                          member.fullName,
                        )}
                      </span>
                      <button
                        type="button"
                        disabled={pendingId !== null}
                        onClick={() => handleRemove(member.userId)}
                        className="shrink-0 rounded-lg px-2 py-1 text-xs font-bold text-error transition-colors hover:bg-card-bg disabled:opacity-60"
                      >
                        {pendingId === member.userId
                          ? t("common", C.accounts.removing)
                          : t("common", C.accounts.removeYes)}
                      </button>
                      <button
                        type="button"
                        aria-label={t("common", C.accounts.removeCancel)}
                        onClick={() => setConfirmingId(null)}
                        className="shrink-0 rounded-lg p-1 text-text-secondary transition-colors hover:bg-card-bg"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <div
                      key={member.userId}
                      className="flex items-center transition-colors hover:bg-leaf-bg"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        disabled={pendingId !== null}
                        onClick={() => handleSwitch(member.userId)}
                        className="flex min-w-0 flex-1 items-center gap-3 py-2.5 ps-4 text-start disabled:opacity-60"
                      >
                        <UserRound size={16} className="shrink-0 text-text-secondary" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-text-primary">
                            {member.fullName}
                          </span>
                          <span
                            className="block truncate text-xs text-text-secondary"
                            dir="ltr"
                          >
                            {member.phoneMasked}
                          </span>
                        </span>
                        {pendingId === member.userId && (
                          <span className="text-xs text-text-secondary">
                            {t("common", C.accounts.switching)}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        aria-label={t("common", C.accounts.remove)}
                        title={t("common", C.accounts.remove)}
                        disabled={pendingId !== null}
                        onClick={() => setConfirmingId(member.userId)}
                        className="shrink-0 rounded-lg p-2 me-2 text-text-secondary transition-colors hover:text-error disabled:opacity-60"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ),
                )}
              </div>
            )}

            {error && (
              <p className="px-4 pb-2 text-xs font-medium text-error">{error}</p>
            )}

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setIsOpen(false);
                router.push(PANEL_ACCOUNTS_ADD);
              }}
              className="flex w-full items-center gap-2 border-t border-card-border px-4 py-3 text-sm font-bold text-text-secondary transition-colors hover:bg-leaf-bg hover:text-primary"
            >
              <Plus size={16} />
              {t("common", C.accounts.add)}
            </button>

            {/*
              `F-0211`. Deliberately the last row of a menu that has to be
              opened, behind its own confirmation, and worded as what it does —
              ordinary logout lives on the nav, far from here. The two are
              different intentions (ADR-0035) and the destructive one must not
              be reachable by a mis-tap.
            */}
            {confirmingSignOutAll ? (
              <div className="border-t border-card-border px-4 py-3">
                <p className="mb-2 text-xs text-text-secondary">
                  {t("common", C.accounts.signOutAllConfirm)}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={pendingId !== null}
                    onClick={async () => {
                      setPendingId("__all__");
                      try {
                        await authApi.logoutAll();
                      } catch {
                        // Already gone server-side is the same outcome.
                      }
                      router.replace(AUTH_LOGIN);
                    }}
                    className="rounded-lg bg-error px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60"
                  >
                    {t("common", C.accounts.signOutAllYes)}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingSignOutAll(false)}
                    className="rounded-lg px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                role="menuitem"
                onClick={() => setConfirmingSignOutAll(true)}
                className="flex w-full items-center gap-2 border-t border-card-border px-4 py-3 text-sm text-text-secondary transition-colors hover:bg-leaf-bg hover:text-error"
              >
                <LogOut size={16} className="rtl:-scale-x-100" />
                {t("common", C.accounts.signOutAll)}
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
