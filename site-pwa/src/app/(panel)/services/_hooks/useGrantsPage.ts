"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { billingApi, type GrantRow } from "@/lib/billing-api";
import { catalogApi } from "@/lib/catalog-api";
import { userChannel } from "@/lib/realtime";
import { usePanelRealtime } from "../../_context/PanelRealtimeContext";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { flattenTexts } from "../../catalog/_lib/catalog-form";
import { readGrantSettled } from "../_lib/my-services";

/** Billing's own default page size (`GrantService.listForUser`), sent explicitly. */
export const PAGE_SIZE = 20;

/**
 * How often a page with a pending row asks billing while the socket is not
 * live (F-111-f). A minute is well under delivery's shortest retry (1 min)
 * doubled, and at 15 asks per 900s it leaves `GRANT_LIST` (120/900s) the rest.
 */
export const PENDING_POLL_MS = 60_000;

export interface GrantsPageState {
  rows: GrantRow[] | null;
  total: number;
  pageSize: number;
  /** The published `catalog` namespace in the viewer's language, flat by full key. */
  texts: Record<string, string>;
  isLoading: boolean;
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
 * since an event sent to a dropped socket reaches nobody. And while the
 * socket is not live at all — never welcomed, or down between attempts — a
 * pending row is asked about every `PENDING_POLL_MS` with the tab visible;
 * a live socket makes that clock ask nothing.
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

  const { group } = usePanelSession();
  const userId = group?.current.userId ?? null;
  const client = usePanelRealtime();
  useEffect(() => {
    if (!client || !userId) return;
    return client.subscribe(userChannel(userId), {
      onMessage: (payload) => {
        const settled = readGrantSettled(payload);
        if (settled && pendingIds.current.has(settled.grantId)) void quietRead();
      },
      // A delivery that ended while the socket was down was told to nobody,
      // so a page still showing a pending row asks again once it is back.
      onMissed: () => {
        if (pendingIds.current.size > 0) void quietRead();
      },
    });
  }, [client, userId, quietRead]);

  // The fallback for a socket that is not live: nothing is published to it,
  // and `onMissed` waits on a reconnect that may never come. The clock runs
  // only while a row is pending; each tick asks only if the socket is still
  // not live and the tab is visible, so a working socket costs no request.
  const hasPending = (rows ?? []).some((r) => r.status === "pending");
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => {
      if (client?.connectionInfo()) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void quietRead();
    }, PENDING_POLL_MS);
    return () => clearInterval(timer);
  }, [hasPending, client, quietRead]);

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

  return { rows, total, pageSize: PAGE_SIZE, texts, isLoading, error, retry };
}
