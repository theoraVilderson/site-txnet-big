"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { userGroupsApi, type UserGroup } from "@/lib/auth-api";
import { billingApi, type AdminCoupon } from "@/lib/billing-api";
import { lotteryAdminApi, type AdminLottery, type LotteryPrizeType } from "@/lib/engagement-api";
import { displayZone } from "@/lib/time-zone";
import { usePanelSession } from "../../../_context/PanelSessionContext";
import { Select } from "../../../_components/kit/Select";
import { Field } from "../../../catalog/_components/catalog-ui";
import { VariantPicker } from "../../../coupons/_components/VariantPicker";
import {
  LOTTERY_ADMIN_KEYS as K,
  LOTTERY_PRIZE_TYPES,
  PRIZES_MAX,
  PRIZE_TYPE_KEYS,
  emptyLotteryForm,
  emptyLotteryPrize,
  lotteryDraftBody,
  lotteryFormFrom,
  validateLotteryForm,
  type LotteryForm,
  type LotteryPrizeForm,
} from "../_lib/lottery-admin";
import { useLotteryMessage } from "./lottery-admin-ui";
import { Alert, Button, Checkbox, IconButton, Input, Textarea } from "../../../_components/kit";

/**
 * A lottery's draft: a new one, or a draft rewritten whole (F-707-i rule 1).
 * The close is typed on the admin's own wall clock and sent as an instant; the
 * save goes out only when billing would take it, and billing checks it all
 * again.
 */
export function LotteryEditor({ from, onCancel, onSaved }: { from: AdminLottery | null; onCancel: () => void; onSaved: (l: AdminLottery) => void }) {
  const { t } = useLocale();
  const { me } = usePanelSession();
  const message = useLotteryMessage();
  const zone = displayZone();
  const [form, setForm] = useState<LotteryForm>(() => (from ? lotteryFormFrom(from, zone) : emptyLotteryForm()));
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Coupons to copy (ADR-0110): the tenant's own discount coupons. Groups: `user_group.manage` lists them; without it the id is typed.
  const [templates, setTemplates] = useState<AdminCoupon[] | null | "failed">(null);
  const [groups, setGroups] = useState<UserGroup[] | null | "failed">(null);
  useEffect(() => {
    let live = true;
    billingApi.adminCoupons({ kind: "discount", status: "active", pageSize: 100 }).then(
      (page) => live && setTemplates(page.items.filter((c) => c.tenantId === me?.tenant?.id)),
      () => live && setTemplates("failed"),
    );
    userGroupsApi.list().then(
      (list) => live && setGroups(list),
      () => live && setGroups("failed"),
    );
    return () => {
      live = false;
    };
  }, [me?.tenant?.id]);

  const check = useMemo(() => validateLotteryForm(form, zone, new Date()), [form, zone]);
  const shown = (key: string | undefined) => (tried ? key : undefined);
  const set = <F extends keyof LotteryForm>(field: F, value: LotteryForm[F]) => setForm((f) => ({ ...f, [field]: value }));
  const setPrize = (i: number, patch: Partial<LotteryPrizeForm>) => setForm((f) => ({ ...f, prizes: f.prizes.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
  const move = (i: number, by: -1 | 1) =>
    setForm((f) => {
      const prizes = [...f.prizes];
      [prizes[i], prizes[i + by]] = [prizes[i + by], prizes[i]];
      return { ...f, prizes };
    });

  async function save() {
    setTried(true);
    setFailure(null);
    if (!check.ok) return;
    setSaving(true);
    try {
      const body = lotteryDraftBody(form, zone);
      onSaved(await (from ? lotteryAdminApi.replace(from.id, body) : lotteryAdminApi.create(body)));
    } catch (e) {
      setFailure(message(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-6 rounded-2xl border border-card-border bg-card-bg p-4 md:p-6">
      <div>
        <h2 className="text-sm font-bold text-text-primary">{t("common", from ? K.editor.edit : K.editor.create)}</h2>
        <p className="mt-1 text-xs text-text-secondary">{t("common", K.editor.draftNote)}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t("common", K.fields.title)} error={shown(check.fields.title)}>
          <Input dir="auto" value={form.title} onChange={(e) => set("title", e.target.value)} />
        </Field>
        <Field label={t("common", K.fields.group)} error={shown(check.fields.userGroupId)}>
          {groups === null ? (
            <p className="py-2 text-xs text-text-secondary">{t("common", K.fields.groupsLoading)}</p>
          ) : Array.isArray(groups) ? (
            <Select
              value={form.userGroupId}
              onChange={(v) => set("userGroupId", v)}
              options={[{ value: "", label: t("common", K.fields.pickGroup) }, ...groups.map((g) => ({ value: g.id, label: g.name }))]}
            />
          ) : (
            <Input dir="ltr" placeholder={t("common", K.fields.groupId)} value={form.userGroupId} onChange={(e) => set("userGroupId", e.target.value)} />
          )}
        </Field>
        <div className="md:col-span-2">
          <Field label={t("common", K.fields.description)} error={shown(check.fields.description)} hint={t("common", K.fields.optional)}>
            <Textarea className="min-h-20" dir="auto" value={form.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
        </div>
        <Field label={t("common", K.fields.entryMode)}>
          <Select
            value={form.entryMode}
            onChange={(v) => set("entryMode", v as LotteryForm["entryMode"])}
            options={(["automatic", "opt_in"] as const).map((m) => ({ value: m, label: t("common", K.mode[m]) }))}
          />
        </Field>
        <Field label={t("common", K.fields.closesAt)} error={shown(check.fields.closesAt)} hint={t("common", K.fields.closesAtHint, { zone: zone ?? "—" })}>
          <Input dir="ltr" type="datetime-local" value={form.closesAt} onChange={(e) => set("closesAt", e.target.value)} />
        </Field>
      </div>

      <div className="space-y-3">
        <h3 className="text-xs font-bold text-text-primary">{t("common", K.fields.rules)}</h3>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label={t("common", K.fields.minAgeHours)} error={shown(check.fields.requiresMinAccountAgeHours)}>
            <Input dir="ltr" inputMode="numeric" value={form.requiresMinAccountAgeHours} onChange={(e) => set("requiresMinAccountAgeHours", e.target.value)} />
          </Field>
          <Field label={t("common", K.fields.reservesCount)} error={shown(check.fields.reservesCount)} hint={t("common", K.fields.reservesHint)}>
            <Input dir="ltr" inputMode="numeric" value={form.reservesCount} onChange={(e) => set("reservesCount", e.target.value)} />
          </Field>
          <Checkbox checked={form.requiresPhoneVerified} onChange={(on) => set("requiresPhoneVerified", on)} label={t("common", K.fields.phoneVerified)} />
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-xs font-bold text-text-primary">{t("common", K.prizes.title)}</h3>
        {form.prizes.map((p, i) => {
          const e = tried ? (check.prizes[i] ?? {}) : {};
          return (
            <div key={i} className="space-y-3 rounded-xl border border-card-border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-text-primary">{t("common", K.prizes.rank, { n: i + 1 })}</span>
                <div className="flex gap-1">
                  <IconButton size="sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t("common", K.prizes.moveUp)} icon={<ArrowUp size={12} aria-hidden />} />
                  <IconButton size="sm" disabled={i === form.prizes.length - 1} onClick={() => move(i, 1)} aria-label={t("common", K.prizes.moveDown)} icon={<ArrowDown size={12} aria-hidden />} />
                  <Button variant="quiet" size="sm" onClick={() => setForm((f) => ({ ...f, prizes: f.prizes.filter((_, j) => j !== i) }))} icon={<Trash2 size={12} aria-hidden />}>
                    {t("common", K.prizes.remove)}
                  </Button>
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-4">
                <Field label={t("common", K.prizes.label)} error={e.label}>
                  <Input dir="auto" value={p.label} onChange={(ev) => setPrize(i, { label: ev.target.value })} />
                </Field>
                <Field label={t("common", K.prizes.type)}>
                  <Select
                    value={p.prizeType}
                    onChange={(v) => setPrize(i, { prizeType: v as LotteryPrizeType, ...(v === "free_grant" ? { prizeValue: "0" } : {}) })}
                    options={LOTTERY_PRIZE_TYPES.map((type) => ({ value: type, label: t("common", PRIZE_TYPE_KEYS[type]) }))}
                  />
                </Field>
                {p.prizeType !== "free_grant" && (
                  <Field
                    label={t("common", p.prizeType === "bonus_traffic_gb" ? K.prizes.valueGb : p.prizeType === "extra_days" ? K.prizes.valueDays : K.prizes.valuePercent)}
                    error={e.prizeValue}
                  >
                    <Input dir="ltr" inputMode="decimal" value={p.prizeValue} onChange={(ev) => setPrize(i, { prizeValue: ev.target.value })} />
                  </Field>
                )}
                {p.prizeType === "discount_coupon" && (
                  <>
                    <Field label={t("common", K.prizes.template)} error={e.couponTemplateId}>
                      {templates === null ? (
                        <p className="py-2 text-xs text-text-secondary">{t("common", K.prizes.templatesLoading)}</p>
                      ) : templates === "failed" ? (
                        <Input
                          dir="ltr"
                          placeholder={t("common", K.prizes.templateId)}
                          value={p.couponTemplateId}
                          onChange={(ev) => setPrize(i, { couponTemplateId: ev.target.value })}
                        />
                      ) : templates.length === 0 ? (
                        <p className="py-2 text-xs text-text-secondary">{t("common", K.prizes.noTemplates)}</p>
                      ) : (
                        <Select
                          value={p.couponTemplateId}
                          onChange={(v) => setPrize(i, { couponTemplateId: v })}
                          options={templates.map((c) => ({ value: c.id, label: `${c.code}${c.label ? ` · ${c.label}` : ""}` }))}
                        />
                      )}
                    </Field>
                    <Field label={t("common", K.prizes.validDays)} error={e.couponValidDays}>
                      <Input dir="ltr" inputMode="numeric" value={p.couponValidDays} onChange={(ev) => setPrize(i, { couponValidDays: ev.target.value })} />
                    </Field>
                  </>
                )}
                {p.prizeType === "free_grant" && (
                  <Field label={t("common", K.prizes.variant)} error={e.variantId}>
                    <VariantPicker id={`lottery-variant-${i}`} value={p.variantId} onChange={(v) => setPrize(i, { variantId: v })} ownerTenant={me?.tenant?.id ?? null} invalid={!!e.variantId} />
                  </Field>
                )}
                <Field label={t("common", K.prizes.winnersCount)} error={e.winnersCount}>
                  <Input dir="ltr" inputMode="numeric" value={p.winnersCount} onChange={(ev) => setPrize(i, { winnersCount: ev.target.value })} />
                </Field>
              </div>
            </div>
          );
        })}
        {form.prizes.length < PRIZES_MAX && (
          <Button variant="quiet" size="sm" onClick={() => setForm((f) => ({ ...f, prizes: [...f.prizes, emptyLotteryPrize()] }))} icon={<Plus size={12} aria-hidden />}>
            {t("common", K.prizes.add)}
          </Button>
        )}
      </div>

      {tried && check.overall && <Alert tone="error">{t("common", check.overall)}</Alert>}
      {failure && <Alert tone="error">{failure}</Alert>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="quiet" size="sm" onClick={onCancel} disabled={saving}>
          {t("common", K.editor.cancel)}
        </Button>
        <Button variant="primary" size="sm" onClick={save} disabled={saving}>
          {t("common", saving ? K.editor.saving : K.editor.save)}
        </Button>
      </div>
    </section>
  );
}
