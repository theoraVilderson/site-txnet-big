"use client";

import { RealtimeEvents } from "@/generated/wire";
import { useLiveReread } from "@/hooks/useLiveReread";
import { catalogChannel, PLATFORM_CATALOG } from "@/lib/realtime";
import { usePanelSession } from "../../_context/PanelSessionContext";

const SALES_EVENTS = [RealtimeEvents.catalogVariantSalesChanged] as const;

/**
 * Calls `reread` when a capped variant the shop lists may have sold out or
 * come back (F-513-c, RT-1-p): billing writes the event on the variant's
 * owner's catalog channel, so the shop hears its own tenant's and the
 * platform's, which every shop sells from. A reconnect re-reads too — an
 * event sent while the socket was down reached nobody.
 */
export function useCatalogSalesLive(reread: () => void): void {
  const { me } = usePanelSession();
  const tenantId = me?.tenant?.id ?? null;
  useLiveReread(tenantId ? catalogChannel(tenantId) : null, SALES_EVENTS, reread);
  useLiveReread(tenantId ? catalogChannel(PLATFORM_CATALOG) : null, SALES_EVENTS, reread);
}
