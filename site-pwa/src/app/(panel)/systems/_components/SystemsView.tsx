"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, Server } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type PanelGroup, type SystemsPanel } from "@/lib/billing-api";
import { LIVE_REREAD_MS, trailingThrottle } from "@/lib/realtime";
import { usePanelRealtime } from "../../_context/PanelRealtimeContext";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { SYSTEMS_KEYS as K, isPanelTested, liveChannelOf } from "../_lib/systems";
import { attentionOf, guideOf, type SystemsTab } from "../_lib/systems-guide";
import { DriftReport } from "./DriftReport";
import { HoldsQueue } from "./HoldsQueue";
import { PanelGroups } from "./PanelGroups";
import { PanelList } from "./PanelList";
import { HolderNamesContext } from "./parts";
import { RegisterPanel } from "./RegisterPanel";
import { SystemsGuide } from "./SystemsGuide";

const GUIDE_CLOSED = "txnet.systems.guideClosed";
const TABS: SystemsTab[] = ["panels", "groups", "reports"];

/** Per browser, and never trusted: storage may be blocked, and then the guide simply shows. */
function readGuideClosed(): boolean {
  try {
    return localStorage.getItem(GUIDE_CLOSED) === "1";
  } catch {
    return false;
  }
}

function writeGuideClosed(closed: boolean) {
  try {
    if (closed) localStorage.setItem(GUIDE_CLOSED, "1");
    else localStorage.removeItem(GUIDE_CLOSED);
  } catch {
    // The choice lasts for this visit only.
  }
}

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
 *
 * Laid out for someone who has never used it (F-027-ck): a guide of the four
 * steps to a first sale, ticked from what the page read, then one tab each
 * for panels, groups and the reports, each badged with what needs a hand.
 */
export function SystemsView() {
  const { lang, t } = useLocale();
  const [panels, setPanels] = useState<SystemsPanel[]>([]);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [groups, setGroups] = useState<PanelGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [groupsError, setGroupsError] = useState<unknown>(null);
  const [tab, setTab] = useState<SystemsTab>("panels");
  const [registering, setRegistering] = useState(false);
  // Shown until closed; read after mount, since the server render has no storage.
  const [guideOpen, setGuideOpen] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGuideOpen(!readGuideClosed());
  }, []);

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

  const guide = useMemo(() => guideOf(panels, groups), [panels, groups]);
  const attention = useMemo(() => attentionOf(panels, groups), [panels, groups]);
  const loaded = !isLoading && !groupsLoading;

  const closeGuide = () => {
    setGuideOpen(false);
    writeGuideClosed(true);
  };
  const openGuide = () => {
    setGuideOpen(true);
    writeGuideClosed(false);
  };

  return (
    <HolderNamesContext.Provider value={names}>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 sm:p-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-lg font-bold text-text-primary">
              <Server size={18} className="text-primary" aria-hidden />
              {t("common", K.title)}
            </h1>
            <p className="text-xs leading-5 text-text-secondary">{t("common", K.subtitle)}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!guideOpen && (
              <button
                type="button"
                onClick={openGuide}
                className="inline-flex items-center gap-1.5 rounded-xl border border-card-border px-3 py-2 text-xs font-bold text-text-primary hover:bg-leaf-bg"
              >
                <BookOpen size={14} aria-hidden />
                {t("common", K.guide.show)}
              </button>
            )}
            <RegisterPanel open={registering} onOpen={() => setRegistering(true)} onClose={() => setRegistering(false)} onRegistered={reload} />
          </div>
        </header>

        {guideOpen && loaded && (
          <SystemsGuide
            steps={guide.steps}
            done={guide.done}
            onClose={closeGuide}
            onStep={(step) => (step === "register" ? setRegistering(true) : setTab(step === "group" ? "groups" : "panels"))}
          />
        )}

        <div role="tablist" className="flex gap-1 overflow-x-auto rounded-2xl border border-card-border bg-card-bg p-1">
          {TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`inline-flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-xl px-3 py-2 text-xs font-bold ${
                tab === id ? "bg-primary text-text-on-accent" : "text-text-secondary hover:bg-leaf-bg"
              }`}
            >
              {t("common", K.tabs[id])}
              {attention[id] > 0 && (
                <span
                  title={t("common", K.tabs.attention, { n: String(attention[id]) })}
                  className="grid min-w-5 place-items-center rounded-full bg-error px-1.5 text-[10px] font-bold text-white"
                >
                  {attention[id].toLocaleString(lang)}
                </span>
              )}
            </button>
          ))}
        </div>

        {tab === "panels" && <PanelList panels={panels} groups={groups} isLoading={isLoading} error={error} onRetry={reloadPanels} />}
        {tab === "groups" && (
          <PanelGroups groups={groups} panels={panels} isLoading={groupsLoading} error={groupsError} onChanged={reloadGroups} />
        )}
        {tab === "reports" && (
          <>
            <p className="text-xs leading-5 text-text-secondary">{t("common", K.tabs.reportsHint)}</p>
            {/* Acknowledging resumes a halted panel: its health line is read again. */}
            <DriftReport onAcknowledged={reload} />
            <HoldsQueue />
          </>
        )}
      </div>
    </HolderNamesContext.Provider>
  );
}
