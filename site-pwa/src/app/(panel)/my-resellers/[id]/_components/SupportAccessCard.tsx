"use client";

import { useEffect, useState } from "react";
import { History, LifeBuoy, ShieldAlert } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { supportConsentApi, type ConsentScope, type PlatformActivity, type SupportConsentList } from "@/lib/auth-api";
import { Badge } from "../../../financial/_components/Badge";
import { formatInstant } from "../../../_lib/datetime";
import { SUPPORT_KEYS as K, consentSides, hoursOf, supportRefusalKey, timeLeft } from "../../_lib/support-access";
import { Alert, Button, Input, useConfirm } from "../../../_components/kit";

/** `ACTIVITY_PAGE` (auth-service): a full page means there may be an older one. */
const ACTIVITY_PAGE = 50;
const SCOPES: ConsentScope[] = ["read", "act"];

/**
 * The reseller's support-access card on its workspace console (F-117-f,
 * `panel-web/contract.support-access.md`): the platform's open request, a
 * grant on the scope and hours chosen here, a revoke, the default length, the
 * history, the emergency entries and the platform's trail — all from
 * `/auth/tenants/:id/support-consent` for the **path's** reseller.
 *
 *  - **no permission is judged here.** The trail is the reseller's alone; a
 *    `reseller_only` refusal of it means the visitor is platform staff, and the
 *    card then shows nothing (their side: the users pages, F-117-g);
 *  - **the scope defaults to `read`**, whatever the request asked: `act` is
 *    chosen, never inherited;
 *  - **a revoke is asked first**, and takes effect on the platform's next request.
 */
export function SupportAccessCard({ tenantId }: { tenantId: string }) {
  const { t, lang } = useLocale();
  const confirm = useConfirm();
  const errorMessage = useApiErrorMessage();
  const message = (e: unknown) => {
    const key = supportRefusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };

  const [view, setView] = useState<SupportConsentList | null>(null);
  const [trail, setTrail] = useState<PlatformActivity[] | null>(null);
  const [page, setPage] = useState(1);
  const [staff, setStaff] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<ConsentScope>("read");
  const [hours, setHours] = useState("");
  const [policy, setPolicy] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    supportConsentApi.list(tenantId).then(
      (v) => {
        if (!alive) return;
        setView(v);
        setHours(String(v.defaultHours));
        setPolicy(String(v.defaultHours));
      },
      (e) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [tenantId, asked]);

  useEffect(() => {
    let alive = true;
    supportConsentApi.activity(tenantId, page).then(
      (v) => alive && setTrail(v.items),
      (e) => {
        if (!alive) return;
        if ((e as { reason?: unknown } | null)?.reason === "reseller_only") setStaff(true);
        else setError(e);
      },
    );
    return () => {
      alive = false;
    };
  }, [tenantId, page, asked]);

  if (staff) return null;

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await work();
      setAsked((n) => n + 1);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const sides = view ? consentSides(view.items) : null;
  const typedHours = hoursOf(hours);
  const scopeName = (s: string) => (s === "read" || s === "act" ? t("common", K.scope[s].title) : s);
  const when = (iso: string | null) => formatInstant(iso, lang) ?? "";
  const grant = (requestId?: string) =>
    typedHours !== undefined && act(() => supportConsentApi.grant(tenantId, { scope, hours: typedHours, ...(requestId ? { requestId } : {}) }));
  const revoke = async (consentId: string, ask: boolean) => {
    if (ask && !(await confirm({ title: t("common", K.live.confirmRevoke), confirmLabel: t("common", K.live.revoke), tone: "danger" }))) return;
    void act(() => supportConsentApi.revoke(tenantId, consentId));
  };

  const grantForm = (
    <div className="space-y-3">
      <fieldset className="grid gap-2 sm:grid-cols-2">
        {SCOPES.map((s) => (
          <label key={s} className={`flex cursor-pointer items-start gap-2 rounded-xl border p-3 ${scope === s ? "border-primary bg-leaf-bg" : "border-card-border bg-bg-inner"}`}>
            <input type="radio" name={`support-scope-${tenantId}`} aria-label={t("common", K.scope[s].title)} checked={scope === s} onChange={() => setScope(s)} className="mt-1" />
            <span className="space-y-0.5">
              <span className="block text-sm font-bold text-text-primary">{t("common", K.scope[s].title)}</span>
              <span className="block text-[11px] text-text-secondary">{t("common", K.scope[s].hint)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="space-y-1">
        <label htmlFor={`support-hours-${tenantId}`} className="text-xs text-text-secondary">
          {t("common", K.grant.hours)}
        </label>
        <Input id={`support-hours-${tenantId}`} type="text" inputMode="numeric" className="max-w-[8rem]" value={hours} onChange={(e) => setHours(e.target.value)} />
        {hours.trim() !== "" && typedHours === undefined && <p className="text-[11px] text-error">{t("common", K.hoursInvalid)}</p>}
      </div>
    </div>
  );

  return (
    <section className="space-y-4 rounded-2xl border border-card-border bg-card-bg p-5">
      <div className="flex items-center gap-2">
        <LifeBuoy className="h-4 w-4 text-primary" aria-hidden />
        <h2 className="text-sm font-bold text-text-primary">{t("common", K.title)}</h2>
      </div>
      <p className="text-xs text-text-secondary">{t("common", K.subtitle)}</p>
      {error !== null && <Alert tone="error">{message(error)}</Alert>}

      {sides && view && (
        <>
          {sides.pending && (
            <div className="space-y-3 rounded-xl border border-gold/20 bg-gold-bg p-4">
              <h3 className="text-sm font-bold text-text-primary">{t("common", K.pending.title)}</h3>
              {sides.pending.reason && <p className="text-sm text-text-primary">{sides.pending.reason}</p>}
              <p className="text-[11px] text-text-secondary">
                {t("common", K.pending.askedFor, { scope: scopeName(sides.pending.scope) })}
                {sides.pending.requestedAt && ` · ${t("common", K.pending.asked, { date: when(sides.pending.requestedAt) })}`}
              </p>
              {grantForm}
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" size="sm" disabled={busy || typedHours === undefined} onClick={() => grant(sides.pending!.id)}>
                  {t("common", K.pending.approve)}
                </Button>
                <Button variant="quiet" size="sm" disabled={busy} onClick={() => revoke(sides.pending!.id, false)}>
                  {t("common", K.pending.decline)}
                </Button>
              </div>
            </div>
          )}

          {sides.live ? (
            <LiveAccess
              title={t("common", K.live.title, { scope: scopeName(sides.live.scope) })}
              expiresAt={sides.live.expiresAt}
              busy={busy}
              onRevoke={() => revoke(sides.live!.id, true)}
            />
          ) : (
            !sides.pending && (
              <div className="space-y-3 rounded-xl bg-bg-inner p-4">
                <p className="text-sm text-text-secondary">{t("common", K.none)}</p>
                <h3 className="text-sm font-bold text-text-primary">{t("common", K.grant.title)}</h3>
                {grantForm}
                <Button variant="primary" size="sm" disabled={busy || typedHours === undefined} onClick={() => grant()}>
                  {t("common", K.grant.submit)}
                </Button>
              </div>
            )
          )}

          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <label htmlFor={`support-policy-${tenantId}`} className="text-xs text-text-secondary">
                {t("common", K.policy.title)} ({t("common", K.policy.hours)})
              </label>
              <Input id={`support-policy-${tenantId}`} type="text" inputMode="numeric" className="max-w-[8rem]" value={policy} onChange={(e) => setPolicy(e.target.value)} />
            </div>
            <Button
              variant="quiet"
              size="sm"
              disabled={busy || hoursOf(policy) === undefined || hoursOf(policy) === view.defaultHours}
              onClick={() => {
                const h = hoursOf(policy);
                if (h !== undefined) void act(() => supportConsentApi.setPolicy(tenantId, h)).then(() => setSaved(true));
              }}
            >
              {t("common", K.policy.save)}
            </Button>
            {saved && <span className="text-[11px] text-primary">{t("common", K.policy.saved)}</span>}
          </div>

          <div className="space-y-2">
            <h3 className="text-xs font-bold text-text-secondary">{t("common", K.history.title)}</h3>
            {sides.past.length === 0 ? (
              <p className="text-[11px] text-text-secondary">{t("common", K.history.none)}</p>
            ) : (
              <ul className="space-y-1">
                {sides.past.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-bg-inner px-3 py-2 text-xs text-text-primary">
                    <span>{t("common", K.history.line, { scope: scopeName(c.scope), date: when(c.grantedAt ?? c.requestedAt) })}</span>
                    <span className="text-text-secondary">{t("common", K.history.states[c.state])}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-xs font-bold text-text-secondary">
              <ShieldAlert size={14} aria-hidden />
              {t("common", K.emergency.title)}
            </h3>
            <p className="text-[11px] text-text-secondary">{t("common", K.emergency.hint)}</p>
            {view.emergency.length > 0 && (
              <ul className="space-y-1">
                {view.emergency.map((e) => (
                  <li key={e.id} className="space-y-1 rounded-lg border border-gold/20 bg-gold-bg px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-text-primary">{t("common", K.emergency.line, { date: when(e.startedAt) })}</span>
                      <Badge icon={ShieldAlert} className="border-gold/20 bg-gold-bg text-gold" label={t("common", K.emergency.states[e.state])} />
                    </div>
                    <p className="text-text-primary">{e.reason}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {trail && (
        <div className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-xs font-bold text-text-secondary">
            <History size={14} aria-hidden />
            {t("common", K.activity.title)}
          </h3>
          {trail.length === 0 ? (
            <p className="text-[11px] text-text-secondary">{t("common", K.activity.none)}</p>
          ) : (
            <ul className="space-y-1">
              {trail.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-bg-inner px-3 py-2 text-xs">
                  <span dir="ltr" className="font-mono text-[11px] text-text-primary">{a.act}</span>
                  <span className="flex items-center gap-2 text-text-secondary">
                    {(a.tier === "consent" || a.tier === "emergency") && <span>{t("common", K.tiers[a.tier])}</span>}
                    <span>{when(a.at)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {(page > 1 || trail.length === ACTIVITY_PAGE) && (
            <div className="flex gap-2">
              {page > 1 && (
                <Button variant="quiet" size="sm" onClick={() => setPage((p) => p - 1)}>
                  {t("common", K.activity.newer)}
                </Button>
              )}
              {trail.length === ACTIVITY_PAGE && (
                <Button variant="quiet" size="sm" onClick={() => setPage((p) => p + 1)}>
                  {t("common", K.activity.older)}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** A live grant: its scope, what is left of it (rounded up, re-read each minute) and the revoke. */
function LiveAccess({ title, expiresAt, busy, onRevoke }: { title: string; expiresAt: string | null; busy: boolean; onRevoke: () => void }) {
  const { t } = useLocale();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const left = timeLeft(expiresAt, now);
  return (
    <div className="space-y-2 rounded-xl border border-primary/20 bg-leaf-bg p-4">
      <h3 className="text-sm font-bold text-text-primary">{title}</h3>
      <p className="text-xs text-text-primary">{left ? t("common", K.live.left, left) : t("common", K.history.states.expired)}</p>
      <Button variant="primary" size="sm" disabled={busy} onClick={onRevoke}>
        {t("common", K.live.revoke)}
      </Button>
    </div>
  );
}
