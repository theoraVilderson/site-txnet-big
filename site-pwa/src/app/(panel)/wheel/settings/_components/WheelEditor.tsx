"use client";

import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { wheelAdminApi, type WheelVersion } from "@/lib/engagement-api";
import { usePanelSession } from "../../../_context/PanelSessionContext";
import { useRowKeys } from "../../../_hooks/useRowKeys";
import { usePrizeSources } from "../../../_hooks/usePrizeSources";
import { PrizeFields, PrizeRowHeader } from "../../../_components/prizes/PrizeFields";
import { moveRow } from "../../../_lib/rows";
import { formatMoney } from "../../../_lib/money";
import { Select } from "../../../_components/kit/Select";
import { formatDay, plainNumber } from "../../_lib/wheel";
import {
  PRIZES_MAX,
  PRIZE_TYPES,
  PRIZE_TYPE_KEYS,
  WHEEL_SETTINGS_KEYS as K,
  capLastsSpins,
  emptyPrize,
  emptyWheelForm,
  expectedCostPerSpin,
  formFromVersion,
  oddsPercents,
  validateWheelForm,
  wheelVersionBody,
  type PrizeForm,
  type WheelForm,
} from "../_lib/wheel-settings";
import { Alert, Field, dayAfter, useMessage } from "./wheel-settings-ui";
import { Button, Checkbox, Input } from "../../../_components/kit";

/**
 * A new version of the wheel, opened on the one it starts from. The odds and
 * the average cost per spin move as the admin types, counted the way billing
 * counts them; the save goes out only when billing would take it, and billing
 * checks it all again.
 */
export function WheelEditor({
  from,
  today,
  currency,
  onCancel,
  onSaved,
}: {
  from: WheelVersion | null;
  today: string;
  currency: string | null;
  onCancel: () => void;
  onSaved: (v: WheelVersion) => void;
}) {
  const { lang, t } = useLocale();
  const { me } = usePanelSession();
  const message = useMessage();
  const [form, setForm] = useState<WheelForm>(() => (from ? formFromVersion(from) : emptyWheelForm()));
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const { templates, groups } = usePrizeSources();

  const check = useMemo(() => validateWheelForm(form), [form]);
  const odds = oddsPercents(form.prizes.map((p) => p.weight));
  const expected = expectedCostPerSpin(form.prizes);
  const lasts = expected && capLastsSpins(form.cap, expected);
  const cur = currency ?? "—";
  const money = (amount: string) => (currency ? formatMoney(amount, currency, { lang, t }) : amount);
  const shown = (key: string | undefined) => (tried ? key : undefined);

  const set = <F extends keyof WheelForm>(field: F, value: WheelForm[F]) => setForm((f) => ({ ...f, [field]: value }));
  const setPrize = (i: number, patch: Partial<PrizeForm>) => setForm((f) => ({ ...f, prizes: f.prizes.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
  const prizeKeys = useRowKeys(form.prizes);
  const move = (i: number, by: -1 | 1) => setForm((f) => ({ ...f, prizes: moveRow(f.prizes, i, by) }));

  async function save() {
    setTried(true);
    setFailure(null);
    if (!check.ok) return;
    setSaving(true);
    try {
      onSaved(await wheelAdminApi.save(wheelVersionBody(form)));
    } catch (e) {
      setFailure(message(e));
    } finally {
      setSaving(false);
    }
  }

  const num = (field: "cooldownHours" | "maxSpins" | "minAgeHours" | "minOrders", label: string, hint?: string) => (
    <Field label={label} error={shown(check.fields[field])} hint={hint}>
      <Input dir="ltr" inputMode="numeric" value={form[field]} onChange={(e) => set(field, e.target.value)} />
    </Field>
  );
  const box = (field: "isActive" | "activeService" | "phoneVerified", label: string) => (
    <Checkbox checked={form[field]} onChange={(on) => set(field, on)} label={label} />
  );

  return (
    <section className="space-y-6 rounded-2xl border border-card-border bg-card-bg p-4 md:p-6">
      <div>
        <h2 className="text-sm font-bold text-text-primary">{from ? t("common", K.editFrom, { version: from.version }) : t("common", K.newVersion)}</h2>
        <p className="mt-1 text-xs text-text-secondary">{t("common", K.startsTomorrow, { day: formatDay(dayAfter(today), lang) })}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Field label={t("common", K.fields.cap, { currency: cur })} error={shown(check.fields.cap)} hint={t("common", K.fields.capHint)}>
          <Input dir="ltr" inputMode="decimal" value={form.cap} onChange={(e) => set("cap", e.target.value)} />
        </Field>
        <div className="flex flex-col justify-center gap-1 rounded-xl bg-bg-inner p-3 text-xs md:col-span-2">
          {expected === null ? (
            <p className="text-text-secondary">{t("common", K.cost.unknown)}</p>
          ) : (
            <>
              <p className="font-bold text-text-primary">{t("common", K.cost.expected, { amount: money(expected) })}</p>
              <p className="text-text-secondary">{lasts === null ? t("common", K.cost.free) : t("common", K.cost.capLasts, { n: lasts })}</p>
            </>
          )}
        </div>
      </div>
      {box("isActive", t("common", K.fields.isActive))}

      <div className="space-y-3">
        <h3 className="text-xs font-bold text-text-primary">{t("common", K.fields.eligibility)}</h3>
        <div className="grid gap-4 md:grid-cols-3">
          {num("maxSpins", t("common", K.fields.maxSpins))}
          {num("cooldownHours", t("common", K.fields.cooldownHours))}
          {num("minAgeHours", t("common", K.fields.minAgeHours))}
          <Field label={t("common", K.fields.minPaid, { currency: cur })} error={shown(check.fields.minPaid)} hint={t("common", K.fields.optional)}>
            <Input dir="ltr" inputMode="decimal" value={form.minPaid} onChange={(e) => set("minPaid", e.target.value)} />
          </Field>
          {num("minOrders", t("common", K.fields.minOrders), t("common", K.fields.optional))}
          <Field label={t("common", K.fields.userGroup)}>
            {Array.isArray(groups) ? (
              <Select
                value={form.userGroupId}
                onChange={(v) => set("userGroupId", v)}
                options={[{ value: "", label: t("common", K.fields.everyone) }, ...groups.map((g) => ({ value: g.id, label: g.name }))]}
              />
            ) : (
              <Input
                dir="ltr"
                placeholder={t("common", K.fields.groupId)}
                value={form.userGroupId}
                onChange={(e) => set("userGroupId", e.target.value)}
              />
            )}
          </Field>
        </div>
        <div className="flex flex-wrap gap-4">
          {box("activeService", t("common", K.fields.activeService))}
          {box("phoneVerified", t("common", K.fields.phoneVerified))}
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-xs font-bold text-text-primary">{t("common", K.prizes.title)}</h3>
        {form.prizes.map((p, i) => {
          const e = tried ? check.prizes[i] ?? {} : {};
          return (
            <div key={prizeKeys[i]} className="space-y-3 rounded-xl border border-card-border p-3">
              <PrizeRowHeader
                title={
                  <>
                    {t("common", K.prizes.slot, { n: i + 1 })}
                    {odds && <span className="ms-2 font-normal text-text-secondary">{t("common", K.prizes.odds)}: {plainNumber(odds[i])}%</span>}
                  </>
                }
                index={i}
                count={form.prizes.length}
                keys={K.prizes}
                onMove={(by) => move(i, by)}
                onRemove={() => setForm((f) => ({ ...f, prizes: f.prizes.filter((_, j) => j !== i) }))}
              />
              <div className="grid gap-3 md:grid-cols-4">
                <PrizeFields
                  prize={p}
                  errors={e}
                  keys={K.prizes}
                  types={PRIZE_TYPES}
                  typeKeys={PRIZE_TYPE_KEYS}
                  templates={templates}
                  variantFieldId={`wheel-variant-${i}`}
                  ownerTenant={me?.tenant?.id ?? null}
                  // An empty slot costs nothing.
                  onPatch={(patch) => setPrize(i, { ...patch, ...(patch.prizeType === "empty" ? { costAmount: "0" } : {}) })}
                />
                <Field label={t("common", K.prizes.weight)} error={e.weight}>
                  <Input dir="ltr" inputMode="numeric" value={p.weight} onChange={(ev) => setPrize(i, { weight: ev.target.value })} />
                </Field>
                {p.prizeType !== "empty" && (
                  <Field label={t("common", K.prizes.cost, { currency: cur })} error={e.costAmount}>
                    <Input dir="ltr" inputMode="decimal" value={p.costAmount} onChange={(ev) => setPrize(i, { costAmount: ev.target.value })} />
                  </Field>
                )}
                {p.prizeType !== "empty" && (
                  <Field label={t("common", K.prizes.stock)} error={e.dailyStockLimit} hint={t("common", K.prizes.stockHint)}>
                    <Input dir="ltr" inputMode="numeric" value={p.dailyStockLimit} onChange={(ev) => setPrize(i, { dailyStockLimit: ev.target.value })} />
                  </Field>
                )}
              </div>
            </div>
          );
        })}
        {form.prizes.length < PRIZES_MAX && (
          <Button variant="quiet" size="sm" onClick={() => setForm((f) => ({ ...f, prizes: [...f.prizes, emptyPrize()] }))} icon={<Plus size={12} aria-hidden />}>
            {t("common", K.prizes.add)}
          </Button>
        )}
      </div>

      {tried && check.overall && <Alert>{t("common", check.overall)}</Alert>}
      {failure && <Alert>{failure}</Alert>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="quiet" size="sm" onClick={onCancel} disabled={saving}>
          {t("common", K.cancel)}
        </Button>
        <Button variant="primary" size="sm" onClick={save} disabled={saving}>
          {t("common", saving ? K.saving : K.save)}
        </Button>
      </div>
    </section>
  );
}
