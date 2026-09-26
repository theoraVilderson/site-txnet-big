"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Server } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type PanelGroup, type SystemsPanel } from "@/lib/billing-api";
import { LIVE_REREAD_MS, trailingThrottle } from "@/lib/realtime";
import { usePanelRealtime } from "../../_context/PanelRealtimeContext";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { SYSTEMS_KEYS as K, isPanelTested, liveChannelOf } from "../_lib/systems";
import { DriftReport } from "./DriftReport";
import { HoldsQueue } from "./HoldsQueue";
import { PanelGroups } from "./PanelGroups";
import { PanelList } from "./PanelList";
import { HolderNamesContext } from "./parts";
import { RegisterPanel } from "./RegisterPanel";

/**
 * The systems page (F-027-ad, ADR-0080): register a panel, read what its
 * connection test answered, its health and request budget, the panel groups
 * a VPN variant is sold on (F-027-bx), the drift report and the holds queue.
 *
 * **Everything shown is what `network-service` last wrote.** Billing reads
 * columns and never calls the Go service (ADR-0071), so a registered panel
 * reads `pending` until the next tick tests it, and nothing here says
 * otherwise. A test's answer arrives without a reload (F-027-bs): the socket
 * says a row changed and the page reads it again, at most once per 2 s (F-067-p). The holds queue is the visible face of *in doubt, do not charge*:
 * while anything sits in it, nothing was dropped silently.
 */
export function SystemsView() {
  const { t } = useLocale();
  const [panels, setPanels] = useState<SystemsPanel[]>([]);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [groups, setGroups] = useState<PanelGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [groupsError, setGroupsError] = useState<unknown>(null);

  const reloadPanels = useCallback(async () => {
    try {
      setPanels(await billingApi.systemsPanels());
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  const reloadGroups = useCallback(async () => {
    try {
      setGroups(await billingApi.panelGroups());
      setGroupsError(null);
    } catch (e) {
      setGroupsError(e);
    } finally {
      setGroupsLoading(false);
    }
  }, []);

  // A member's pills are its panel's health, so whatever re-reads the panels re-reads the groups.
  const reload = useCallback(async () => {
    await Promise.all([reloadPanels(), reloadGroups()]);
  }, [reloadPanels, reloadGroups]);

  useEffect(() => {
    // Every setState in reload runs after its first await, as in `useGateways`.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const { me } = usePanelSession();
  const client = usePanelRealtime();
  const channel = liveChannelOf(me);
  // `reload` is stable (its deps are), so this subscribes once per socket and
  // channel — a channel dropped and re-declared is a window where an event is lost.
  // A burst of tests is one read now and one at the end (F-067-p), not one per event.
  useEffect(() => {
    if (!client || !channel) return;
    const live = trailingThrottle(() => void reload(), LIVE_REREAD_MS);
    const unsubscribe = client.subscribe(channel, {
      onMessage: (payload) => {
        if (isPanelTested(payload)) live.call();
      },
    });
    return () => {
      live.cancel();
      unsubscribe();
    };
  }, [client, channel, reload]);

  // A refusal names its holder from these (F-027-ci): billing sends only ids, and only inside this reader's scope.
  const names = useMemo(
    () => ({
      panel: (id: string) => panels.find((p) => p.id === id)?.name ?? null,
      group: (id: string) => groups.find((g) => g.id === id)?.name ?? null,
    }),
    [panels, groups],
  );

  return (
    <HolderNamesContext.Provider value={names}>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-bold text-text-primary">
              <Server size={18} className="text-primary" aria-hidden />
              {t("common", K.title)}
            </h1>
            <p className="text-xs leading-5 text-text-secondary">{t("common", K.subtitle)}</p>
          </div>
        </header>

        <RegisterPanel onRegistered={reload} />
        <PanelList panels={panels} groups={groups} isLoading={isLoading} error={error} onRetry={reloadPanels} />
        <PanelGroups groups={groups} panels={panels} isLoading={groupsLoading} error={groupsError} onChanged={reloadGroups} />
        {/* Acknowledging resumes a halted panel: its health line is read again. */}
        <DriftReport onAcknowledged={reload} />
        <HoldsQueue />
      </div>
    </HolderNamesContext.Provider>
  );
}
