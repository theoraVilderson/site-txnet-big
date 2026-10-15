"use client";

import { useCallback, useEffect, useState } from "react";
import type { AdminGateway, DestinationBody, GatewayAdminApi, ManualDestination } from "@/lib/billing-api";

export interface DestinationsState {
  /** In the order shown — the drag's order while one is under way, billing's otherwise. */
  destinations: ManualDestination[];
  isLoading: boolean;
  error: unknown;
  /** Re-read after a write made elsewhere (the editor's create). */
  reload: () => void;
  /** The order while dragging; nothing is written until {@link commitOrder}. */
  reorder: (next: ManualDestination[]) => void;
  /** The drag ended: each row whose place changed gets its new `sortOrder`, then the list is re-read. */
  commitOrder: () => Promise<void>;
  update: (d: ManualDestination, body: DestinationBody) => Promise<void>;
  remove: (d: ManualDestination) => Promise<"deleted" | "deactivated">;
}

/**
 * One manual gateway's cards or wallets (F-803-g), re-read after every write —
 * billing decides what a delete did (`deactivated` once a payment showed it)
 * and the list it answers next is the only honest picture of that, as on the
 * gateway list (`useGateways`). `onChanged` tells the page, whose row counts
 * the active destinations.
 */
export function useDestinations(api: GatewayAdminApi, gateway: AdminGateway, onChanged: () => void): DestinationsState {
  const [destinations, setDestinations] = useState<ManualDestination[]>([]);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  // Each write bumps the version; the effect re-reads for it, so the read lives in one place.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    api.destinations(gateway.source, gateway.id).then(
      (list) => {
        if (!alive) return;
        setDestinations(list);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (!alive) return;
        setError(e);
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [api, gateway.source, gateway.id, version]);

  const written = useCallback(() => {
    setVersion((v) => v + 1);
    onChanged();
  }, [onChanged]);

  const commitOrder = useCallback(async () => {
    // At most 50 rows (MAX_DESTINATIONS), so one PATCH per moved row is bounded (C-28).
    const moved = destinations.map((d, i) => [d, i] as const).filter(([d, i]) => d.sortOrder !== i);
    try {
      for (const [d, i] of moved) await api.updateDestination(gateway.source, gateway.id, d.id, { sortOrder: i });
    } finally {
      written();
    }
  }, [api, destinations, gateway.source, gateway.id, written]);

  const update = useCallback(
    async (d: ManualDestination, body: DestinationBody) => {
      await api.updateDestination(gateway.source, gateway.id, d.id, body);
      written();
    },
    [api, gateway.source, gateway.id, written],
  );

  const remove = useCallback(
    async (d: ManualDestination) => {
      const out = await api.removeDestination(gateway.source, gateway.id, d.id);
      written();
      return out.mode;
    },
    [api, gateway.source, gateway.id, written],
  );

  return { destinations, isLoading, error, reload: written, reorder: setDestinations, commitOrder, update, remove };
}
