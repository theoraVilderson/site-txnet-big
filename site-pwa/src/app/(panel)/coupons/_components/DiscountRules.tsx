"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BadgePercent, Pencil, Plus, Power, RotateCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { userGroupsApi, type Me } from "@/lib/auth-api";
import { billingApi, type DiscountRule } from "@/lib/billing-api";
import { catalogApi } from "@/lib/catalog-api";
import { formatMoney } from "../../_lib/money";
import { formatInstant } from "../../_lib/datetime";
import { COUPON_KEYS } from "../_lib/coupon-form";
import { RULE_KEYS as K, RULE_STATUS_TONES, ruleRefusalKey } from "../_lib/discount-rules";
import type { Choices } from "./ChoicePicker";
import { DiscountRuleForm, type RuleChoices } from "./DiscountRuleForm";
import { ListSkeleton } from "./ListSkeleton";

const L = K.list;

/** Read a picker's list once; a caller without the route's permission gets `"failed"` and types ids. */
function useChoices(): RuleChoices {
  const [products, setProducts] = useState<Choices>(null);
  const [categories, setCategories] = useState<Choices>(null);
  const [groups, setGroups] = useState<Choices>(null);
  useEffect(() => {
    let live = true;
    const load = (read: () => Promise<{ value: string; label: string }[]>, put: (c: Choices) => void) =>
      read().then(
        (c) => live && put(c),
        () => live && put("failed"),
      );
    void load(async () => (await catalogApi.products()).filter((p) => p.isActive && !p.archivedAt).map((p) => ({ value: p.id, label: p.key })), setProducts);
    void load(async () => (await catalogApi.categories()).filter((c) => c.isActive && !c.archivedAt).map((c) => ({ value: c.id, label: c.key })), setCategories);
    void load(async () => (await userGroupsApi.list()).map((g) => ({ value: g.id, label: g.name })), setGroups);
    return () => {
      live = false;
    };
  }, []);
  return useMemo(() => ({ products, categories, groups }), [products, categories, groups]);
}

/**
 * Tab 3 of the coupons page — discounts with no code (F-114-k, ADR-0087).
 * Billing answers the caller's own tenant's rules, newest first, with their
 * status; nothing is filtered or patched here. There is no delete: an invoice
 * may name a rule, so a rule is switched off.
 */
export function DiscountRules({ me }: { me: Me | null }) {
  const { t, lang } = useLocale();
  const errorMessage = useApiErrorMessage();
  const choices = useChoices();
  const [rules, setRules] = useState<DiscountRule[] | null>(null);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<DiscountRule | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const message = (e: unknown) => {
    const key = ruleRefusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };

  const load = useCallback(async () => {
    try {
      setRules(await billingApi.discountRules());
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Every setState in load runs after its first await, as in the coupon tab.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const toggle = async (r: DiscountRule) => {
    setActionError(null);
    try {
      await billingApi.updateDiscountRule(r.id, { isActive: !r.isActive });
      setNotice(t("common", K.saved));
      await load();
    } catch (e) {
      setActionError(message(e));
    }
  };

  const labelOf = (list: Choices, id: string) => (Array.isArray(list) ? list.find((c) => c.value === id)?.label : undefined) ?? id.slice(0, 8);
  const money = (amount: string, currency: string) => formatMoney(amount, currency, { lang, t });
  const day = (instant: string) => formatInstant(instant, lang) ?? "";

  const what = (r: DiscountRule) => (r.kind === "percentage" ? t("common", L.percentOff, { value: Number(r.value).toString() }) : t("common", L.amountOff, { amount: money(r.value, r.currencyCode) }));
  const where = (r: DiscountRule) =>
    r.productId ? t("common", L.product, { label: labelOf(choices.products, r.productId) }) : r.categoryId ? t("common", L.category, { label: labelOf(choices.categories, r.categoryId) }) : t("common", L.everything);
  const who = (r: DiscountRule) =>
    r.forNamedUsers ? t("common", L.named, { count: String(r.userIds.length) }) : r.groupId ? t("common", L.group, { label: labelOf(choices.groups, r.groupId) }) : t("common", L.everyone);
  const when = (r: DiscountRule) => (r.endsAt ? t("common", L.window, { from: day(r.startsAt), to: day(r.endsAt) }) : t("common", L.openEnded, { from: day(r.startsAt) }));

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-xs text-text-secondary">{t("common", K.intro)}</p>
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-white shadow-sm transition-all hover:brightness-110"
        >
          <Plus size={16} aria-hidden />
          {t("common", K.add)}
        </button>
      </div>

      {notice && (
        <p role="status" className="rounded-xl border border-card-border bg-card-bg p-3 text-xs text-text-primary">
          {notice}
        </p>
      )}
      {actionError && (
        <p role="alert" className="text-xs font-bold text-error">
          {actionError}
        </p>
      )}

      {isLoading ? (
        <ListSkeleton label={t("common", K.form.loading)} />
      ) : (
        <section className="relative rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm sm:p-6">
          {error ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p role="alert" className="text-xs font-bold text-error">
                {message(error)}
              </p>
              <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1 text-xs font-bold text-primary">
                <RotateCw size={14} aria-hidden />
                {t("common", COUPON_KEYS.retry)}
              </button>
            </div>
          ) : !rules || rules.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <span className="grid size-14 place-items-center rounded-2xl bg-[var(--leaf-bg)] text-primary">
                <BadgePercent size={26} aria-hidden />
              </span>
              <p className="text-sm text-text-secondary">{t("common", K.empty)}</p>
            </div>
          ) : (
            <ul className="divide-y divide-card-border">
              {rules.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-bold text-text-primary">
                      {r.name}
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${RULE_STATUS_TONES[r.status]}`}>{t("common", K.status[r.status])}</span>
                    </span>
                    <span className="text-xs text-text-secondary">
                      {what(r)} · {where(r)} · {who(r)}
                    </span>
                    <span className="text-xs text-text-secondary">{when(r)}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <button type="button" onClick={() => setEditing(r)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold text-primary">
                      <Pencil size={14} aria-hidden />
                      {t("common", L.edit)}
                    </button>
                    <button type="button" onClick={() => void toggle(r)} className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold ${r.isActive ? "text-error" : "text-primary"}`}>
                      <Power size={14} aria-hidden />
                      {t("common", r.isActive ? L.switchOff : L.switchOn)}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {editing && (
        <DiscountRuleForm
          me={me}
          rule={editing === "new" ? null : editing}
          choices={choices}
          onClose={() => setEditing(null)}
          onSaved={async (text) => {
            setEditing(null);
            setNotice(text);
            await load();
          }}
        />
      )}
    </>
  );
}
