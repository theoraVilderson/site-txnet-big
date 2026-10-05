"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { aiAdminApi, type AiReason, type AtRiskItem, type AtRiskKind } from "@/lib/ai-api";
import { myResellerUserPath } from "@/lib/routes";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { formatInstant } from "../../_lib/datetime";
import { K, card } from "./ai-ui";
import { Button, SegmentedControl } from "../../_components/kit";

type KnownReason = keyof typeof K.reasons;
const isKnown = (code: string): code is KnownReason => code in K.reasons;
/** The numbers a reason's words name; the rest of a reason is the engine's arithmetic. */
const VARS: Partial<Record<KnownReason, (r: AiReason) => Record<string, string | number>>> = {
  renewed_before: (r) => ({ count: Number(r["count"] ?? 0) }),
};

/**
 * The customers at risk (F-038-j1's lists), each with the engine's reasons in
 * words. A reason this page has no words for is left out, never shown as a
 * code. A customer is an id — ai reads no contact column — linked to their page
 * in the tenant's users.
 */
export function AtRiskList() {
  const { t, lang } = useLocale();
  const errorMessage = useApiErrorMessage();
  const { me } = usePanelSession();
  const [kind, setKind] = useState<AtRiskKind>("renewal");
  const [items, setItems] = useState<AtRiskItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    aiAdminApi
      .atRisk(kind)
      .then((page) => {
        if (!alive) return;
        setItems(page.items);
        setCursor(page.nextCursor);
      })
      .catch((e: unknown) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const more = async () => {
    try {
      const page = await aiAdminApi.atRisk(kind, cursor);
      setItems((now) => [...(now ?? []), ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const tenantId = me?.tenant?.id ?? null;
  const date = (iso: string | null) => formatInstant(iso, lang, { withTime: false }) ?? "";

  return (
    <section className="flex flex-col gap-4">
      <SegmentedControl<"renewal" | "run_out">
        ariaLabel={t("common", K.tabs.atRisk)}
        size="sm"
        value={kind}
        onChange={(k) => {
          if (k === kind) return;
          setItems(null);
          setError(null);
          setKind(k);
        }}
        options={(["renewal", "run_out"] as const).map((k) => ({ value: k, label: t("common", k === "renewal" ? K.atRisk.renewal : K.atRisk.runOut) }))}
        className="self-start"
      />
      {error && <p role="alert" className="text-xs font-medium text-error">{error}</p>}
      {items === null ? (
        !error && <p className="text-sm text-text-secondary">{t("common", K.loading)}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-text-secondary">{t("common", K.atRisk.empty)}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={`${item.userId}:${item.grantId}`} className={`${card} flex flex-col gap-2`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                {tenantId ? (
                  <Link href={myResellerUserPath(tenantId, item.userId)} className="text-sm font-bold text-primary underline" dir="ltr">
                    {t("common", K.atRisk.customer)} {item.userId}
                  </Link>
                ) : (
                  <span className="text-sm font-bold" dir="ltr">{item.userId}</span>
                )}
                <span className="text-xs text-text-secondary">
                  {kind === "renewal"
                    ? `${t("common", K.atRisk.renewChance, { percent: Math.round(Number(item.value ?? 0) * 100) })} · ${t("common", K.atRisk.endsOn, { date: date(item.predictedAt) })}`
                    : t("common", K.atRisk.runsOutOn, { date: date(item.predictedAt) })}
                </span>
              </div>
              <ul className="flex flex-wrap gap-1.5">
                {item.reasons.filter((r) => isKnown(r.code)).map((r, i) => {
                  const code = r.code as KnownReason;
                  const vars = VARS[code]?.(r);
                  return (
                    <li key={i} className="rounded-full bg-[var(--leaf-bg)] px-2 py-0.5 text-xs text-text-primary">
                      {vars ? t("common", K.reasons[code], vars) : t("common", K.reasons[code])}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {cursor && items && (
        <div>
          <Button variant="quiet" size="sm" onClick={() => void more()}>{t("common", K.atRisk.more)}</Button>
        </div>
      )}
    </section>
  );
}
