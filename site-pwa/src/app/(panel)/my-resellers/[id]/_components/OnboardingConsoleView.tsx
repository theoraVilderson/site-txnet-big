"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, Circle, Clock, DoorClosed, DoorOpen, Palette, RefreshCw, Users } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { authApi } from "@/lib/auth-api";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { myResellerBrandingPath, myResellerUsersPath } from "@/lib/routes";
import { resellerOnboardingApi, type ResellerOnboarding } from "@/lib/tenant-api";
import { TableSkeleton } from "../../../_components/kit/TableSkeleton";
import { Badge } from "../../../financial/_components/Badge";
import { Alert, primaryButton, quietButton } from "../../../catalog/_components/catalog-ui";
import {
  CLOSED_CAPABILITY_KEYS,
  ONBOARDING_KEYS as K,
  STEP_KEYS,
  consoleState,
  onboardingRefusalKey,
  splitSteps,
  stepHref,
  type ClosedCapability,
} from "../../_lib/onboarding";

const USERS = FrontendI18nKeys.common.resellerUsers.moreUsers;

type Step = ResellerOnboarding["steps"][number];

/**
 * A reseller's onboarding console (F-066-w, `panel-web/contract.resellers.md`
 * "A reseller's workspace"). By the reseller the path names, never the
 * session's tenant (ADR-0064).
 *
 *  - **the gate is said, not implied.** Only the `gate` step closes anything,
 *    so it stands alone under "required to open", with the capabilities the
 *    route says are closed; the other three are "recommended" and refuse
 *    nothing — a reseller may open with no bot;
 *  - **not a suspension.** `tenantOnboarding` is what the reseller's own users
 *    are refused with; this page explains it in the gate's tone, never the
 *    suspended one;
 *  - **every step from the route, as it came.** Nothing is inferred or stored.
 */
export function OnboardingConsoleView({ id }: { id: string }) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const message = (e: unknown) => {
    const key = onboardingRefusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };

  const [view, setView] = useState<ResellerOnboarding | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const retry = () => {
    setLoadError(null);
    setAsked((n) => n + 1);
  };

  useEffect(() => {
    let alive = true;
    resellerOnboardingApi
      .get(id)
      .then((v) => alive && setView(v))
      .catch((e) => alive && setLoadError(e));
    return () => {
      alive = false;
    };
  }, [id, asked]);

  // The name for the title, when the visitor owns it; staff see the plain title.
  useEffect(() => {
    let alive = true;
    authApi
      .ownedResellers()
      .then((r) => alive && setSlug(r.resellers.find((x) => x.id === id)?.slug ?? null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id]);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary md:text-3xl">
            {slug ? t("common", K.title, { slug }) : t("common", K.titlePlain)}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">{t("common", K.subtitle)}</p>
        </div>
        <button type="button" className={quietButton} onClick={retry}>
          <RefreshCw size={12} aria-hidden />
          {t("common", K.refresh)}
        </button>
      </header>

      {loadError !== null ? (
        <div className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-6">
          <Alert>{message(loadError)}</Alert>
          <button type="button" className={primaryButton} onClick={retry}>
            {t("common", K.reload)}
          </button>
        </div>
      ) : view === null ? (
        <TableSkeleton rows={4} columns={2} />
      ) : (
        <Console id={id} view={view} />
      )}
    </div>
  );
}

function Console({ id, view }: { id: string; view: ResellerOnboarding }) {
  const { t } = useLocale();
  const state = consoleState(view);
  const { gate, rest } = splitSteps(view);
  const closed = view.closed.filter((c): c is ClosedCapability => c in CLOSED_CAPABILITY_KEYS);

  return (
    <>
      {state === "closed" ? (
        <section className="space-y-3 rounded-2xl border border-gold/20 bg-gold-bg p-6">
          <h2 className="flex items-center gap-2 text-base font-bold text-text-primary">
            <DoorClosed size={18} className="shrink-0 text-gold" aria-hidden />
            {t("common", K.state.closed.title)}
          </h2>
          <p className="text-sm text-text-primary">{t("common", K.state.closed.body)}</p>
          <ul className="list-inside list-disc text-sm text-text-primary">
            {closed.map((c) => (
              <li key={c}>{t("common", CLOSED_CAPABILITY_KEYS[c])}</li>
            ))}
          </ul>
          <p className="text-xs text-text-secondary">{t("common", K.state.closed.note)}</p>
        </section>
      ) : (
        <section className="space-y-2 rounded-2xl border border-primary/20 bg-leaf-bg p-6">
          <h2 className="flex items-center gap-2 text-base font-bold text-text-primary">
            <DoorOpen size={18} className="shrink-0 text-primary" aria-hidden />
            {t("common", K.state[state].title)}
          </h2>
          <p className="text-sm text-text-secondary">{t("common", K.state[state].body)}</p>
        </section>
      )}

      {gate && (
        <div className="space-y-3">
          <h2 className="text-sm font-bold text-text-secondary">{t("common", K.required)}</h2>
          <StepCard id={id} step={gate} />
        </div>
      )}

      {rest.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-bold text-text-secondary">{t("common", K.recommended)}</h2>
          {rest.map((s) => (
            <StepCard key={s.key} id={id} step={s} />
          ))}
        </div>
      )}

      {/* Not a step: nothing waits on it, and it is never "done". */}
      <div className="space-y-3">
        <h2 className="text-sm font-bold text-text-secondary">{t("common", K.more.title)}</h2>
        <section className="flex flex-col gap-3 rounded-2xl border border-card-border bg-card-bg p-5 md:flex-row md:items-center md:justify-between">
          <div className="flex items-start gap-3">
            <Palette size={20} className="mt-0.5 shrink-0 text-primary" aria-hidden />
            <div className="space-y-1">
              <h3 className="text-base font-bold text-text-primary">{t("common", K.more.branding.title)}</h3>
              <p className="text-xs text-text-secondary">{t("common", K.more.branding.hint)}</p>
            </div>
          </div>
          <Link href={myResellerBrandingPath(id)} className={quietButton}>
            {t("common", K.open)}
            <ArrowLeft size={12} className="ltr:rotate-180" aria-hidden />
          </Link>
        </section>
        <section className="flex flex-col gap-3 rounded-2xl border border-card-border bg-card-bg p-5 md:flex-row md:items-center md:justify-between">
          <div className="flex items-start gap-3">
            <Users size={20} className="mt-0.5 shrink-0 text-primary" aria-hidden />
            <div className="space-y-1">
              <h3 className="text-base font-bold text-text-primary">{t("common", USERS.title)}</h3>
              <p className="text-xs text-text-secondary">{t("common", USERS.hint)}</p>
            </div>
          </div>
          <Link href={myResellerUsersPath(id)} className={quietButton}>
            {t("common", K.open)}
            <ArrowLeft size={12} className="ltr:rotate-180" aria-hidden />
          </Link>
        </section>
      </div>
    </>
  );
}

function StepCard({ id, step }: { id: string; step: Step }) {
  const { t } = useLocale();
  const href = stepHref(step.key, id);
  const keys = STEP_KEYS[step.key];

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-card-border bg-card-bg p-5 md:flex-row md:items-center md:justify-between">
      <div className="flex items-start gap-3">
        {step.done ? (
          <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-primary" aria-hidden />
        ) : (
          <Circle size={20} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden />
        )}
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-bold text-text-primary">{t("common", keys.title)}</h3>
            {step.done ? (
              <Badge icon={CheckCircle2} className="border-primary/20 bg-leaf-bg text-primary" label={t("common", K.done)} />
            ) : (
              <Badge icon={Clock} className="border-card-border bg-card-bg text-text-secondary" label={t("common", K.todo)} />
            )}
          </div>
          <p className="text-xs text-text-secondary">{t("common", keys.hint)}</p>
          {!href && !step.done && <p className="text-[11px] text-text-secondary">{t("common", K.notYet)}</p>}
        </div>
      </div>
      {href && (
        <Link href={href} className={step.done ? quietButton : primaryButton}>
          {t("common", K.open)}
          <ArrowLeft size={12} className="ltr:rotate-180" aria-hidden />
        </Link>
      )}
    </section>
  );
}
