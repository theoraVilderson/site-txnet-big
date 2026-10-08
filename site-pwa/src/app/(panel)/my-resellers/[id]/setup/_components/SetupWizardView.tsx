"use client";

import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Palette, PartyPopper, type LucideIcon } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { useLiveReread } from "@/hooks/useLiveReread";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { authApi } from "@/lib/auth-api";
import { DURATION, EASE } from "@/lib/motion";
import { myResellerConsolePath } from "@/lib/routes";
import { resellerOnboardingApi, type ResellerOnboarding } from "@/lib/tenant-api";
import { usePanelSession } from "../../../../_context/PanelSessionContext";
import { TableSkeleton } from "../../../../_components/kit/TableSkeleton";
import { useWizard } from "../../../../_components/kit/Wizard";
import { cn } from "../../../../_components/kit/cn";
import { Alert, Button, PageHeader, buttonClass } from "../../../../_components/kit";
import { DOMAIN_LIVE_EVENTS, domainLiveChannels } from "../../../_lib/domains";
import { ONBOARDING_KEYS as K, STEP_KEYS, onboardingRefusalKey } from "../../../_lib/onboarding";
import { SETUP_STEP_ICONS, firstUndoneIndex, setupSlide } from "../../../_lib/setup";
import { useWorkspaceSelf } from "../../../_lib/workspace";
import { BotPanel } from "../../bot/_components/ResellerBotView";
import { BrandingPanel } from "../../branding/_components/ResellerBrandingView";
import { ResellerCatalogView } from "../../catalog/_components/ResellerCatalogView";
import { DomainsPanel } from "../../domains/_components/ResellerDomainsView";
import { ResellerGatewaysView } from "../../gateways/_components/ResellerGatewaysView";

const W = K.wizard;

// The catalog is the heaviest screen and only the pricing step needs it.
const CatalogView = lazy(() => import("../../../../catalog/_components/CatalogView").then((m) => ({ default: m.CatalogView })));

type Step = ResellerOnboarding["steps"][number];

/**
 * A reseller's setup wizard (UX-2-c, F-213, `contract.reseller-workspace.md`
 * "The setup wizard"). The onboarding route's steps one at a time, in its
 * order, by the reseller the path names (ADR-0064).
 *
 *  - **where it opens is the checklist's answer.** The first step not done;
 *    "later" leaves and stores nothing (user, 2026-10-08);
 *  - **the progress bar is the route's count**, steps done of all of them —
 *    the same figure the home draws, never a step index;
 *  - **it follows the sweep live**: `tenant.domain.changed` re-reads the
 *    checklist quietly (C-14), so a domain verified while the page is open
 *    says so without a refresh;
 *  - **a page, not the kit's dialog** (K12): nothing is submitted at the end —
 *    each step's own screen saves itself — so it uses `useWizard` for the
 *    step and the direction, and draws its own frame;
 *  - **each step is its screen's own form** (UX-2-d): the domains, gateways,
 *    bot and catalog bodies, embedded; a save there, and every move between
 *    steps, re-reads the checklist quietly;
 *  - **the brand screen comes last and counts toward nothing** — not a route
 *    step; a fully set-up reseller lands on it, under the finished screen.
 */
export function SetupWizardView({ id }: { id: string }) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const self = useWorkspaceSelf(id);
  const message = (e: unknown) => {
    const key = onboardingRefusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };

  const [view, setView] = useState<ResellerOnboarding | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);

  // A live event or a save is a hint: re-read with no skeleton, keep the
  // screen on a failure.
  const quietRead = useCallback(() => {
    resellerOnboardingApi.get(id).then(setView, () => undefined);
  }, [id]);

  // The route's steps, then the brand screen.
  const wizard = useWizard({ count: (view?.steps.length ?? 0) + 1 });

  // Placed once, on the first answer — the first undone step, or the brand
  // screen when none is left; a re-read after it never moves the person.
  const placed = useRef(false);
  const goTo = useRef(wizard.goTo);
  goTo.current = wizard.goTo;
  useEffect(() => {
    if (!view || placed.current) return;
    placed.current = true;
    const first = view.complete ? view.steps.length : firstUndoneIndex(view.steps);
    if (first > 0) goTo.current(first);
  }, [view]);

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

  const { me, group } = usePanelSession();
  const [own, platform] = domainLiveChannels(group?.current.userId ?? null, me);
  useLiveReread(own, DOMAIN_LIVE_EVENTS, quietRead);
  useLiveReread(platform, DOMAIN_LIVE_EVENTS, quietRead);

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

  const home = myResellerConsolePath(id, self);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-8">
      <PageHeader
        title={slug ? t("common", W.titleSlug, { slug }) : t("common", W.title)}
        subtitle={t("common", W.subtitle)}
        actions={
          <Link href={home} className={buttonClass({ variant: "quiet", size: "sm" })}>
            {t("common", W.later)}
          </Link>
        }
      />

      {loadError !== null ? (
        <div className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-6">
          <Alert tone="error">{message(loadError)}</Alert>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setLoadError(null);
              setAsked((n) => n + 1);
            }}
          >
            {t("common", K.reload)}
          </Button>
        </div>
      ) : view === null ? (
        <TableSkeleton rows={4} columns={2} />
      ) : (
        <>
          <SetupProgress view={view} />
          {view.complete && <Finished home={home} />}
          <Steps id={id} view={view} wizard={wizard} home={home} onChanged={quietRead} />
        </>
      )}
    </div>
  );
}

/** Steps done of all of them, as the route counts — the home's own figure (UX-2-b). */
function SetupProgress({ view }: { view: ResellerOnboarding }) {
  const { t } = useLocale();
  const reduced = useMotionLevel() === "reduced";
  const total = view.steps.length;
  const done = view.steps.filter((s) => s.done).length;
  if (total === 0) return null;
  const label = t("common", K.progress, { done, total });
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-text-secondary">{label}</p>
      <div
        className="h-2 overflow-hidden rounded-full bg-leaf-bg"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
      >
        <motion.div
          className="h-full rounded-full bg-primary"
          initial={false}
          animate={{ width: `${(done / total) * 100}%` }}
          transition={{ duration: reduced ? 0 : DURATION.slow, ease: EASE.standard }}
        />
      </div>
    </div>
  );
}

function Steps({
  id,
  view,
  wizard,
  home,
  onChanged,
}: {
  id: string;
  view: ResellerOnboarding;
  wizard: ReturnType<typeof useWizard>;
  home: string;
  onChanged: () => void;
}) {
  const { t, isRtl } = useLocale();
  const level = useMotionLevel();
  const { index, direction } = wizard;
  const steps = view.steps;
  const brandAt = steps.length;
  const step = index < brandAt ? steps[index] : null;
  const BackIcon = isRtl ? ArrowRight : ArrowLeft;
  const NextIcon = isRtl ? ArrowLeft : ArrowRight;
  // The person's own move re-reads the checklist: a step's screen may have
  // saved something no event reports. The first placement does not.
  const move = (to: number) => {
    wizard.goTo(to);
    onChanged();
  };

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      {/* The rail: every step, done or not — none waits on another — then the brand. */}
      <nav aria-label={t("common", W.title)} className="lg:w-60 lg:shrink-0">
        <ol className="flex gap-2 overflow-x-auto lg:flex-col">
          {steps.map((s, i) => (
            <RailItem
              key={s.key}
              icon={SETUP_STEP_ICONS[s.key]}
              label={t("common", STEP_KEYS[s.key].title)}
              done={s.done}
              current={i === index}
              onClick={() => move(i)}
            />
          ))}
          <RailItem icon={Palette} label={t("common", W.brand.title)} done={false} optional current={index === brandAt} onClick={() => move(brandAt)} />
        </ol>
      </nav>

      <section className="min-w-0 flex-1 overflow-hidden rounded-2xl border border-card-border bg-card-bg">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step?.key ?? "brand"}
            initial={setupSlide(level, direction, isRtl)}
            animate={{ x: 0, opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: level === "reduced" ? DURATION.fast : DURATION.base, ease: EASE.standard }}
            className="flex flex-col gap-5 p-4 sm:p-6"
          >
            {step ? (
              <>
                <StepHead step={step} index={index} total={steps.length} />
                <StepBody id={id} step={step} onChanged={onChanged} />
              </>
            ) : (
              <>
                <BrandHead />
                <BrandingPanel id={id} />
              </>
            )}
          </motion.div>
        </AnimatePresence>

        <footer className="flex items-center justify-between gap-2 border-t border-card-border px-4 py-3 sm:px-6">
          {index > 0 ? (
            <Button variant="quiet" icon={<BackIcon size={16} aria-hidden />} onClick={() => move(index - 1)}>
              {t("common", W.back)}
            </Button>
          ) : (
            <span />
          )}
          {step ? (
            <Button variant={step.done ? "primary" : "quiet"} iconEnd={<NextIcon size={16} aria-hidden />} onClick={() => move(index + 1)}>
              {t("common", step.done ? W.next : W.skip)}
            </Button>
          ) : (
            <Link href={home} className={buttonClass({ variant: "primary" })}>
              {t("common", W.finished.home)}
            </Link>
          )}
        </footer>
      </section>
    </div>
  );
}

function RailItem({
  icon: Icon,
  label,
  done,
  current,
  optional = false,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  done: boolean;
  current: boolean;
  optional?: boolean;
  onClick: () => void;
}) {
  return (
    <li className="shrink-0">
      <button
        type="button"
        onClick={onClick}
        aria-current={current ? "step" : undefined}
        className={cn(
          "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-start transition-colors",
          current ? "bg-card-bg shadow-sm" : "hover:bg-card-bg/60",
        )}
      >
        <span
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-full border text-xs font-bold",
            optional && "border-dashed",
            done
              ? "border-transparent bg-primary text-on-accent"
              : current
                ? "border-[var(--accent-primary)] bg-[var(--leaf-bg)] text-primary"
                : "border-card-border text-text-secondary",
          )}
        >
          {done ? <Check size={14} aria-hidden /> : <Icon size={14} aria-hidden />}
        </span>
        <span className={cn("text-xs font-bold", current || done ? "text-text-primary" : "text-text-secondary")}>{label}</span>
      </button>
    </li>
  );
}

function StepHead({ step, index, total }: { step: Step; index: number; total: number }) {
  const { t } = useLocale();
  const Icon = SETUP_STEP_ICONS[step.key];
  return (
    <div className="flex items-start gap-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--leaf-bg)] text-primary">
        <Icon size={20} aria-hidden />
      </span>
      <div className="min-w-0 space-y-1">
        <p className="text-[11px] font-bold text-text-secondary">
          {t("common", W.stepOf, { current: String(index + 1), total: String(total) })} · {t("common", step.gate ? W.required : W.optional)}
        </p>
        <h2 className="text-base font-bold text-text-primary">{t("common", STEP_KEYS[step.key].title)}</h2>
        <p className="text-xs text-text-secondary">{t("common", STEP_KEYS[step.key].hint)}</p>
        {step.done && step.key !== "domain" && (
          <p className="flex items-center gap-1.5 text-xs font-bold text-primary">
            <CheckCircle2 size={14} aria-hidden />
            {t("common", W.stepDone)}
          </p>
        )}
      </div>
    </div>
  );
}

/** The step's own screen, inside the wizard, by the path's reseller (UX-2-d). */
function StepBody({ id, step, onChanged }: { id: string; step: Step; onChanged: () => void }) {
  switch (step.key) {
    case "domain":
      return <DomainStep id={id} done={step.done} />;
    case "gateway":
      return <ResellerGatewaysView id={id} embedded onChanged={onChanged} />;
    case "bot":
      return (
        <div className="space-y-6">
          <BotPanel id={id} onChanged={onChanged} />
        </div>
      );
    case "pricing":
      return (
        <ResellerCatalogView id={id} embedded onChanged={onChanged}>
          <Suspense fallback={<TableSkeleton rows={4} columns={3} />}>
            <CatalogView />
          </Suspense>
        </ResellerCatalogView>
      );
  }
}

/** Not a route step: what it is, and that it counts toward nothing. */
function BrandHead() {
  const { t } = useLocale();
  return (
    <div className="flex items-start gap-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--leaf-bg)] text-primary">
        <Palette size={20} aria-hidden />
      </span>
      <div className="min-w-0 space-y-1">
        <p className="text-[11px] font-bold text-text-secondary">{t("common", W.brand.optional)}</p>
        <h2 className="text-base font-bold text-text-primary">{t("common", W.brand.title)}</h2>
        <p className="text-xs text-text-secondary">{t("common", W.brand.hint)}</p>
      </div>
    </div>
  );
}

/** The domains page's own body (F-066-w2), and what the gate says about it now. */
function DomainStep({ id, done }: { id: string; done: boolean }) {
  const { t } = useLocale();
  return (
    <div className="space-y-4">
      {done ? (
        <Alert tone="success">{t("common", W.domainOpen)}</Alert>
      ) : (
        <Alert tone="info">{t("common", W.domainWaiting)}</Alert>
      )}
      <DomainsPanel id={id} />
    </div>
  );
}

function Finished({ home }: { home: string }) {
  const { t } = useLocale();
  return (
    <section className="space-y-3 rounded-2xl border border-primary/20 bg-leaf-bg p-6">
      <h2 className="flex items-center gap-2 text-base font-bold text-text-primary">
        <PartyPopper size={18} className="shrink-0 text-primary" aria-hidden />
        {t("common", W.finished.title)}
      </h2>
      <p className="text-sm text-text-secondary">{t("common", W.finished.body)}</p>
      <Link href={home} className={buttonClass({ variant: "primary", size: "sm" })}>
        {t("common", W.finished.home)}
      </Link>
    </section>
  );
}
