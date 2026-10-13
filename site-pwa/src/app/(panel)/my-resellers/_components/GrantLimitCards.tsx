"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { grantLimitsApi, type CompensationCap, type TenantGrantLimit, type UserGrantLimit } from "@/lib/billing-api";
import { compensationCapBody } from "../_lib/grant-actions";
import { USER_KEYS } from "../_lib/users";
import { formatBytes } from "../../services/_lib/service-configs";
import { useUserMessage } from "../[id]/users/[userId]/_components/useUserMessage";
import { Alert, Button, Field, Input } from "../../_components/kit";

const L = USER_KEYS.grantLimit;
const C = USER_KEYS.compensationCap;
const GIB = 1024 ** 3;
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
        <Field label={t("common", L.tenantInput)}>
          <Input
            type="text"
            inputMode="numeric"
            dir="ltr"
            value={typed}
            placeholder={view ? String(view.platformDefault) : ""}
            onChange={(e) => {
              setTyped(e.target.value);
              setSaved(false);
            }}
          />
        </Field>
        <Button variant="primary" size="sm" disabled={view === null || cap === undefined} onClick={() => void save()} loading={busy}>
          {t("common", L.save)}
        </Button>
      </div>
      <p className="text-xs text-text-secondary">{t("common", L.tenantInputHint)}</p>
      {saved && <p className="text-xs font-bold text-primary">{t("common", L.saved)}</p>}
      {error !== null && <Alert tone="error">{message(error)}</Alert>}
    </section>
  );
}

/**
 * One user's limit (F-118-aq), on their page, read only: the number in
 * effect and where it comes from, and how many they hold open. Staff's answer
 * to their ticket is set on their Profile tab as the `metered_services_max`
 * restriction (F-030-e) — one place for a cap on one person.
 */
export function UserGrantLimitCard({ tenantId, userId }: { tenantId: string; userId: string }) {
  const { t } = useLocale();
  const message = useUserMessage();
  const api = useMemo(() => grantLimitsApi(tenantId), [tenantId]);
  const [view, setView] = useState<UserGrantLimit | null>(null);
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
      {error !== null && <Alert tone="error">{message(error)}</Alert>}
    </section>
  );
}

/**
 * What a `grant.compensate` holder may add to one service over 30 days
 * (KS-1-c), on the users page beside the limit above. Everyone who
 * compensates reads it; only a `grant.assign` holder (`canSet`) gets the
 * boxes — billing's door decides either way. Empty boxes are the platform's.
 */
export function CompensationCapCard({ tenantId, canSet }: { tenantId: string; canSet: boolean }) {
  const { t, lang } = useLocale();
  const message = useUserMessage();
  const api = useMemo(() => grantLimitsApi(tenantId), [tenantId]);
  const [view, setView] = useState<CompensationCap | null>(null);
  const [days, setDays] = useState("");
  const [gb, setGb] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const show = (v: CompensationCap) => {
    setView(v);
    setDays(v.own ? String(v.own.days) : "");
    setGb(v.own ? String(Number(v.own.bytes) / GIB) : "");
  };

  useEffect(() => {
    let live = true;
    api.compensation().then(
      (v) => live && show(v),
      (e) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [api]);

  const run = async (cap: { days: number; gb: number } | null) => {
    if (busy) return;
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      show(await api.setCompensation(cap));
      setSaved(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const size = (bytes: string) => formatBytes(bytes, lang) ?? "";
  const body = compensationCapBody(days, gb);

  return (
    <section aria-label={t("common", C.title)} className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-4">
      <div>
        <h2 className="text-sm font-bold text-text-primary">{t("common", C.title)}</h2>
        <p className="mt-1 text-xs leading-5 text-text-secondary">{t("common", C.hint)}</p>
      </div>
      {view && (
        <div className="space-y-1 text-xs text-text-secondary">
          <p className="font-bold text-text-primary">
            {t("common", C.inEffect, { days: view.effective.days, size: size(view.effective.bytes), window: view.windowDays })}
          </p>
          <p>{view.own ? t("common", C.own) : t("common", C.platform, { days: view.platform.days, size: size(view.platform.bytes) })}</p>
        </div>
      )}
      {canSet && (
        <>
          <div className="grid gap-2 sm:grid-cols-[8rem_8rem_auto] sm:items-end">
            <Field label={t("common", C.days)}>
              <Input type="text" inputMode="numeric" dir="ltr" value={days} placeholder={view ? String(view.platform.days) : ""} onChange={(e) => setDays(e.target.value)} />
            </Field>
            <Field label={t("common", C.gb)}>
              <Input
                type="text"
                inputMode="decimal"
                dir="ltr"
                value={gb}
                placeholder={view ? String(Number(view.platform.bytes) / GIB) : ""}
                onChange={(e) => setGb(e.target.value)}
              />
            </Field>
            <Button variant="primary" size="sm" disabled={view === null || body === null} onClick={() => void run(body)} loading={busy}>
              {t("common", C.save)}
            </Button>
          </div>
          {view?.own && (
            <Button variant="quiet" size="sm" disabled={busy} onClick={() => void run(null)}>
              {t("common", C.reset)}
            </Button>
          )}
        </>
      )}
      {saved && <p className="text-xs font-bold text-primary">{t("common", C.saved)}</p>}
      {error !== null && <Alert tone="error">{message(error)}</Alert>}
    </section>
  );
}
