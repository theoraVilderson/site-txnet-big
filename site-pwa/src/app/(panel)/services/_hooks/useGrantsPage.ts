"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { billingApi, type GrantRow } from "@/lib/billing-api";
import { catalogApi } from "@/lib/catalog-api";
import { userChannel } from "@/lib/realtime";
import { usePanelRealtime } from "../../_context/PanelRealtimeContext";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { flattenTexts } from "../../catalog/_lib/catalog-form";
import { readGrantSettled, readLinksCaptured } from "../_lib/my-services";

/** Billing's own default page size (`GrantService.listForUser`), sent explicitly. */
export const PAGE_SIZE = 20;

export interface GrantsPageState {
  rows: GrantRow[] | null;
  total: number;
  pageSize: number;
  /** The published `catalog` namespace in the viewer's language, flat by full key. */
  texts: Record<string, string>;
  isLoading: boolean;
  /**
   * How many times each Grant's configs were said to have changed — by id, a
   * missing id is 0. An open `GrantConfigs` re-reads when its count moves.
   */
  configsAsked: Record<string, number>;
  /** What went wrong, already in the user's language, or `null`. */
  error: unknown;
  retry: () => void;
}

/**
 * One page of the caller's own Grants, plus the names to show them under
 * (F-502-s).
 *
 * **The names are a second read, and a failing one costs only the names.**
 * Billing answers a `nameKey`, not a translated string
 * (`billing/contract.gift.md`), so the published `catalog` namespace is what
 * turns it into words — the same route and the same flattening the catalog
 * page uses. A language with no catalog text answers 404, which is `{}`: the
 * rows then read by their SKU rather than not at all.
 *
 * Racing is handled the way `useFinancialPage` handles it: one effect keyed to
 * the page, the language and a retry counter, with an `alive` flag, so a fast
 * answer to an abandoned page cannot land after a slow answer to the current
 * one.
 *
 * **A pending Grant turns live without a reload (F-111-f).** A paid Grant is
 * `pending` until entitlement delivers it, and the end of that — delivered or
 * refunded — arrives on the buyer's `user:` channel. When it names a row this
 * page is showing as `pending`, the page is read again, quietly: no skeleton,
 * and a failure keeps billing's last answer, because the event was a hint and
 * not the record (D-15). The row is never patched from the payload — delivery
 * also sets the period, and a refund ends in a status this page would guess.
 * The same quiet read follows a reconnect while a row is pending (`onMissed`),
 * since an event sent to a dropped socket reaches nobody.
 *
 * **A Grant's configs turn usable without a reload (F-111-l).** Their lines
 * are captured a minute or two after delivery, and `network.grant.linksCaptured`
 * names the Grant. The lines are in the config list a row opens, not in these
 * rows, so the event reads nothing here: it bumps `configsAsked[grantId]` and
 * an open list re-reads. A reconnect bumps every row, for the same reason.
 *
 * **Nothing is asked on a clock** (user, 2026-09-26). A socket that is down
 * reconnects on its own backoff (`lib/realtime.ts`), and `onMissed` is the
 * one read that follows; until then the page shows billing's last answer.
 */
export function useGrantsPage(page: number, lang: string): GrantsPageState {
  const [rows, setRows] = useState<GrantRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);

  const [asked, setAsked] = useState(0);
  const retry = useCallback(() => setAsked((n) => n + 1), []);

  // What this read *is*, as one string: loading is derived rather than stored,
  // so the skeleton is up in the render that changed the page rather than one
  // render later (`contract.financial.md`'s hook has the longer note).
  const key = `${page}|${lang}|${asked}`;
  const [loaded, setLoaded] = useState<string | null>(null);
  const isLoading = loaded !== key;

  // Every read, loud or quiet, takes a number; only the latest may land. That
  // is what stops a quiet re-read of page 1 from landing after the user moved
  // to page 2 — the `alive` flag below covers the loud reads alone.
  const seq = useRef(0);
  // The ids this page shows as `pending`, for the socket listener to test an
  // event against without resubscribing each time the rows change.
  const pendingIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    pendingIds.current = new Set((rows ?? []).filter((r) => r.status === "pending").map((r) => r.id));
  }, [rows]);

  // The page the quiet read asks for, synced after render as `pendingIds` is:
  // it is read only from a socket event or the clock, never while rendering.
  const pageRef = useRef(page);
  useEffect(() => {
    pageRef.current = page;
  }, [page]);
  const quietRead = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const answer = await billingApi.grants(pageRef.current, PAGE_SIZE);
      if (mine !== seq.current) return;
      setRows(answer.rows);
      setTotal(answer.total);
    } catch {
      // Billing's last answer stays up; a reload or the next event asks again.
    }
  }, []);

  const [configsAsked, setConfigsAsked] = useState<Record<string, number>>({});
  const shownIds = useRef<string[]>([]);
  useEffect(() => {
    shownIds.current = (rows ?? []).map((r) => r.id);
  }, [rows]);
  const askConfigs = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setConfigsAsked((before) => {
      const next = { ...before };
      for (const id of ids) next[id] = (next[id] ?? 0) + 1;
      return next;
    });
  }, []);

  const { group } = usePanelSession();
  const userId = group?.current.userId ?? null;
  const client = usePanelRealtime();
  useEffect(() => {
    if (!client || !userId) return;
    return client.subscribe(userChannel(userId), {
      onMessage: (payload) => {
        const settled = readGrantSettled(payload);
        if (settled && pendingIds.current.has(settled.grantId)) void quietRead();
        const captured = readLinksCaptured(payload);
        if (captured && shownIds.current.includes(captured.grantId)) askConfigs([captured.grantId]);
      },
      // A delivery or a capture that happened while the socket was down was
      // told to nobody, so the page asks again once it is back: the rows while
      // one is pending, and every open config list.
      onMissed: () => {
        if (pendingIds.current.size > 0) void quietRead();
        askConfigs(shownIds.current);
      },
    });
  }, [client, userId, quietRead, askConfigs]);

  useEffect(() => {
    let alive = true;
    const mine = ++seq.current;
    (async () => {
      try {
        const [answer, catalogTexts] = await Promise.all([
          billingApi.grants(page, PAGE_SIZE),
          catalogApi.texts(lang).then(flattenTexts).catch(() => ({})),
        ]);
        if (!alive || mine !== seq.current) return;
        setRows(answer.rows);
        setTotal(answer.total);
        setTexts(catalogTexts);
        setError(null);
      } catch (e) {
        // A failed read is not an empty list: the rows go, because showing the
        // previous page's services under a failure would be a lie.
        if (!alive || mine !== seq.current) return;
        setError(e);
        setRows(null);
        setTotal(0);
      } finally {
        if (alive) setLoaded(key);
      }
    })();
    return () => {
      alive = false;
    };
  }, [page, lang, key]);

  return { rows, total, pageSize: PAGE_SIZE, texts, isLoading, configsAsked, error, retry };
}
