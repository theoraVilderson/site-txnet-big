"use client";

import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { type GrantActionResult, type GrantRow, type ResellerUserGrantsApi } from "@/lib/billing-api";
import { DatePicker } from "../../../../../_components/kit/DatePicker";
import { formatInstant } from "../../../../../_lib/datetime";
import { formatMoney } from "../../../../../_lib/money";
import { formatBytes } from "../../../../../services/_lib/service-configs";
import {
  ADMIN_FREEZE_MODES,
  GRANT_ACTION_KEY,
  GRANT_ACTION_METHODS,
  GRANT_ACTION_ROUTES,
  GRANT_KEYS as G,
  REASON_REQUIRED,
  emptyDraft,
  grantActionBody,
  grantActionsOf,
  type GrantAction,
  type GrantActionDraft,
} from "../../../../_lib/grant-actions";
import { USER_KEYS } from "../../../../_lib/users";
import { useUserMessage } from "./useUserMessage";
import { useMayGrant } from "./grant-keys-context";
import { Alert, Button, Field, Input } from "../../../../../_components/kit";
import { formatList } from "../../../../../_lib/digits";

/** The one open form's frame — an act's here, an issue's in `IssueGrant`. */
export const panel = "space-y-2 rounded-2xl border border-card-border bg-bg-inner p-3";

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
 *  - **a freeze names its mode** (F-0401-f): hard unless the admin picks
 *    soft; a frozen Grant's mode form opens on the other one;
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

  const may = useMayGrant();
  // Only the acts this viewer's keys open (KS-1-a): an agent with `grant.repair` gets the link alone.
  const offered = grantActionsOf(row).filter((a) => may(GRANT_ACTION_KEY[a]));
  const body = open ? grantActionBody(open, draft) : null;

  function start(action: GrantAction) {
    setOpen(action);
    // A mode change opens on the mode the Grant does not have: the same one is billing's `freeze_mode_unchanged`.
    setDraft({ ...emptyDraft(), ...(action === "freezeMode" && row.freezeMode === "hard" ? { freezeMode: "soft" } : {}) });
    setError(null);
    setDone(null);
  }

  async function send() {
    if (!open || !body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.grantAction(row.id, GRANT_ACTION_ROUTES[open], body, GRANT_ACTION_METHODS[open]);
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
  if (offered.length === 0) return null;

  return (
    <section aria-label={t("common", G.title)} className="space-y-2">
      <p className="text-sm font-bold text-text-primary">{t("common", G.title)}</p>
      <div className="flex flex-wrap gap-1">
        {offered.map((action) => (
          <Button
            key={action}
            size="sm"
            className={action === "delete" ? "text-error hover:border-error hover:bg-error-bg hover:text-error" : undefined}
            disabled={busy}
            aria-pressed={open === action}
            onClick={() => start(action)}
          >
            {t("common", G.label[action])}
          </Button>
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
          <Field label={t("common", (REASON_REQUIRED as readonly string[]).includes(open) ? G.field.reason : G.field.reasonOptional)}>
            <Input
              className="mt-1"
              value={draft.reason}
              maxLength={500}
              placeholder={t("common", G.field.reasonPlaceholder)}
              onChange={(e) => set({ reason: e.target.value })}
            />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant={open === "delete" ? "danger" : "primary"} disabled={body === null} loading={busy}>
              {t("common", G.submit[open])}
            </Button>
            <Button variant="quiet" size="sm" onClick={() => setOpen(null)}>
              {t("common", USER_KEYS.actions.cancel)}
            </Button>
          </div>
        </form>
      )}

      {done && <Outcome action={done.action} result={done.result} />}
      {error !== null && <Alert tone="error">{message(error)}</Alert>}
      <p className="text-2xs text-text-secondary">{t("common", G.hint)}</p>
    </section>
  );
}

/** The action's own fields, above the reason every form has — a bulk act's too. */
export function ActionFields({ action, draft, set }: { action: GrantAction; draft: GrantActionDraft; set: (p: Partial<GrantActionDraft>) => void }) {
  const { t } = useLocale();
  const number = (labelKey: string, value: string, patch: (v: string) => Partial<GrantActionDraft>) => (
    <Field label={t("common", labelKey)}>
      <Input className="mt-1" dir="ltr" inputMode="decimal" value={value} onChange={(e) => set(patch(e.target.value))} autoFocus />
    </Field>
  );

  switch (action) {
    case "freeze":
      return (
        <>
          <FreezeModeField draft={draft} set={set} />
          <DatePicker label={t("common", G.field.until)} value={draft.until || null} onChange={(v) => set({ until: v ?? "" })} />
        </>
      );
    case "freezeMode":
      return <FreezeModeField draft={draft} set={set} />;
    case "compensate":
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          {number(G.field.compensateDays, draft.days, (days) => ({ days }))}
          {number(G.field.compensateGb, draft.amount, (amount) => ({ amount }))}
        </div>
      );
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

/** Who may lift the freeze (F-0401-d): hard, only an admin; soft, the user too. */
function FreezeModeField({ draft, set }: { draft: GrantActionDraft; set: (p: Partial<GrantActionDraft>) => void }) {
  const { t } = useLocale();
  return (
    <fieldset className="space-y-1 text-xs text-text-primary">
      <legend className="mb-1 font-bold text-text-secondary">{t("common", G.field.freezeMode)}</legend>
      {ADMIN_FREEZE_MODES.map((mode) => (
        <label key={mode} className="flex items-center gap-2">
          <input type="radio" name="freezeMode" checked={draft.freezeMode === mode} onChange={() => set({ freezeMode: mode })} />
          {t("common", mode === "hard" ? G.field.modeHard : G.field.modeSoft)}
        </label>
      ))}
    </fieldset>
  );
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
    case "freezeMode":
      lines.push(t("common", result.freezeMode === "soft" ? G.done.freezeModeSoft : G.done.freezeModeHard));
      break;
    case "days":
      lines.push(t("common", G.done.days, { date: formatInstant(result.endsAtAfter ?? null, lang, { withTime: false }) ?? "" }));
      break;
    case "traffic":
    case "gift":
      lines.push(t("common", G.done[action], { size: size(result.purchasedBytesAfter) }));
      break;
    // Days or traffic, as billing answered (KS-1-c): the same sentences as those acts.
    case "compensate":
      if (result.endsAtAfter) lines.push(t("common", G.done.days, { date: formatInstant(result.endsAtAfter, lang, { withTime: false }) ?? "" }));
      else lines.push(t("common", G.done.traffic, { size: size(result.purchasedBytesAfter) }));
      break;
    case "reset":
      lines.push(t("common", G.done.reset, { size: size(result.resetBytes) }));
      break;
    case "speed":
      lines.push(result.rateMbpsAfter == null ? t("common", G.done.speedLifted) : t("common", G.done.speed, { value: `${result.rateMbpsAfter} Mbps` }));
      break;
    case "devices":
      lines.push(result.limitAfter == null ? t("common", G.done.devicesLifted) : t("common", G.done.devices, { value: result.limitAfter }));
      if (result.panelsNotEnforcing?.length) lines.push(t("common", G.done.notEnforcing, { panels: formatList(result.panelsNotEnforcing.map((p) => p.name), lang) }));
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
        <p className="break-all font-mono text-2xs font-normal text-text-secondary" dir="ltr">
          {result.subscriptionUrl}
        </p>
      )}
    </div>
  );
}
