"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, Server } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type PanelGroup, type SystemsPanel } from "@/lib/billing-api";
import { useLiveReread } from "@/hooks/useLiveReread";
import { StorageKeys, readStored, writeStored } from "@/lib/storage";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { formatInstant } from "../../_lib/datetime";
import { HELD_KEYS, SYSTEMS_KEYS as K, PANEL_EVENTS, liveChannelOf } from "../_lib/systems";
import { attentionOf, guideOf, type SystemsTab } from "../_lib/systems-guide";
import { DriftReport } from "./DriftReport";
import { HoldsQueue } from "./HoldsQueue";
import { PanelGroups } from "./PanelGroups";
import { PanelList } from "./PanelList";
import { HolderNamesContext } from "./parts";
import { RegisterPanel } from "./RegisterPanel";
import { SystemsGuide } from "./SystemsGuide";
import { PageHeader } from "../../_components/kit/PageHeader";
import { Alert, Button, Tabs } from "../../_components/kit";

const TABS: SystemsTab[] = ["panels", "groups", "reports"];

/** Per browser, and never trusted: storage may be blocked, and then the guide simply shows. */
const readGuideClosed = () => readStored(StorageKeys.systemsGuideClosed) === "1";
const writeGuideClosed = (closed: boolean) => writeStored(StorageKeys.systemsGuideClosed, closed ? "1" : null);

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
  const channel = liveChannelOf(me);
  // A burst of tests is one read now and one at the end (F-067-p), not one per event.
  useLiveReread(channel, PANEL_EVENTS, () => void reload());

  // A refusal names its holder from these (F-027-ci): billing sends only ids, and only inside this reader's scope.
  const names = useMemo(
    () => ({
      panel: (id: string) => panels.find((p) => p.id === id)?.name ?? null,
      group: (id: string) => groups.find((g) => g.id === id)?.name ?? null,
    }),
    [panels, groups],
  );

  const guide = useMemo(() => guideOf(panels, groups), [panels, groups]);
  // Our own outage, said once over the list (F-027-em, ADR-0122): every held panel shares the reason.
  const held = useMemo(() => panels.find((p) => p.health.heldBy)?.health.heldBy ?? null, [panels]);
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
        <PageHeader
          icon={Server}
          title={t("common", K.title)}
          subtitle={t("common", K.subtitle)}
          actions={
            <>
              <div className="flex flex-wrap items-center gap-2">
                {!guideOpen && (
                  <Button
                    size="sm"
                    onClick={openGuide}
                    icon={<BookOpen size={14} aria-hidden />}
                  >
                    {t("common", K.guide.show)}
                  </Button>
                )}
                <RegisterPanel open={registering} onOpen={() => setRegistering(true)} onClose={() => setRegistering(false)} onRegistered={reload} />
              </div>
            </>
          }
        />

        {guideOpen && loaded && (
          <SystemsGuide
            steps={guide.steps}
            done={guide.done}
            onClose={closeGuide}
            onStep={(step) => (step === "register" ? setRegistering(true) : setTab(step === "group" ? "groups" : "panels"))}
          />
        )}

        {held && (
          <Alert tone="warning">{t("common", HELD_KEYS[held.reason], { at: formatInstant(held.since, lang) ?? "" })}</Alert>
        )}

        <Tabs<SystemsTab>
          ariaLabel={t("common", K.title)}
          variant="pills"
          value={tab}
          onChange={setTab}
          tabs={TABS.map((id) => ({
            value: id,
            label: t("common", K.tabs[id]),
            // What needs a look, counted on its tab; its sentence names the number for a screen reader.
            badge:
              attention[id] > 0 ? (
                <span title={t("common", K.tabs.attention, { n: String(attention[id]) })} className="text-error">
                  {attention[id].toLocaleString(lang)}
                </span>
              ) : undefined,
          }))}
        />

        {tab === "panels" && <PanelList panels={panels} groups={groups} isLoading={isLoading} error={error} onRetry={reloadPanels} />}
        {tab === "groups" && (
          <PanelGroups groups={groups} panels={panels} isLoading={groupsLoading} error={groupsError} onChanged={reloadGroups} />
        )}
        {tab === "reports" && (
          <>
            <p className="text-xs leading-5 text-text-secondary">{t("common", K.tabs.reportsHint)}</p>
            {/* Acknowledging resumes a halted panel: its health line is read again. */}
            <DriftReport channel={channel} onAcknowledged={reload} />
            <HoldsQueue />
          </>
        )}
      </div>
    </HolderNamesContext.Provider>
  );
}
