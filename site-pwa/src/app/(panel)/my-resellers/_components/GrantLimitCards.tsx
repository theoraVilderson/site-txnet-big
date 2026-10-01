"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { grantLimitsApi, type TenantGrantLimit, type UserGrantLimit } from "@/lib/billing-api";
import { Alert, input, primaryButton, quietButton } from "../../catalog/_components/catalog-ui";
import { USER_KEYS } from "../_lib/users";
import { useUserMessage } from "../[id]/users/[userId]/_components/useUserMessage";

const L = USER_KEYS.grantLimit;
/** Billing's bound (`MAX_METERED_CAP`); billing refuses past it, the box only helps. */
const MAX = 1000;

/** A whole number 0..1000 from a box, `null` for empty, `undefined` for anything else. */
export function capOf(typed: string): number | null | undefined {
  const v = typed.trim();
  if (v === "") return null;
  if (!/^\d{1,4}$/.test(v)) return undefined;
  const n = Number(v);
  return n <= MAX ? n : undefined;
}

/**
 * The tenant's default limit of open pay-as-you-go services per user (F-118-aq
 * over F-118-ap), on the users page — the one place both the platform's staff
 * and a reseller manage their users. Empty is the platform's default.
 */
export function TenantGrantLimitCard({ tenantId }: { tenantId: string }) {
  const { t } = useLocale();
  const message = useUserMessage();
  const api = useMemo(() => grantLimitsApi(tenantId), [tenantId]);
  const [view, setView] = useState<TenantGrantLimit | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    api.tenant().then(
      (v) => {
        if (!live) return;
        setView(v);
        setTyped(v.tenantDefault === null ? "" : String(v.tenantDefault));
      },
      (e) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [api]);

  const cap = capOf(typed);
  const save = async () => {
    if (cap === undefined || busy) return;
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const v = await api.setTenant(cap);
      setView(v);
      setTyped(v.tenantDefault === null ? "" : String(v.tenantDefault));
      setSaved(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={t("common", L.title)} className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-4">
      <div>
        <h2 className="text-sm font-bold text-text-primary">{t("common", L.title)}</h2>
        <p className="mt-1 text-xs leading-5 text-text-secondary">{t("common", L.tenantHint)}</p>
      </div>
      {view && (
        <p className="text-xs text-text-secondary">
          {t("common", L.inEffect, { count: view.effective })} · {t("common", L.platformDefault, { count: view.platformDefault })}
        </p>
      )}
      {typeof view?.ceiling === "number" && <p className="text-xs text-text-secondary">{t("common", L.ceiling, { count: view.ceiling })}</p>}
      <div className="flex flex-wrap items-end gap-2">
        <label className="block min-w-40 flex-1">
          <span className="mb-1 block text-xs font-bold text-text-secondary">{t("common", L.tenantInput)}</span>
          <input
            type="text"
            inputMode="numeric"
            dir="ltr"
            value={typed}
            placeholder={view ? String(view.platformDefault) : ""}
            onChange={(e) => {
              setTyped(e.target.value);
              setSaved(false);
            }}
            className={input}
          />
        </label>
        <button type="button" className={primaryButton} disabled={view === null || cap === undefined || busy} onClick={() => void save()}>
          {busy && <Loader2 size={12} className="animate-spin" aria-hidden />}
          {t("common", L.save)}
        </button>
      </div>
      <p className="text-xs text-text-secondary">{t("common", L.tenantInputHint)}</p>
      {saved && <p className="text-xs font-bold text-primary">{t("common", L.saved)}</p>}
      {error !== null && <Alert>{message(error)}</Alert>}
    </section>
  );
}

/**
 * One user's limit (F-118-aq over F-118-ap), on their page: the number in
 * effect and where it comes from, how many they hold open, and staff's answer
 * to their ticket — a number with a reason, or back to the default.
 */
export function UserGrantLimitCard({ tenantId, userId }: { tenantId: string; userId: string }) {
  const { t } = useLocale();
  const message = useUserMessage();
  const api = useMemo(() => grantLimitsApi(tenantId), [tenantId]);
  const [view, setView] = useState<UserGrantLimit | null>(null);
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    api.user(userId).then(
      (v) => live && setView(v),
      (e) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [api, userId]);

  const run = async (step: () => Promise<UserGrantLimit>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setView(await step());
      setTyped("");
      setReason("");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const cap = capOf(typed);
  const canSet = typeof cap === "number" && reason.trim().length > 0 && !busy;

  return (
    <section aria-label={t("common", L.title)} className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-4">
      <div>
        <h2 className="text-sm font-bold text-text-primary">{t("common", L.title)}</h2>
        <p className="mt-1 text-xs leading-5 text-text-secondary">{t("common", L.userHint)}</p>
      </div>
      {view && (
        <div className="space-y-1 text-xs text-text-secondary">
          <p className="font-bold text-text-primary">{t("common", L.userOpen, { open: view.open, effective: view.effective })}</p>
          <p>
            {view.own
              ? t("common", L.userOwn, { count: view.own.meteredOpenCap })
              : t("common", L.userFromDefault, { count: view.tenantDefault ?? view.platformDefault })}
          </p>
          {view.own?.reason && <p>{t("common", L.userReasonShown, { reason: view.own.reason })}</p>}
          {typeof view.ceiling === "number" && <p>{t("common", L.ceiling, { count: view.ceiling })}</p>}
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-[8rem_1fr_auto] sm:items-end">
        <label className="block">
          <span className="mb-1 block text-xs font-bold text-text-secondary">{t("common", L.userInput)}</span>
          <input type="text" inputMode="numeric" dir="ltr" value={typed} onChange={(e) => setTyped(e.target.value)} className={input} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-bold text-text-secondary">{t("common", L.userReason)}</span>
          <input type="text" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} className={input} />
        </label>
        <button
          type="button"
          className={primaryButton}
          disabled={view === null || !canSet}
          onClick={() => void run(() => api.setUser(userId, cap as number, reason.trim()))}
        >
          {busy && <Loader2 size={12} className="animate-spin" aria-hidden />}
          {t("common", L.userSet)}
        </button>
      </div>
      {view?.own && (
        <button type="button" className={quietButton} disabled={busy} onClick={() => void run(() => api.removeUser(userId))}>
          {t("common", L.userRemove)}
        </button>
      )}
      {error !== null && <Alert>{message(error)}</Alert>}
    </section>
  );
}
