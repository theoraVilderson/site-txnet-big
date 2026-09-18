"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type TenantLedgerDirection } from "@/lib/billing-api";
import {
  tenantApi,
  type Reseller,
  type ResellerBillingModel,
  type SettableStatus,
  type TenantPackage,
  type TenantSubscription,
} from "@/lib/tenant-api";
import { Select } from "../../_components/kit/Select";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { formatInstant } from "../../_lib/datetime";
import { BASE_CURRENCY, formatMoney } from "../../_lib/money";
import {
  BILLING_MODELS,
  RESELLER_KEYS as K,
  adjustBody,
  canAdjustWallet,
  emptyAdjustForm,
  isNoSubscription,
  packageChoices,
  priceFor,
  statusBody,
  statusChoices,
  validateAdjust,
  validateStatus,
  type AdjustForm,
  type Errors,
  type StatusForm,
} from "../_lib/resellers";
import { Alert, Field, Sheet, input, primaryButton, useMessage } from "./resellers-ui";
import { StatusBadge } from "./ResellersView";

type Loaded = { reseller: Reseller; subscription: TenantSubscription | null; packages: TenantPackage[] };

/**
 * One reseller (F-018-k): who owns it and where it is served, then the three
 * things the platform owner changes — package and period (F-018-e), status
 * (F-018-f) and, with `tenant_billing.adjust`, its billing balance (F-019-a).
 * Each section re-reads the reseller after it writes: every figure shown is the
 * services' answer, never one computed here.
 */
export function ResellerSheet({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { lang, t } = useLocale();
  const { me } = usePanelSession();
  const message = useMessage();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [reseller, subscription, packages] = await Promise.all([
          tenantApi.reseller(id),
          tenantApi.subscription(id).catch((e) => {
            if (isNoSubscription(e)) return null;
            throw e;
          }),
          tenantApi.packages(),
        ]);
        if (alive) {
          setData({ reseller, subscription, packages });
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, asked]);

  const changed = useCallback(() => {
    setAsked((n) => n + 1);
    onChanged();
  }, [onChanged]);

  const r = data?.reseller;
  return (
    <Sheet
      title={
        r ? (
          <span className="flex items-center gap-2">
            <span dir="ltr">{r.slug}</span>
            <StatusBadge status={r.status} />
          </span>
        ) : (
          t("common", K.title)
        )
      }
      onClose={onClose}
    >
      {error && !data ? (
        <Alert>{message(error)}</Alert>
      ) : !data || !r ? (
        <Loader2 size={18} className="mx-auto animate-spin text-text-secondary" aria-hidden />
      ) : (
        <>
          <dl className="grid gap-3 text-xs sm:grid-cols-2">
            <Fact label={t("common", K.columns.owner)}>
              {r.owner ? (
                <>
                  {r.owner.fullName || r.owner.username}
                  <span dir="ltr" className="block text-[11px] text-text-secondary">
                    {r.owner.phoneNumber ?? r.owner.username}
                  </span>
                </>
              ) : (
                "—"
              )}
            </Fact>
            <Fact label={t("common", K.columns.balance)}>
              <span dir="ltr">{formatMoney(r.billingBalance, BASE_CURRENCY, { lang, t })}</span>
            </Fact>
            <Fact label={t("common", K.columns.created)}>{formatInstant(r.createdAt, lang)}</Fact>
            <Fact label={t("common", K.detail.domains)}>
              {r.domains.length === 0
                ? t("common", K.detail.noDomains)
                : r.domains.map((d) => (
                    <a
                      key={d.domainValue}
                      href={`https://${d.domainValue}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      dir="ltr"
                      className="flex items-center gap-1 text-primary hover:underline"
                    >
                      {d.domainValue}
                      <ExternalLink size={11} aria-label={t("common", K.detail.open)} />
                    </a>
                  ))}
            </Fact>
          </dl>

          <SubscriptionSection loaded={data} onSaved={changed} />
          <StatusSection reseller={r} onSaved={changed} />
          {canAdjustWallet(me) && r.status !== "terminated" && <AdjustSection reseller={r} onSaved={changed} />}
        </>
      )}
    </Sheet>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl bg-bg-inner p-3">
      <dt className="text-[11px] text-text-secondary">{label}</dt>
      <dd className="mt-1 font-bold text-text-primary">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-card-border p-4">
      <h3 className="text-sm font-bold text-text-primary">{title}</h3>
      {children}
    </section>
  );
}

/** Runs one write: a busy flag, the refusal's sentence, a notice on success. */
function useWrite() {
  const message = useMessage();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run = async (write: () => Promise<string>) => {
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      setNotice(await write());
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  };
  const feedback = (
    <>
      {failure && <Alert>{failure}</Alert>}
      {notice && <p className="text-xs font-bold text-primary">{notice}</p>}
    </>
  );
  return { busy, run, feedback };
}

function SubscriptionSection({ loaded, onSaved }: { loaded: Loaded; onSaved: () => void }) {
  const { lang, t } = useLocale();
  const { reseller, subscription, packages } = loaded;
  const initialPeriod: ResellerBillingModel =
    subscription?.billingModel ?? (reseller.billingModel === "subscription_yearly" ? "subscription_yearly" : "subscription_monthly");
  const [period, setPeriod] = useState<ResellerBillingModel>(initialPeriod);
  const choices = useMemo(() => packageChoices(packages, period, subscription?.packageId ?? null), [packages, period, subscription]);
  const [packageId, setPackageId] = useState(subscription?.packageId ?? "");
  const [missing, setMissing] = useState(false);
  const { busy, run, feedback } = useWrite();
  const terminated = reseller.status === "terminated";

  const submit = () => {
    if (!choices.some((p) => p.id === packageId)) {
      setMissing(true);
      return;
    }
    setMissing(false);
    void run(async () => {
      await tenantApi.setSubscription(reseller.id, { packageId, billingModel: period });
      onSaved();
      return t("common", K.subscription.done);
    });
  };

  return (
    <Section title={t("common", K.subscription.title)}>
      <p className="text-xs text-text-secondary">
        {subscription
          ? t("common", K.subscription.current, {
              package: subscription.packageName,
              period: t("common", K.period[subscription.billingModel]),
              date: formatInstant(subscription.currentPeriodEnd, lang, { withTime: false }) ?? "—",
            })
          : t("common", K.subscription.none)}
      </p>
      {!terminated && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("common", K.subscription.period)}>
              <Select
                value={period}
                onChange={(v) => setPeriod(v as ResellerBillingModel)}
                options={BILLING_MODELS.map((m) => ({ value: m, label: t("common", K.period[m]) }))}
              />
            </Field>
            <Field label={t("common", K.subscription.package)} error={missing ? K.errors.packageId : undefined}>
              {choices.length === 0 ? (
                <span className="text-[11px] font-normal">{t("common", K.subscription.noPackage)}</span>
              ) : (
                <Select
                  value={packageId}
                  onChange={setPackageId}
                  placeholder={t("common", K.subscription.package)}
                  options={choices.map((p) => ({
                    value: p.id,
                    label: `${p.name} — ${formatMoney(priceFor(p, period) ?? "0", BASE_CURRENCY, { lang, t })}`,
                  }))}
                />
              )}
            </Field>
          </div>
          {subscription && <p className="text-[11px] text-text-secondary">{t("common", K.subscription.keepsPeriodEnd)}</p>}
          <div>
            <button type="button" className={primaryButton} disabled={busy || choices.length === 0} onClick={submit}>
              {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
              {t("common", K.subscription.submit)}
            </button>
          </div>
        </>
      )}
      {feedback}
    </Section>
  );
}

function StatusSection({ reseller, onSaved }: { reseller: Reseller; onSaved: () => void }) {
  const { t } = useLocale();
  const choices = statusChoices(reseller.status);
  const [form, setForm] = useState<StatusForm>({ status: "", reason: "", confirmed: false });
  const [errors, setErrors] = useState<Errors<StatusForm>>({});
  const { busy, run, feedback } = useWrite();
  const set = (patch: Partial<StatusForm>) => setForm((f) => ({ ...f, ...patch }));

  if (choices.length === 0) {
    return (
      <Section title={t("common", K.statusChange.title)}>
        <p className="text-xs text-text-secondary">{t("common", K.statusChange.final)}</p>
      </Section>
    );
  }

  const submit = () => {
    const found = validateStatus(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    void run(async () => {
      await tenantApi.setStatus(reseller.id, statusBody(form));
      setForm({ status: "", reason: "", confirmed: false });
      onSaved();
      return t("common", K.statusChange.done);
    });
  };

  return (
    <Section title={t("common", K.statusChange.title)}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("common", K.statusChange.to)} error={errors.status}>
          <Select
            value={form.status}
            onChange={(v) => set({ status: v as SettableStatus, confirmed: false })}
            placeholder={t("common", K.statusChange.to)}
            options={choices.map((s) => ({ value: s, label: t("common", K.status[s]) }))}
          />
        </Field>
        <Field label={t("common", K.statusChange.reason)} error={errors.reason}>
          <input className={input} value={form.reason} maxLength={500} onChange={(e) => set({ reason: e.target.value })} />
        </Field>
      </div>
      {form.status === "terminated" && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-bold text-error">{t("common", K.statusChange.terminateWarning)}</p>
          <label className="flex items-center gap-2 text-xs text-text-primary">
            <input type="checkbox" checked={form.confirmed} onChange={(e) => set({ confirmed: e.target.checked })} />
            {t("common", K.statusChange.confirmTerminate)}
          </label>
          {errors.confirm && <p className="text-[11px] text-error">{t("common", errors.confirm)}</p>}
        </div>
      )}
      <div>
        <button type="button" className={primaryButton} disabled={busy} onClick={submit}>
          {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
          {t("common", K.statusChange.submit)}
        </button>
      </div>
      {feedback}
    </Section>
  );
}

function AdjustSection({ reseller, onSaved }: { reseller: Reseller; onSaved: () => void }) {
  const { lang, t } = useLocale();
  const [form, setForm] = useState<AdjustForm>(emptyAdjustForm);
  const [errors, setErrors] = useState<Errors<AdjustForm>>({});
  // One id per filled form: a retry of the same form after a lost answer is
  // then `duplicate_request`, never a second movement. Editing mints a new one.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const { busy, run, feedback } = useWrite();
  const set = (patch: Partial<AdjustForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setRequestId(crypto.randomUUID());
  };

  const submit = () => {
    const found = validateAdjust(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    void run(async () => {
      const done = await billingApi.adjustTenantWallet(reseller.id, adjustBody(form, requestId));
      setForm(emptyAdjustForm());
      setRequestId(crypto.randomUUID());
      onSaved();
      return t("common", K.adjust.done, { balance: formatMoney(done.balanceAfter, BASE_CURRENCY, { lang, t }) });
    });
  };

  return (
    <Section title={t("common", K.adjust.title)}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t("common", K.adjust.direction)}>
          <Select
            value={form.direction}
            onChange={(v) => set({ direction: v as TenantLedgerDirection })}
            options={[
              { value: "credit", label: t("common", K.adjust.credit) },
              { value: "debit", label: t("common", K.adjust.debit) },
            ]}
          />
        </Field>
        <Field label={`${t("common", K.adjust.amount)} (${BASE_CURRENCY})`} error={errors.amount}>
          <input className={input} dir="ltr" inputMode="decimal" value={form.amount} onChange={(e) => set({ amount: e.target.value })} />
        </Field>
        <Field label={t("common", K.adjust.note)} error={errors.note}>
          <input className={input} value={form.note} maxLength={500} onChange={(e) => set({ note: e.target.value })} />
        </Field>
      </div>
      <div>
        <button type="button" className={primaryButton} disabled={busy} onClick={submit}>
          {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
          {t("common", K.adjust.submit)}
        </button>
      </div>
      {feedback}
    </Section>
  );
}
