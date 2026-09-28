"use client";

import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { GrantActionResult, GrantRow, ResellerUserGrantsApi } from "@/lib/billing-api";
import { catalogAdminApi } from "@/lib/catalog-api";
import { DatePicker } from "../../../../../_components/kit/DatePicker";
import { formatInstant } from "../../../../../_lib/datetime";
import { formatMoney } from "../../../../../_lib/money";
import { Alert, input, primaryButton, quietButton } from "../../../../../catalog/_components/catalog-ui";
import { formatBytes } from "../../../../../services/_lib/service-configs";
import {
  GRANT_ACTION_ROUTES,
  GRANT_KEYS as G,
  REASON_REQUIRED,
  emptyDraft,
  grantActionBody,
  grantActionsOf,
  issueBody,
  type GrantAction,
  type GrantActionDraft,
} from "../../../../_lib/grant-actions";
import { USER_KEYS } from "../../../../_lib/users";
import { useUserMessage } from "./useUserMessage";

const button = "inline-flex items-center gap-1 rounded-xl border border-card-border bg-card-bg px-2.5 py-1.5 text-xs font-bold text-text-primary hover:bg-leaf-bg disabled:opacity-50";
const dangerButton = "inline-flex items-center gap-1 rounded-xl border border-error-border px-2.5 py-1.5 text-xs font-bold text-error hover:bg-error-bg disabled:opacity-50";
const panel = "space-y-2 rounded-2xl border border-card-border bg-bg-inner p-3";

/**
 * An admin's acts on one Grant (F-311-w, `panel-web/contract.reseller-users.md`),
 * over billing's `…/grants/:grantId/<route>` (F-311-d, -h..-q).
 *
 *  - **the form is the confirm**: a button opens one form that says what the
 *    act does, asks its number and its reason, and only its own button sends;
 *  - **nothing the schema refuses is sent** (`grantActionBody`): the button
 *    stays off until the body is one billing takes;
 *  - **a delete asks the refund, either way**, before it can be pressed;
 *  - **a renewal is one request per opened form** (`requestId`), so a double
 *    click renews once;
 *  - after an act the list is read again: status, end and meter are billing's.
 */
export function GrantActions({ api, row, onActed }: { api: ResellerUserGrantsApi; row: GrantRow; onActed: () => void }) {
  const { t } = useLocale();
  const message = useUserMessage();
  const [open, setOpen] = useState<GrantAction | null>(null);
  const [draft, setDraft] = useState<GrantActionDraft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ action: GrantAction; result: GrantActionResult } | null>(null);
  const [error, setError] = useState<unknown>(null);

  const offered = grantActionsOf(row);
  const body = open ? grantActionBody(open, draft) : null;

  function start(action: GrantAction) {
    setOpen(action);
    setDraft(emptyDraft());
    setError(null);
    setDone(null);
  }

  async function send() {
    if (!open || !body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.grantAction(row.id, GRANT_ACTION_ROUTES[open], body);
      setDone({ action: open, result });
      setOpen(null);
      onActed();
    } catch (e) {
      // Refused whole — the door, the fence or the Grant's state: nothing changed.
      console.error(e);
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const set = (patch: Partial<GrantActionDraft>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <section aria-label={t("common", G.title)} className="space-y-2">
      <p className="text-sm font-bold text-text-primary">{t("common", G.title)}</p>
      <div className="flex flex-wrap gap-1">
        {offered.map((action) => (
          <button key={action} type="button" className={action === "delete" ? dangerButton : button} disabled={busy} aria-pressed={open === action} onClick={() => start(action)}>
            {t("common", G.label[action])}
          </button>
        ))}
      </div>

      {open && (
        <form
          className={panel}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <p className="text-xs text-text-secondary">{t("common", G.confirm[open])}</p>
          <ActionFields action={open} draft={draft} set={set} />
          <label className="block text-xs font-bold text-text-secondary">
            {t("common", (REASON_REQUIRED as readonly string[]).includes(open) ? G.field.reason : G.field.reasonOptional)}
            <input
              className={`${input} mt-1`}
              value={draft.reason}
              maxLength={500}
              placeholder={t("common", G.field.reasonPlaceholder)}
              onChange={(e) => set({ reason: e.target.value })}
            />
          </label>
          <div className="flex gap-2">
            <button type="submit" className={open === "delete" ? dangerButton : primaryButton} disabled={busy || body === null}>
              {busy && <Loader2 size={12} className="animate-spin" aria-hidden />}
              {t("common", G.submit[open])}
            </button>
            <button type="button" className={quietButton} onClick={() => setOpen(null)}>
              {t("common", USER_KEYS.actions.cancel)}
            </button>
          </div>
        </form>
      )}

      {done && <Outcome action={done.action} result={done.result} />}
      {error !== null && <Alert>{message(error)}</Alert>}
      <p className="text-[11px] text-text-secondary">{t("common", G.hint)}</p>
    </section>
  );
}

/** The action's own fields, above the reason every form has — a bulk act's too. */
export function ActionFields({ action, draft, set }: { action: GrantAction; draft: GrantActionDraft; set: (p: Partial<GrantActionDraft>) => void }) {
  const { t } = useLocale();
  const number = (labelKey: string, value: string, patch: (v: string) => Partial<GrantActionDraft>) => (
    <label className="block text-xs font-bold text-text-secondary">
      {t("common", labelKey)}
      <input className={`${input} mt-1`} dir="ltr" inputMode="decimal" value={value} onChange={(e) => set(patch(e.target.value))} autoFocus />
    </label>
  );

  switch (action) {
    case "freeze":
      return <DatePicker label={t("common", G.field.until)} value={draft.until || null} onChange={(v) => set({ until: v ?? "" })} />;
    case "days":
      return number(G.field.days, draft.amount, (amount) => ({ amount }));
    case "traffic":
      return number(G.field.gbSigned, draft.amount, (amount) => ({ amount }));
    case "gift":
      return number(G.field.gb, draft.amount, (amount) => ({ amount }));
    case "speed":
      return number(G.field.mbps, draft.amount, (amount) => ({ amount }));
    case "devices":
      return number(G.field.devices, draft.amount, (amount) => ({ amount }));
    case "renew":
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          {number(G.field.renewGb, draft.amount, (amount) => ({ amount }))}
          {number(G.field.renewDays, draft.days, (days) => ({ days }))}
        </div>
      );
    case "delete":
      return (
        <fieldset className="space-y-1 text-xs text-text-primary">
          <legend className="mb-1 font-bold text-text-secondary">{t("common", G.field.refund)}</legend>
          {([true, false] as const).map((refund) => (
            <label key={String(refund)} className="flex items-center gap-2">
              <input type="radio" name="refund" checked={draft.refund === refund} onChange={() => set({ refund })} />
              {t("common", refund ? G.field.refundYes : G.field.refundNo)}
            </label>
          ))}
        </fieldset>
      );
    default:
      return null;
  }
}

/** What billing answered, in the admin's words — each route fills its own fields. */
function Outcome({ action, result }: { action: GrantAction; result: GrantActionResult }) {
  const { t, lang } = useLocale();
  const size = (bytes: string | undefined) => formatBytes(bytes ?? null, lang) ?? "";
  const lines: string[] = [];

  switch (action) {
    case "freeze":
      lines.push(t("common", G.done.freeze, { count: result.configsDisabled ?? 0 }));
      break;
    case "unfreeze":
      lines.push(t("common", G.done.unfreeze, { count: result.configsRestored ?? 0 }));
      break;
    case "days":
      lines.push(t("common", G.done.days, { date: formatInstant(result.endsAtAfter ?? null, lang, { withTime: false }) ?? "" }));
      break;
    case "traffic":
    case "gift":
      lines.push(t("common", G.done[action], { size: size(result.purchasedBytesAfter) }));
      break;
    case "reset":
      lines.push(t("common", G.done.reset, { size: size(result.resetBytes) }));
      break;
    case "speed":
      lines.push(result.rateMbpsAfter == null ? t("common", G.done.speedLifted) : t("common", G.done.speed, { value: `${result.rateMbpsAfter} Mbps` }));
      break;
    case "devices":
      lines.push(result.limitAfter == null ? t("common", G.done.devicesLifted) : t("common", G.done.devices, { value: result.limitAfter }));
      if (result.panelsNotEnforcing?.length) lines.push(t("common", G.done.notEnforcing, { panels: result.panelsNotEnforcing.map((p) => p.name).join(lang === "fa" ? "، " : ", ") }));
      break;
    case "rotate":
      lines.push(t("common", G.done.rotate));
      break;
    case "renew":
      lines.push(t("common", result.renewed === false ? G.done.renewRepeat : G.done.renew));
      break;
    case "delete":
      lines.push(t("common", G.done.delete));
      if (result.refundedAmount && result.currencyCode) lines.push(t("common", G.done.refunded, { amount: formatMoney(result.refundedAmount, result.currencyCode, { lang, t }) }));
      else if (result.refundSkipped) lines.push(t("common", G.done.refundSkipped));
      break;
  }
  if (result.spent) lines.push(t("common", G.done.spent));
  if (result.revived) lines.push(t("common", G.done.revived));

  return (
    <div role="status" className="space-y-1 rounded-2xl bg-leaf-bg px-3 py-2 text-xs font-bold text-primary">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {result.subscriptionUrl && (
        <p className="break-all font-mono text-[11px] font-normal text-text-secondary" dir="ltr">
          {result.subscriptionUrl}
        </p>
      )}
    </div>
  );
}

interface IssuableVariant {
  id: string;
  label: string;
}

/**
 * Give the user a new service by hand (F-311-o): a variant of the reseller's
 * own catalog, read the first time the form opens — its products, then each
 * one's variants, the switched-off left out. One `requestId` per opened form,
 * so a double click issues once; billing refuses what it could not place.
 */
export function IssueGrant({
  api,
  tenantId,
  texts,
  onIssued,
}: {
  api: ResellerUserGrantsApi;
  tenantId: string;
  texts: Record<string, string>;
  onIssued: () => void;
}) {
  const { t } = useLocale();
  const message = useUserMessage();
  const [open, setOpen] = useState(false);
  const [variants, setVariants] = useState<IssuableVariant[] | null>(null);
  const [variantId, setVariantId] = useState("");
  const [reason, setReason] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<boolean | null>(null);
  const [error, setError] = useState<unknown>(null);

  const body = issueBody(variantId, requestId, reason);

  async function readVariants() {
    const catalog = catalogAdminApi(tenantId);
    const products = (await catalog.products()).filter((p) => p.isActive && p.archivedAt === null);
    const details = await Promise.all(products.map((p) => catalog.product(p.id)));
    return details.flatMap((p) =>
      p.variants
        .filter((v) => v.isActive)
        .map((v) => {
          const name = texts[v.nameKey ?? p.nameKey] || texts[p.nameKey];
          return { id: v.id, label: name ? `${name} · ${v.sku}` : v.sku };
        }),
    );
  }

  function start() {
    setOpen(true);
    setVariantId("");
    setReason("");
    setRequestId(crypto.randomUUID());
    setDone(null);
    setError(null);
    if (variants !== null) return;
    readVariants()
      .then(setVariants)
      .catch((e) => {
        setOpen(false);
        setError(e);
      });
  }

  async function send() {
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await api.issue(body);
      setDone(answer.issued);
      setOpen(false);
      onIssued();
    } catch (e) {
      console.error(e);
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <button type="button" className={primaryButton} disabled={busy} onClick={start}>
        <Plus size={12} aria-hidden />
        {t("common", G.label.issue)}
      </button>
      {open && (
        <form
          className={panel}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <p className="text-xs text-text-secondary">{t("common", G.confirm.issue)}</p>
          {variants === null ? (
            <p className="flex items-center gap-2 text-xs text-text-secondary">
              <Loader2 size={12} className="animate-spin" aria-hidden />
              {t("common", G.field.variantsLoading)}
            </p>
          ) : variants.length === 0 ? (
            <p className="text-xs text-text-secondary">{t("common", G.field.variantsNone)}</p>
          ) : (
            <label className="block text-xs font-bold text-text-secondary">
              {t("common", G.field.variant)}
              <select className={`${input} mt-1`} value={variantId} onChange={(e) => setVariantId(e.target.value)}>
                <option value="">{t("common", G.field.variantPick)}</option>
                {variants.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-xs font-bold text-text-secondary">
            {t("common", G.field.reasonOptional)}
            <input className={`${input} mt-1`} value={reason} maxLength={500} placeholder={t("common", G.field.reasonPlaceholder)} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="flex gap-2">
            <button type="submit" className={primaryButton} disabled={busy || body === null}>
              {busy && <Loader2 size={12} className="animate-spin" aria-hidden />}
              {t("common", G.submit.issue)}
            </button>
            <button type="button" className={quietButton} onClick={() => setOpen(false)}>
              {t("common", USER_KEYS.actions.cancel)}
            </button>
          </div>
        </form>
      )}
      {done !== null && (
        <p role="status" className="text-xs font-bold text-primary">
          {t("common", done ? G.done.issue : G.done.issueRepeat)}
        </p>
      )}
      {error !== null && <Alert>{message(error)}</Alert>}
    </div>
  );
}
