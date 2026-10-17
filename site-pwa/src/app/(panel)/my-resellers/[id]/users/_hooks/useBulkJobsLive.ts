"use client";

import { RealtimeEvents } from "@/generated/wire";
import { useLiveReread } from "@/hooks/useLiveReread";
import { userChannel } from "@/lib/realtime";
import { tenantChannelOf } from "@/lib/tenant-channel";
import { usePanelSession } from "../../../../_context/PanelSessionContext";

const BULK_JOB_EVENTS = [RealtimeEvents.grantBulkProgressed] as const;

/**
 * Re-reads the bulk jobs of tenant `id` when billing announces a batch, an end
 * or a cancel (RT-1-d, C-14). The viewer hears it on whichever channel reaches
 * them — the owner on its `user:`, staff (the tenant's own or the platform's)
 * on the session's `tenant:` — and only for this tenant's jobs: the platform's
 * `tenant:` carries every reseller's.
 */
export function useBulkJobsLive(id: string, reread: () => void): void {
  const { me, group } = usePanelSession();
  const userId = group?.current.userId ?? null;
  const ours = (p: Record<string, unknown>) => p.resellerId === id;
  useLiveReread(userId ? userChannel(userId) : null, BULK_JOB_EVENTS, reread, ours);
  useLiveReread(tenantChannelOf(me ?? null), BULK_JOB_EVENTS, reread, ours);
}
