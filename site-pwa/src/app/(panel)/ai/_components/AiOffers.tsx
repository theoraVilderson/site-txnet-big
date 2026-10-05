"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { aiAdminApi, type AiOffer } from "@/lib/ai-api";
import { billingApi, type AdminCoupon } from "@/lib/billing-api";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { formatMoney } from "../../_lib/money";
import { AMOUNT_RE, K, PERCENT_RE, card, refusalKey } from "./ai-ui";
import { Button, Field, Input, NativeSelect } from "../../_components/kit";

/** A coupon ai accepts as a template (F-038-f1): the tenant's own, a discount, not deleted. */
export function templateChoices(coupons: AdminCoupon[], tenantId: string | null): AdminCoupon[] {
  return coupons.filter((c) => c.tenantId === tenantId && (c.discountType === "percentage" || c.discountType === "fixed_amount") && c.status !== "deleted");
}

type Form = { name: string; couponTemplateId: string; maxDiscountPercent: string; dailyBudget: string };
const EMPTY: Form = { name: "", couponTemplateId: "", maxDiscountPercent: "", dailyBudget: "" };

/**
 * The discount offers the engine may give (F-038-f1, ADR-0110) — a personal
 * coupon cloned from a template at delivery (F-038-f3). The page makes coupon
 * offers; the budget is in the template's currency. An offer is switched off,
 * never deleted: the audit keeps what its suggestions named.
 */
export function AiOffers() {
  const { t, lang } = useLocale();
  const errorMessage = useApiErrorMessage();
  const { me } = usePanelSession();
  const [offers, setOffers] = useState<AiOffer[] | null>(null);
  const [templates, setTemplates] = useState<AdminCoupon[] | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const message = (e: unknown) => {
    const key = refusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };

  const load = useCallback(async () => {
    try {
      setOffers((await aiAdminApi.offers()).items);
    } catch (e) {
      setError(message(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Every setState in load runs after its first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const open = async () => {
    setForm(EMPTY);
    setError(null);
    try {
      const page = await billingApi.adminCoupons({ kind: "discount", page: 1, pageSize: 100 });
      setTemplates(templateChoices(page.items, me?.tenant?.id ?? null));
    } catch {
      setTemplates([]);
    }
  };

  const template = templates?.find((c) => c.id === form?.couponTemplateId) ?? null;
  const valid =
    !!form && form.name.trim() !== "" && !!template && PERCENT_RE.test(form.maxDiscountPercent) && Number(form.maxDiscountPercent) > 0 && Number(form.maxDiscountPercent) <= 100 && AMOUNT_RE.test(form.dailyBudget);

  const create = async () => {
    if (!form || !template) return;
    setBusy(true);
    setError(null);
    try {
      await aiAdminApi.createOffer({
        name: form.name.trim(),
        actionType: "retain_offer",
        couponTemplateId: template.id,
        maxDiscountPercent: form.maxDiscountPercent,
        dailyBudget: form.dailyBudget,
        currencyCode: template.currencyCode,
      });
      setForm(null);
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (o: AiOffer) => {
    setError(null);
    try {
      await aiAdminApi.updateOffer(o.id, { isActive: !o.isActive });
      await load();
    } catch (e) {
      setError(message(e));
    }
  };

  return (
    <section className="flex flex-col gap-4">
      {error && <p role="alert" className="text-xs font-medium text-error">{error}</p>}
      {!form && (
        <div>
          <Button variant="primary" size="sm" onClick={() => void open()}>{t("common", K.offers.add)}</Button>
        </div>
      )}
      {form && (
        <div className={`${card} grid gap-3 sm:grid-cols-2`}>
          <Field id="ai-offer-name" label={t("common", K.offers.name)}>
            <Input id="ai-offer-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field id="ai-offer-template" label={t("common", K.offers.template)} hint={t("common", templates && templates.length === 0 ? K.offers.templateNone : K.offers.templateHint)}>
            <NativeSelect id="ai-offer-template" value={form.couponTemplateId} onChange={(e) => setForm({ ...form, couponTemplateId: e.target.value })}>
              <option value="" />
              {(templates ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.code}</option>
              ))}
            </NativeSelect>
          </Field>
          <Field id="ai-offer-max" label={t("common", K.offers.maxDiscount)}>
            <Input id="ai-offer-max" inputMode="decimal" dir="ltr" value={form.maxDiscountPercent} onChange={(e) => setForm({ ...form, maxDiscountPercent: e.target.value.trim() })} />
          </Field>
          <Field id="ai-offer-budget" label={t("common", K.offers.dailyBudget)} hint={template ? `${t("common", K.offers.currency)}: ${template.currencyCode}` : undefined}>
            <Input id="ai-offer-budget" inputMode="decimal" dir="ltr" value={form.dailyBudget} onChange={(e) => setForm({ ...form, dailyBudget: e.target.value.trim() })} />
          </Field>
          <div className="flex gap-3 sm:col-span-2">
            <Button variant="primary" size="sm" disabled={busy || !valid} onClick={() => void create()}>{t("common", K.offers.create)}</Button>
            <Button variant="quiet" onClick={() => setForm(null)}>{t("common", K.offers.cancel)}</Button>
          </div>
        </div>
      )}

      {offers === null ? (
        !error && <p className="text-sm text-text-secondary">{t("common", K.loading)}</p>
      ) : offers.length === 0 ? (
        <p className="text-sm text-text-secondary">{t("common", K.offers.empty)}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {offers.map((o) => (
            <li key={o.id} className={`${card} flex flex-wrap items-center justify-between gap-3`}>
              <div>
                <p className="text-sm font-bold text-text-primary">{o.name}</p>
                <p className="text-xs text-text-secondary">
                  {t("common", K.offers.summary, { percent: Number(o.maxDiscountPercent), budget: formatMoney(o.dailyBudget, o.currencyCode, { lang, t }) })}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${o.isActive ? "bg-primary/10 text-primary" : "bg-[var(--leaf-bg)] text-text-secondary"}`}>
                  {t("common", o.isActive ? K.offers.active : K.offers.inactive)}
                </span>
                <Button variant="quiet" size="sm" onClick={() => void toggle(o)}>
                  {t("common", o.isActive ? K.offers.turnOff : K.offers.turnOn)}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
