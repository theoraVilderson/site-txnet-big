"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useLiveReread } from "@/hooks/useLiveReread";
import { resellerOnboardingApi } from "@/lib/tenant-onboarding-api";
import { usePanelSession } from "../_context/PanelSessionContext";
import { celebrate } from "../_components/kit/celebrate";
import { notify } from "../_components/kit/notify";
import { DOMAIN_LIVE_EVENTS, domainLiveChannels } from "../my-resellers/_lib/domains";
import { gateOpened, setupProgress, type SetupProgress } from "../my-resellers/_lib/setup";

const K = FrontendI18nKeys.common.resellerOnboarding;

/**
 * How far the reseller in play is set up (UX-2-e), for the menu's setup row
 * — read once per reseller, again on `tenant.domain.changed` (C-14: the
 * event, never a poll) and whenever a page that saved something asks
 * (`reread`). A failed read keeps the last answer: the row is a hint.
 *
 * When the gate lifts between two answers this view saw, it is celebrated
 * once (M5): the confetti and a toast saying the reseller is open.
 */
export function useResellerSetup(id: string | null): { setup: SetupProgress | null; reread: () => void } {
  const { t } = useLocale();
  const { me, group } = usePanelSession();
  const [answer, setAnswer] = useState<{ id: string; setup: SetupProgress } | null>(null);
  const last = useRef<{ id: string; setup: SetupProgress } | null>(null);
  // The toast's words at the moment it is shown; a new `t` is not a reason to read again.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  });

  const reread = useCallback(() => {
    if (!id) return;
    resellerOnboardingApi.get(id).then(
      (v) => {
        const next = setupProgress(v);
        const before = last.current?.id === id ? last.current.setup : null;
        last.current = { id, setup: next };
        setAnswer({ id, setup: next });
        if (gateOpened(before, next)) {
          celebrate();
          notify.success(tRef.current("common", K.opened));
        }
      },
      () => undefined,
    );
  }, [id]);

  useEffect(() => {
    reread();
  }, [reread]);

  const [own, platform] = domainLiveChannels(id ? (group?.current.userId ?? null) : null, id ? me : null);
  useLiveReread(own, DOMAIN_LIVE_EVENTS, reread);
  useLiveReread(platform, DOMAIN_LIVE_EVENTS, reread);

  return { setup: answer && answer.id === id ? answer.setup : null, reread };
}
