"use client";

import { RealtimeEvents } from "@/generated/wire";
import { useLiveReread } from "@/hooks/useLiveReread";
import { membersChannel } from "@/lib/realtime";
import { useResellerWorkspace } from "../_context/ResellerWorkspaceContext";
import { usePanelSession } from "../_context/PanelSessionContext";
import { domainLiveChannels } from "../my-resellers/_lib/domains";

const OWN_EVENTS = [RealtimeEvents.tenantCurrencyChanged] as const;
const WORKSPACE_EVENTS = [RealtimeEvents.tenantResellerCurrencyChanged] as const;

/**
 * Calls `changed` when the money on the open page is in a currency that no
 * longer holds (`realtime/contract.live-events.md`):
 *
 * - RT-1-m: the session's own tenant changed it, on `members:`;
 * - RT-1-m2: the open page is a reseller's workspace (`inPath`) and that
 *   reseller changed it — its owner hears it on `user:`, the platform's staff
 *   on `tenant:`, because the workspace is on the platform's panel and the
 *   reseller's `members:` reaches neither.
 *
 * Only an event counts: a reconnect is not news, and each page already
 * re-reads its own channels on one.
 */
export function useCurrencyChanged(changed: () => void): void {
  const { me, group } = usePanelSession();
  const { workspace, inPath } = useResellerWorkspace();
  const shown = inPath ? (workspace?.id ?? null) : null;
  const onEvent = (cause: string) => {
    if (cause === "event") changed();
  };
  const ofShown = (payload: Record<string, unknown>) => payload.resellerId === shown;

  const tenantId = me?.tenant?.id ?? null;
  useLiveReread(tenantId ? membersChannel(tenantId) : null, OWN_EVENTS, onEvent);
  const [own, platform] = domainLiveChannels(shown ? (group?.current.userId ?? null) : null, shown ? me : null);
  useLiveReread(own, WORKSPACE_EVENTS, onEvent, ofShown);
  useLiveReread(platform, WORKSPACE_EVENTS, onEvent, ofShown);
}
