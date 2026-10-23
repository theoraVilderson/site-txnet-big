"use client";

import { useCallback, useEffect, useState } from "react";
import type { MigrationRunsApi, ResellerRouter } from "@/lib/billing-api";
import { useLiveReread } from "@/hooks/useLiveReread";
import { usePanelSession } from "../../../../_context/PanelSessionContext";
import { ROUTER_EVENTS, routersChannelOf } from "../../../_lib/migration-router";

/**
 * The reseller's own routers (F-1601-g), re-read when one's connection test
 * answers (C-14, `routersChannelOf`) and on `reread` after a write. Never polls.
 */
export function useResellerRouters(api: MigrationRunsApi, resellerId: string) {
  const { me } = usePanelSession();
  const [routers, setRouters] = useState<ResellerRouter[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const reread = useCallback(() => {
    api.routers().then(
      (r) => {
        setRouters(r);
        setError(null);
      },
      (e: unknown) => setError(e),
    );
  }, [api]);
  useEffect(reread, [reread]);
  useLiveReread(routersChannelOf(me, resellerId), ROUTER_EVENTS, reread);
  return { routers, error, reread };
}
