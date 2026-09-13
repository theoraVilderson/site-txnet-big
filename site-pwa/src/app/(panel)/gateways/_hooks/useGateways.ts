"use client";

import { useCallback, useEffect, useState } from "react";
import { billingApi, type AdminGateway, type GatewayGrant } from "@/lib/billing-api";

export interface GatewaysState {
  gateways: AdminGateway[];
  /** `null` when the caller may not see links — loaded only for the platform owner. */
  grants: GatewayGrant[] | null;
  isLoading: boolean;
  error: unknown;
  reload: () => Promise<void>;
}

/**
 * The page's two lists, read together and re-read after every write.
 *
 * Nothing is patched into state from a write's answer: billing decides what a
 * delete did (deleted or deactivated, how many links withdrawn), and the list
 * it answers next is the only honest picture of that.
 */
export function useGateways(withLinks: boolean): GatewaysState {
  const [gateways, setGateways] = useState<AdminGateway[]>([]);
  const [grants, setGrants] = useState<GatewayGrant[] | null>(null);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, links] = await Promise.all([
        billingApi.adminGateways(),
        withLinks ? billingApi.gatewayGrants() : Promise.resolve(null),
      ]);
      setGateways(list);
      setGrants(links);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [withLinks]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { gateways, grants, isLoading, error, reload };
}
