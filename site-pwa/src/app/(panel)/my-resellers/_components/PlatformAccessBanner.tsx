"use client";

import { useEffect, useState } from "react";
import { LifeBuoy, ShieldAlert } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { authApi, supportConsentApi, type ConsentScope, type SupportConsentList } from "@/lib/auth-api";
import { holdsPermission } from "@/lib/permissions";
import { tenantApi } from "@/lib/tenant-api";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { Alert, input, primaryButton, quietButton } from "../../catalog/_components/catalog-ui";
import {
  EMERGENCY_REASON_MIN,
  REQUEST_REASON_MIN,
  SUPPORT_KEYS as K,
  consentRefusal,
  consentSides,
  reasonOf,
  staffVisitor,
  supportRefusalKey,
  timeLeft,
} from "../_lib/support-access";
import { useConfirm } from "../../_components/kit";

const SCOPES: ConsentScope[] = ["read", "act"];

/**
 * A users page refused by the door for want of consent (`consent_required` /
 * `consent_read_only`): what to do next, in the page's own tone — not an error
 * with a retry. `null` for any other refusal, which keeps the page's own.
 */
export function ConsentNeeded({ error }: { error: unknown }) {
  const { t } = useLocale();
  const reason = consentRefusal(error);
  if (!reason) return null;
  return (
    <p role="status" className="flex items-start gap-2 rounded-2xl border border-card-border bg-card-bg p-6 text-sm text-text-primary">
      <LifeBuoy size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden />
      {t("common", K.refusals[reason])}
    </p>
  );
}

/**
 * The platform's side of support access, at the top of a reseller's users
 * pages (F-117-g, `panel-web/contract.support-access.md`): the consent's
 * state and time left, a request to the reseller, and the emergency entry.
 *
 *  - **only platform staff see it** (`staffVisitor`): the reseller's own
 *    people, and a platform user who owns this reseller, need no consent;
 *  - **the reseller grants, the platform asks**: no grant here, only a
 *    request, withdrawn while it waits;
 *  - **emergency entry is offered to `tenant.emergency_access` alone, asked
 *    first** — the owner is told at once, and the hour is never extended.
 *
 * `onChange` re-reads the page under it once access may have changed.
 */
export function PlatformAccessBanner({ tenantId, onChange }: { tenantId: string; onChange?: () => void }) {
  const { t } = useLocale();
  const confirm = useConfirm();
  const errorMessage = useApiErrorMessage();
  const message = (e: unknown) => {
    const key = supportRefusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };
  const { me } = usePanelSession();

  const [owned, setOwned] = useState<string[] | null>(null);
  const [view, setView] = useState<SupportConsentList | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<ConsentScope>("read");
  const [why, setWhy] = useState("");
  const [emergencyWhy, setEmergencyWhy] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    authApi.ownedResellers().then(
      (r) => alive && setOwned(r.resellers.map((x) => x.id)),
      () => alive && setOwned([]),
    );
    return () => {
      alive = false;
    };
  }, []);

  const staff = owned !== null && staffVisitor(tenantId, me, owned);

  useEffect(() => {
    if (!staff) return;
    let alive = true;
    supportConsentApi.list(tenantId).then(
      (v) => {
        if (!alive) return;
        setView(v);
        setNow(Date.now());
      },
      (e) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [staff, tenantId, asked]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (!staff) return null;

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      setWhy("");
      setEmergencyWhy("");
      setAsked((n) => n + 1);
      onChange?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const sides = view ? consentSides(view.items) : null;
  const mine = view?.emergency.find((e) => e.state === "live" && e.userId === me?.userId) ?? null;
  const mayEnter = holdsPermission(me?.permissions, "tenant.emergency_access");
  const reason = reasonOf(why, REQUEST_REASON_MIN);
  const emergencyReason = reasonOf(emergencyWhy, EMERGENCY_REASON_MIN);
  const liveLeft = sides?.live ? timeLeft(sides.live.expiresAt, now) : null;
  const mineLeft = mine ? timeLeft(mine.expiresAt, now) : null;

  return (
    <section className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-5">
      <div className="flex items-center gap-2">
        <LifeBuoy className="h-4 w-4 text-primary" aria-hidden />
        <h2 className="text-sm font-bold text-text-primary">{t("common", K.staff.title)}</h2>
      </div>
      {error !== null && <Alert>{message(error)}</Alert>}

      {sides && (
        <>
          {sides.live && (
            <div className="space-y-1 rounded-xl border border-primary/20 bg-leaf-bg p-3">
              <p className="text-sm font-bold text-text-primary">{t("common", K.live.title, { scope: t("common", K.scope[sides.live.scope].title) })}</p>
              <p className="text-xs text-text-primary">{liveLeft ? t("common", K.live.left, liveLeft) : t("common", K.history.states.expired)}</p>
            </div>
          )}
          {sides.pending ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-bg-inner p-3">
              <p className="text-sm text-text-primary">{t("common", K.staff.pending)}</p>
              <button type="button" className={quietButton} disabled={busy} onClick={() => void act(() => supportConsentApi.revoke(tenantId, sides.pending!.id))}>
                {t("common", K.staff.withdraw)}
              </button>
            </div>
          ) : (
            // No access, or one that only reads: ask (again) — `act` is the reseller's to give.
            (!sides.live || sides.live.scope === "read") && (
            <div className="space-y-3 rounded-xl bg-bg-inner p-3">
              {!sides.live && <p className="text-sm text-text-primary">{t("common", K.staff.none)}</p>}
              <h3 className="text-xs font-bold text-text-secondary">{t("common", K.staff.request.title)}</h3>
              <fieldset className="grid gap-2 sm:grid-cols-2">
                {SCOPES.map((s) => (
                  <label key={s} className={`flex cursor-pointer items-start gap-2 rounded-xl border p-3 ${scope === s ? "border-primary bg-leaf-bg" : "border-card-border bg-card-bg"}`}>
                    <input type="radio" name={`staff-scope-${tenantId}`} aria-label={t("common", K.scope[s].title)} checked={scope === s} onChange={() => setScope(s)} className="mt-1" />
                    <span className="space-y-0.5">
                      <span className="block text-sm font-bold text-text-primary">{t("common", K.scope[s].title)}</span>
                      <span className="block text-[11px] text-text-secondary">{t("common", K.scope[s].hint)}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <label htmlFor={`staff-why-${tenantId}`} className="block text-xs text-text-secondary">
                {t("common", K.staff.request.reason)}
              </label>
              <textarea id={`staff-why-${tenantId}`} rows={2} maxLength={500} className={input} value={why} onChange={(e) => setWhy(e.target.value)} />
              <button type="button" className={primaryButton} disabled={busy || reason === null} onClick={() => reason && void act(() => supportConsentApi.request(tenantId, { scope, reason }))}>
                {t("common", K.staff.request.submit)}
              </button>
            </div>
            )
          )}

          {mine ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-gold/20 bg-gold-bg p-3">
              <p className="flex items-center gap-1.5 text-sm text-text-primary">
                <ShieldAlert size={14} className="text-gold" aria-hidden />
                {mineLeft ? t("common", K.staff.emergency.live, mineLeft) : t("common", K.emergency.states.expired)}
              </p>
              <button type="button" className={quietButton} disabled={busy} onClick={() => void act(() => supportConsentApi.endEmergency(tenantId, mine.id))}>
                {t("common", K.staff.emergency.end)}
              </button>
            </div>
          ) : (
            mayEnter && (
              <details className="rounded-xl border border-card-border p-3">
                <summary className="cursor-pointer text-xs font-bold text-text-secondary">{t("common", K.staff.emergency.title)}</summary>
                <div className="mt-3 space-y-2">
                  <p className="text-[11px] text-text-secondary">{t("common", K.staff.emergency.hint)}</p>
                  <label htmlFor={`staff-emergency-${tenantId}`} className="block text-xs text-text-secondary">
                    {t("common", K.staff.emergency.reason)}
                  </label>
                  <textarea id={`staff-emergency-${tenantId}`} rows={2} maxLength={500} className={input} value={emergencyWhy} onChange={(e) => setEmergencyWhy(e.target.value)} />
                  <button
                    type="button"
                    className={primaryButton}
                    disabled={busy || emergencyReason === null}
                    onClick={async () => {
                      if (!emergencyReason) return;
                      // K9: the reseller's slug is typed; the id stands in when its record cannot be read.
                      const slug = await tenantApi.reseller(tenantId).then((r) => r.slug, () => tenantId);
                      const sure = await confirm({ title: t("common", K.staff.emergency.confirm), confirmLabel: t("common", K.staff.emergency.submit), tone: "danger", typeToConfirm: slug });
                      if (!sure) return;
                      void act(() => supportConsentApi.enterEmergency(tenantId, emergencyReason));
                    }}
                  >
                    {t("common", K.staff.emergency.submit)}
                  </button>
                </div>
              </details>
            )
          )}
        </>
      )}
    </section>
  );
}
