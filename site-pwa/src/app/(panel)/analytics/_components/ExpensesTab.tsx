"use client";

import { useCallback, useEffect, useState } from "react";
import { Undo2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useLiveReread } from "@/hooks/useLiveReread";
import { type Expense, type ExpensePage, expensesApi } from "@/lib/billing/analytics-expenses";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { Alert, Badge, Button, Card, CardHeader, notify } from "../../_components/kit";
import { formatInstant } from "../../_lib/datetime";
import { formatMoney } from "../../_lib/money";
import { useExpenseError } from "../_hooks/useRefusalError";
import { analyticsLiveOf } from "../_lib/live";
import { ExpenseForm } from "./ExpenseForm";

const E = FrontendI18nKeys.common.analytics.expenses;

export interface ExpensesTabProps {
  tenantId: string;
  /** The settings key's holders add and take back; everyone else with the analytics key reads. */
  editable: boolean;
  /** The reader's day, the form's default and latest. */
  today: string;
}

/** A tenant day at noon UTC, so its label is that day on every wall clock. */
const noonOf = (day: string) => `${day}T12:00:00Z`;

/**
 * The Expenses view under Profit (F-1001-u, panel-web
 * `contract.analytics-tabs.md` "Expenses"; billing
 * `contract.analytics-expenses.md`): what the tenant pays that no panel or
 * product carries, newest first, and for the settings key's holders a form to
 * add one and a way to take one back — there is no edit. Re-reads on the
 * tenant's analytics event (C-14): another person's write restates the
 * figures, and that pass announces itself.
 */
export function ExpensesTab({ tenantId, editable, today }: ExpensesTabProps) {
  const { t, lang } = useLocale();
  const errorText = useExpenseError();
  const { me } = usePanelSession();
  const [page, setPage] = useState<ExpensePage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    expensesApi.list(tenantId, {}).then(
      (next) => {
        setPage(next);
        setError(null);
      },
      (e: unknown) => setError(e),
    );
  }, [tenantId]);
  useEffect(load, [load]);
  const live = analyticsLiveOf(me, tenantId);
  useLiveReread(live.channels[0], live.types, load, live.accepts);
  useLiveReread(live.channels[1], live.types, load, live.accepts);

  /** The next page, after the oldest one shown. */
  const older = async () => {
    const last = page?.expenses.at(-1);
    if (!page || !last) return;
    try {
      const next = await expensesApi.list(tenantId, { before: last.id });
      setPage({ ...next, expenses: [...page.expenses, ...next.expenses] });
    } catch (e) {
      notify.error(errorText(e));
    }
  };

  const takeBack = async (expense: Expense) => {
    setBusy(expense.id);
    try {
      await expensesApi.takeBack(tenantId, expense.id);
      notify.success(t("common", E.takenBackDone));
      load();
    } catch (e) {
      notify.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  if (error && !page) return <Alert tone="error" title={t("common", E.loadFailed)}>{errorText(error)}</Alert>;
  if (!page) return <p className="text-sm text-text-secondary">{t("common", E.loading)}</p>;
  const day = (d: string) => formatInstant(noonOf(d), lang, { withTime: false }) ?? d;

  return (
    <div className="flex flex-col gap-4">
      {editable && <ExpenseForm tenantId={tenantId} currencyCode={page.currencyCode} today={today} onAdded={load} />}
      <Card padding="sm">
        <CardHeader title={t("common", E.title)} subtitle={t("common", E.subtitle)} className="mb-2" />
        {page.expenses.length === 0 ? (
          <p className="p-2 text-sm text-text-secondary">{t("common", E.empty)}</p>
        ) : (
          <ul aria-label={t("common", E.title)} className="divide-y divide-card-border">
            {page.expenses.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className={x.takenBackAt ? "font-semibold text-text-secondary line-through" : "font-semibold text-text-primary"}>
                    {t("common", E.categories[x.category])} · <span dir="ltr">{formatMoney(x.amount, x.currencyCode, { lang, t })}</span>
                  </span>
                  <span className="text-xs text-text-secondary">
                    {t("common", E.spread, { day: day(x.spentOn), months: x.months })}
                    {x.note && ` · ${x.note}`}
                  </span>
                </div>
                {x.takenBackAt ? (
                  <Badge tone="neutral" icon={<Undo2 size={12} aria-hidden />}>
                    {t("common", E.takenBack)}
                  </Badge>
                ) : (
                  editable && (
                    <Button size="sm" variant="quiet" disabled={busy === x.id} onClick={() => takeBack(x)}>
                      {t("common", E.takeBack)}
                    </Button>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
        {page.more && (
          <div className="mt-2">
            <Button size="sm" variant="secondary" onClick={older}>
              {t("common", E.older)}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
