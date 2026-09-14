"use client";

import { useCallback, useEffect, useState } from "react";
import { billingApi, type AdminGateway, type GatewayGrant } from "@/lib/billing-api";

export interface GatewaysState {
  gateways: AdminGateway[];
  /** `null` when the caller may not see links — loaded only for the platform owner. */
  grants: GatewayGrant[] | null;
  /** The caller tenant's default quick amounts (F-092-v); `null` until read or when it could not be. */
  presets: string[] | null;
  /** Only until the first answer. A later reload keeps the lists on screen and sets `isRefreshing`. */
  isLoading: boolean;
  isRefreshing: boolean;
  error: unknown;
  reload: () => Promise<void>;
}

/**
 * The page's two lists, read together and re-read after every write.
 *
 * Nothing is patched into state from a write's answer: billing decides what a
 * delete did (deleted or deactivated, how many links withdrawn), and the list
 * it answers next is the only honest picture of that.
 *
 * `enabled` waits for the session: whether links are loaded depends on the
 * tenant type, and reading before `me` is known would fetch twice and show the
 * links panel a beat after the list.
 */
export function useGateways(withLinks: boolean, enabled = true): GatewaysState {
  const [gateways, setGateways] = useState<AdminGateway[]>([]);
  const [grants, setGrants] = useState<GatewayGrant[] | null>(null);
  const [presets, setPresets] = useState<string[] | null>(null);
  const [isLoading, setLoading] = useState(true);
  const [isRefreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // No state is set before the first await, so the effect below does not render twice.
  const fetchAll = useCallback(async () => {
    try {
      const [list, links, defaults] = await Promise.all([
        billingApi.adminGateways(),
        withLinks ? billingApi.gatewayGrants() : Promise.resolve(null),
        // Read with the lists so the card appears with them; a failure here
        // hides the card rather than failing the page.
        billingApi.gatewayPresets().then(
          (r) => r.presets,
          () => null,
        ),
      ]);
      setGateways(list);
      setGrants(links);
      setPresets(defaults);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [withLinks]);

  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchAll();
    } finally {
      setRefreshing(false);
    }
  }, [fetchAll]);

  useEffect(() => {
    // Every setState in fetchAll runs after its first await, not in this effect's body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (enabled) void fetchAll();
  }, [enabled, fetchAll]);

  return { gateways, grants, presets, isLoading, isRefreshing, error, reload };
}
