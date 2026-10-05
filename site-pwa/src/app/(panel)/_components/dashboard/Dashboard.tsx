"use client";

import { motion, type Target, type Transition, type Variants } from "framer-motion";
import { EyeOff, LayoutGrid } from "lucide-react";
import { useMemo, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { fadeRise, staggerDelay, type MotionLevel } from "@/lib/motion";
import { useUiPreferences } from "@/stores/ui-preferences-store";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { useVisibleMenu } from "../../_hooks/useVisibleMenu";
import { isMenuGroup } from "../../_lib/panel-menu";
import { WIDGETS, dashboardLayout, layoutToSave, timeOfDay, visibleWidgets, type DashboardLayout } from "../../_lib/widgets";
import { Button, EmptyState, PageHeader } from "../kit";
import { Skeleton } from "../kit/Skeleton";
import { LayoutEditor } from "./LayoutEditor";
import { forbiddenKey, useDashboardStore } from "./useWidgetSource";
import { WidgetFrame } from "./WidgetFrame";

const C = FrontendI18nKeys.common;
const D = C.dashboard;

/** `fadeRise` with the widget's place in the stagger (D1); a variant's own transition outranks the prop's. */
function staggered(level: MotionLevel, index: number): Variants {
  const { hidden, shown } = fadeRise(level) as { hidden: Target; shown: Target & { transition?: Transition } };
  return { hidden, shown: { ...shown, transition: { ...shown.transition, delay: staggerDelay(index, level) } } };
}

const NOTHING_SAVED: DashboardLayout = { order: [], hidden: [] };

/**
 * The panel's home (UX-1-p, `contract.ux.md` D1–D3): a greeting, then the
 * widgets the caller may see in their saved layout, on a grid of 1, 2 and 3
 * columns. "Edit layout" swaps the grid for the editor; Done writes
 * `ui.dashboard` through the preferences store (P4).
 */
export function Dashboard() {
  const { t } = useLocale();
  const { me, group, timeZone, isLoading } = usePanelSession();
  const menu = useVisibleMenu();
  const level = useMotionLevel();
  const saved = useUiPreferences((s) => s.prefs["ui.dashboard"]);
  const update = useUiPreferences((s) => s.update);
  const forbidden = useDashboardStore((s) => s.forbidden);
  const userId = group?.current.userId ?? null;

  const widgets = useMemo(() => {
    const menuIds = new Set(menu.flatMap((e) => (isMenuGroup(e) ? [e.id, ...e.children.map((c) => c.id)] : [e.id])));
    const gate = { held: me?.permissions ?? [], tenantType: me?.tenant.type ?? null, isOwner: me?.tenant.isOwner ?? false, menuIds };
    return visibleWidgets(WIDGETS, gate).filter((w) => !forbidden[forbiddenKey(userId, w.id)]);
  }, [menu, me, forbidden, userId]);
  const ids = useMemo(() => widgets.map((w) => w.id), [widgets]);
  const layout = useMemo(() => dashboardLayout(ids, saved), [ids, saved]);
  const byId = useMemo(() => new Map(widgets.map((w) => [w.id, w])), [widgets]);
  const titleOf = (id: string) => t("common", byId.get(id)?.titleKey ?? id);

  const [draft, setDraft] = useState<DashboardLayout | null>(null);
  /** "Back to default" pressed and nothing moved since: Done writes nothing saved at all. */
  const [toDefault, setToDefault] = useState(false);

  if (isLoading || !group) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6">
        <Skeleton className="h-9 w-64" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      </div>
    );
  }

  const done = () => {
    if (draft) update({ "ui.dashboard": toDefault ? NOTHING_SAVED : layoutToSave(saved, WIDGETS.map((w) => w.id), draft) });
    setDraft(null);
  };
  const shown = layout.order.filter((id) => !layout.hidden.includes(id));

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6">
      <PageHeader
        title={t("common", D.greeting[timeOfDay(new Date(), timeZone?.zone ?? null)], { name: group.current.fullName })}
        subtitle={
          <>
            {t("common", C.accounts.signedInAs)}{" "}
            <span dir="ltr">{group.current.phoneMasked}</span>
          </>
        }
        actions={
          draft ? null : (
            <Button variant="secondary" icon={<LayoutGrid size={16} aria-hidden />} onClick={() => (setToDefault(false), setDraft(layout))}>
              {t("common", D.edit)}
            </Button>
          )
        }
      />

      {draft ? (
        <LayoutEditor
          draft={draft}
          titleOf={titleOf}
          onChange={(next) => (setToDefault(false), setDraft(next))}
          onReset={() => (setToDefault(true), setDraft(dashboardLayout(ids, NOTHING_SAVED)))}
          onDone={done}
        />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={EyeOff}
          title={t("common", D.allHidden)}
          body={t("common", D.allHiddenBody)}
          action={<Button onClick={() => setDraft(layout)}>{t("common", D.edit)}</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((id, i) => {
            const w = byId.get(id)!;
            const Body = w.component;
            return (
              <motion.div
                key={id}
                variants={staggered(level, i)}
                initial="hidden"
                animate="shown"
                className={w.size === 2 ? "md:col-span-2" : undefined}
              >
                <WidgetFrame title={titleOf(id)}>
                  <Body />
                </WidgetFrame>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}
