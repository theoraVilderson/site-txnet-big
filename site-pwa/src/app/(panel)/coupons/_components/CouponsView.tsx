"use client";

import { useCallback, useEffect, useState } from "react";
import { BarChart3, Pencil, Plus, Power, RotateCw, Search, TicketPercent, Trash2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { billingApi, type AdminCoupon, type CouponListQuery, type CouponPage } from "@/lib/billing-api";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { Pagination } from "../../_components/kit/Pagination";
import { Select } from "../../_components/kit/Select";
import { formatMoney } from "../../_lib/money";
import { formatInstant } from "../../_lib/datetime";
import { COUPON_KEYS as K, STATUS_TONES, isPlatformOwner, refusalKey } from "../_lib/coupon-form";
import { CouponForm } from "./CouponForm";
import { CouponUsage } from "./CouponUsage";
import { DiscountRules } from "./DiscountRules";
import { GiftCodes } from "./GiftCodes";
import { ListSkeleton } from "./ListSkeleton";

const PAGE_SIZE = 20;
type Tab = "discount" | "gift" | "rules";

/**
 * The coupons page (F-502-g, D-33). Tab 1 lists discount coupons; tab 2 is
 * gift-code batches (F-502-h, `GiftCodes.tsx`); tab 3 is discounts with no
 * code (F-114-k, `DiscountRules.tsx`) — the caller's own tenant's only.
 *
 * One page for two audiences, and the page decides neither: billing answers
 * the platform owner every coupon and a tenant its own. The owner's scope
 * filter only narrows that answer.
 *
 * Nothing is patched into the list from a write's answer: billing decides what
 * a delete did (gone, or hidden because used), and the list it answers next is
 * the honest picture.
 */
export function CouponsView() {
  const { t } = useLocale();
  const { me, isLoading: sessionLoading } = usePanelSession();
  const owner = isPlatformOwner(me);
  const [tab, setTab] = useState<Tab>("discount");

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold text-text-primary">
            <TicketPercent size={18} className="text-primary" aria-hidden />
            {t("common", K.title)}
          </h1>
          <p className="text-xs text-text-secondary">{t("common", K.subtitle)}</p>
        </div>
      </header>

      <div role="tablist" className="flex gap-2 rounded-2xl border border-card-border bg-card-bg p-1 shadow-sm">
        {(["discount", "gift", "rules"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`flex-1 rounded-xl px-3 py-2 text-sm font-bold transition-colors ${tab === id ? "bg-primary text-white shadow-sm" : "text-text-secondary hover:text-text-primary"}`}
          >
            {t("common", K.tabs[id])}
          </button>
        ))}
      </div>

      {sessionLoading ? <ListSkeleton label={t("common", K.loading)} /> : tab === "discount" ? <DiscountCoupons owner={owner} /> : tab === "gift" ? <GiftCodes me={me} owner={owner} /> : <DiscountRules me={me} />}
    </div>
  );
}

function DiscountCoupons({ owner }: { owner: boolean }) {
  const { t, lang } = useLocale();
  const errorMessage = useApiErrorMessage();
  const { me } = usePanelSession();
  const [query, setQuery] = useState<CouponListQuery>({ kind: "discount", page: 1, pageSize: PAGE_SIZE });
  const [search, setSearch] = useState("");
  const [data, setData] = useState<CouponPage | null>(null);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<AdminCoupon | "new" | null>(null);
  const [usageOf, setUsageOf] = useState<AdminCoupon | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const message = (e: unknown) => {
    const key = refusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };

  const load = useCallback(async (q: CouponListQuery) => {
    try {
      setData(await billingApi.adminCoupons(q));
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Every setState in load runs after its first await, as in `useGateways`.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(query);
  }, [load, query]);

  const reload = () => load(query);
  const narrow = (patch: Partial<CouponListQuery>) => setQuery((q) => ({ ...q, ...patch, page: 1 }));

  const toggle = async (c: AdminCoupon) => {
    setActionError(null);
    try {
      await billingApi.updateCoupon(c.id, { isActive: !c.isActive });
      setNotice(t("common", K.saved));
      await reload();
    } catch (e) {
      setActionError(message(e));
    }
  };

  const remove = async (c: AdminCoupon) => {
    if (!window.confirm(t("common", K.confirmDelete, { code: c.code }))) return;
    setActionError(null);
    try {
      const out = await billingApi.deleteCoupon(c.id);
      setNotice(t("common", out.mode === "deleted" ? K.deleted : K.softDeleted));
      await reload();
    } catch (e) {
      setActionError(message(e));
    }
  };

  const money = (amount: string, currency: string) => formatMoney(amount, currency, { lang, t });
  const discountText = (c: AdminCoupon) =>
    c.discountType === "free_grant"
      ? t("common", K.form.freeService)
      : c.discountType === "percentage"
      ? `${t("common", K.list.percentOff, { value: Number(c.discountValue).toString() })}${c.maxDiscountCap ? ` · ${t("common", K.list.cap, { amount: money(c.maxDiscountCap, c.currencyCode) })}` : ""}`
      : t("common", K.list.amountOff, { amount: money(c.discountValue, c.currencyCode) });
  const hasLimits = (c: AdminCoupon) =>
    Boolean(c.minPurchaseAmount || c.maxPurchaseAmount || c.validFrom || c.activeWeekdays.length || c.activeHourFrom !== null || c.firstPurchaseOnly || c.newUserWithinDays || c.periodDays || c.allowedChannels.length || c.gateways.length || c.serviceScopes.length);

  const statusOptions = [
    { value: "", label: t("common", K.filters.all) },
    ...(["active", "inactive", "expired", "deleted"] as const).map((s) => ({ value: s, label: t("common", K.status[s]) })),
  ];
  const scope = query.tenantId === undefined ? "" : query.tenantId === "platform" ? "platform" : "tenant";
  const scopeOptions = [
    { value: "", label: t("common", K.filters.scopeAll) },
    { value: "platform", label: t("common", K.filters.scopePlatform) },
    { value: "tenant", label: t("common", K.filters.scopeTenant) },
  ];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <form
          className="relative min-w-48 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            narrow({ q: search.trim() || undefined });
          }}
        >
          <Search size={14} className="pointer-events-none absolute inset-y-0 start-3 my-auto text-text-secondary" aria-hidden />
          <input
            aria-label={t("common", K.filters.search)}
            placeholder={t("common", K.filters.search)}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onBlur={() => narrow({ q: search.trim() || undefined })}
            className="w-full rounded-xl border border-card-border bg-[var(--bg-inner)] py-2.5 ps-9 pe-3 text-sm text-[var(--text-input)] focus:border-[var(--accent-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-glow)]"
          />
        </form>
        <div className="w-40">
          <Select ariaLabel={t("common", K.filters.status)} value={query.status ?? ""} onChange={(v) => narrow({ status: (v || undefined) as CouponListQuery["status"] })} options={statusOptions} />
        </div>
        {owner && (
          <div className="w-40">
            <Select
              ariaLabel={t("common", K.filters.scope)}
              value={scope}
              onChange={(v) => narrow({ tenantId: v === "" ? undefined : v === "platform" ? "platform" : "" })}
              options={scopeOptions}
            />
          </div>
        )}
        {owner && scope === "tenant" && (
          <input
            dir="ltr"
            aria-label={t("common", K.filters.tenantId)}
            placeholder={t("common", K.filters.tenantId)}
            defaultValue={query.tenantId === "platform" ? "" : query.tenantId}
            onBlur={(e) => narrow({ tenantId: e.target.value.trim() })}
            className="w-72 max-w-full rounded-xl border border-card-border bg-[var(--bg-inner)] px-3 py-2.5 font-mono text-xs text-[var(--text-input)] focus:border-[var(--accent-primary)] focus:outline-none"
          />
        )}
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
        <ListSkeleton label={t("common", K.loading)} />
      ) : (
        <section className="relative rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm sm:p-6">
          {error ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p role="alert" className="text-xs font-bold text-error">
                {message(error)}
              </p>
              <button type="button" onClick={() => void reload()} className="inline-flex items-center gap-1 text-xs font-bold text-primary">
                <RotateCw size={14} aria-hidden />
                {t("common", K.retry)}
              </button>
            </div>
          ) : !data || data.items.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <span className="grid size-14 place-items-center rounded-2xl bg-[var(--leaf-bg)] text-primary">
                <TicketPercent size={26} aria-hidden />
              </span>
              <p className="text-sm text-text-secondary">{t("common", K.empty)}</p>
            </div>
          ) : (
            <ul className="divide-y divide-card-border">
              {data.items.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-bold text-text-primary">
                      <span dir="ltr" className="font-mono">
                        {c.code}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${STATUS_TONES[c.status]}`}>{t("common", K.status[c.status])}</span>
                      {owner && (
                        <span className="rounded-full bg-[var(--leaf-bg)] px-2 py-0.5 text-[10px] font-bold text-text-secondary">
                          {c.tenantId === null ? t("common", K.list.platform) : t("common", K.list.tenant, { id: c.tenantId.slice(0, 8) })}
                        </span>
                      )}
                      {c.visibility === "targeted" && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">{t("common", K.list.targeted)}</span>}
                      {hasLimits(c) && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">{t("common", K.list.limited)}</span>}
                    </span>
                    {c.label && <span className="text-xs text-text-primary">{c.label}</span>}
                    <span className="text-xs text-text-secondary">
                      {discountText(c)} ·{" "}
                      {c.totalUsageLimit === null
                        ? t("common", K.list.used, { used: String(c.usedCount) })
                        : t("common", K.list.usedOf, { used: String(c.usedCount), limit: String(c.totalUsageLimit) })}
                      {c.reservedCount > 0 && ` · ${t("common", K.list.reserved, { count: String(c.reservedCount) })}`} ·{" "}
                      {c.expiresAt ? t("common", K.list.expires, { date: formatInstant(c.expiresAt, lang) ?? "" }) : t("common", K.list.noExpiry)}
                    </span>
                  </div>
                  {c.status !== "deleted" && (
                    <div className="flex flex-wrap items-center gap-1">
                      <RowButton icon={BarChart3} label={t("common", K.list.usage)} onClick={() => setUsageOf(c)} />
                      <RowButton icon={Pencil} label={t("common", K.list.edit)} onClick={() => setEditing(c)} />
                      <RowButton icon={Power} label={t("common", c.isActive ? K.list.deactivate : K.list.activate)} onClick={() => void toggle(c)} />
                      <RowButton icon={Trash2} label={t("common", K.list.delete)} tone="error" onClick={() => void remove(c)} />
                    </div>
                  )}
                  {c.status === "deleted" && <RowButton icon={BarChart3} label={t("common", K.list.usage)} onClick={() => setUsageOf(c)} />}
                </li>
              ))}
            </ul>
          )}
          {data && totalPages > 1 && (
            <div className="mt-4">
              <Pagination page={data.page} totalPages={totalPages} totalItems={data.total} pageSize={data.pageSize} onPageChange={(page) => setQuery((q) => ({ ...q, page }))} />
            </div>
          )}
        </section>
      )}

      {editing && (
        <CouponForm
          me={me}
          coupon={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (text) => {
            setEditing(null);
            setNotice(text);
            await reload();
          }}
        />
      )}
      {usageOf && <CouponUsage coupon={usageOf} onClose={() => setUsageOf(null)} />}
    </>
  );
}

function RowButton({ icon: Icon, label, onClick, tone = "primary" }: { icon: typeof Pencil; label: string; onClick: () => void; tone?: "primary" | "error" }) {
  return (
    <button type="button" onClick={onClick} className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold ${tone === "error" ? "text-error" : "text-primary"}`}>
      <Icon size={14} aria-hidden />
      {label}
    </button>
  );
}
