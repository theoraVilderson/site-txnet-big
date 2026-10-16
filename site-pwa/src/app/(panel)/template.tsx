"use client";

import { motion } from "framer-motion";
import { RefreshCw } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { RealtimeEvents } from "@/generated/wire";
import { useLiveReread } from "@/hooks/useLiveReread";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { fadeRise } from "@/lib/motion";
import { membersChannel } from "@/lib/realtime";
import { Alert, Button } from "./_components/kit";
import { usePanelSession } from "./_context/PanelSessionContext";
import { UnsavedEditsContext } from "./_hooks/useHoldsUnsavedEdits";

const K = FrontendI18nKeys.common.shell.currencyChanged;

/** Events after which every figure on the page is stale (RT-1-m). */
const REMOUNT_EVENTS = [RealtimeEvents.tenantCurrencyChanged] as const;

/**
 * Every panel page enters with `fadeRise` (UX-1-i, `contract.ux.md` M4). A
 * template, unlike the layout, mounts again on each navigation, which is what
 * replays the entrance. There is no exit, so a navigation never waits on one.
 *
 * RT-1-m: a change of the tenant's operating currency remounts the page, which
 * re-reads on mount (C-14) — wallet, shop, gateways, catalog, packages,
 * analytics and the dashboard follow without a listener of their own. Only an
 * event remounts: a reconnect is not news, and each page already re-reads its
 * own channels on one. While a form holds unsaved edits the page stays and a
 * banner offers the reload instead.
 */
export default function PanelTemplate({ children }: { children: React.ReactNode }) {
  const level = useMotionLevel();
  const { t } = useLocale();
  const { me } = usePanelSession();
  const [generation, setGeneration] = useState(0);
  const [owed, setOwed] = useState(false);
  // A ref, not state: a hold taken or released never needs a render of its own.
  const holds = useRef(0);

  const hold = useCallback(() => {
    holds.current += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds.current -= 1;
    };
  }, []);

  const remount = () => {
    setOwed(false);
    setGeneration((n) => n + 1);
  };

  const tenantId = me?.tenant?.id ?? null;
  useLiveReread(tenantId ? membersChannel(tenantId) : null, REMOUNT_EVENTS, (cause) => {
    if (cause !== "event") return;
    if (holds.current > 0) setOwed(true);
    else remount();
  });

  return (
    <UnsavedEditsContext.Provider value={hold}>
      {owed && (
        <Alert
          tone="warning"
          title={t("common", K.title)}
          className="mb-4"
          action={
            <Button size="sm" onClick={remount} icon={<RefreshCw size={15} aria-hidden />}>
              {t("common", K.reload)}
            </Button>
          }
        >
          {t("common", K.body)}
        </Alert>
      )}
      <motion.div key={generation} variants={fadeRise(level)} initial="hidden" animate="shown">
        {children}
      </motion.div>
    </UnsavedEditsContext.Provider>
  );
}
