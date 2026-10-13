"use client";

import { useEffect, useState } from "react";
import { Ban, Pencil, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { ApiError } from "@/lib/api-error";
import { userRestrictionsApi, type PersonRestrictions, type RestrictionKeyView, type UserRestriction } from "@/lib/auth-api";
import { TableSkeleton } from "../../../../../_components/kit/TableSkeleton";
import { DatePicker } from "../../../../../_components/kit/DatePicker";
import { Alert, Badge, Button, Checkbox, Dialog, Field, Input, NativeSelect, Textarea, notify, useConfirm } from "../../../../../_components/kit";
import { formatInstant } from "../../../../../_lib/datetime";
import { KEY_REASON_MAX } from "../../../../_lib/person-keys";
import { draftOf, restrictionDraftOk, restrictionRefusalKey, restrictionWriteBody, unsetKeys, type RestrictionDraft } from "../../../../_lib/person-restrictions";
import { useUserMessage } from "./useUserMessage";

const K = FrontendI18nKeys.common.personRestrictions;
const KEY_LABELS: Record<string, string> = K.keys;
/** A barred top-up method is a gateway category; the gateway wizard already names each. */
const OPTION_LABELS: Record<string, string> = FrontendI18nKeys.common.gateways.wizard.categories;

/** The dialog: adding (`changing` false, the key picked in it) or changing the one row it opened from. */
type Editing = { draft: RestrictionDraft; changing: boolean };

/**
 * The Restrictions section of one user's Profile tab (F-030-f,
 * `panel-web/contract.reseller-users.md`) over `…/users/:userId/restrictions`
 * (F-030-d), on the path's tenant, through the door on `restriction.assign`:
 *
 *  - **what holds now** — each restriction with its value, reason and end;
 *    one past its end is not in the answer, so it is not shown;
 *  - **add, change, lift**, each with a reason; "add" offers only the keys not
 *    set yet, and a set one is changed from its own row;
 *  - **`canAct` decides whether anything is offered** (ADR-0103); a caller the
 *    door refuses is shown nothing — the section is not theirs.
 */
export function UserRestrictions({ id, userId, canAct, onChange }: { id: string; userId: string; canAct: boolean; onChange?: () => void }) {
  const { t, lang } = useLocale();
  const confirm = useConfirm();
  const userMessage = useUserMessage();
  const message = (e: unknown) => {
    const key = restrictionRefusalKey(e);
    return key ? t("common", key) : userMessage(e);
  };

  const [view, setView] = useState<PersonRestrictions | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    userRestrictionsApi
      .of(id, userId)
      .then((v) => alive && setView(v))
      .catch((e) => alive && setLoadError(e));
    return () => {
      alive = false;
    };
  }, [id, userId]);

  if (loadError instanceof ApiError && loadError.status === 403) return null;

  const label = (key: string) => (KEY_LABELS[key] ? t("common", KEY_LABELS[key]) : key);
  const optionLabel = (o: string) => (OPTION_LABELS[o] ? t("common", OPTION_LABELS[o]) : o);
  const valueBadges = (r: UserRestriction) =>
    (Array.isArray(r.value) ? r.value.map(optionLabel) : [t("common", K.atMost, { count: r.value })]).map((text) => (
      <Badge key={text} tone="warning">
        {text}
      </Badge>
    ));
  const keyOf = (key: string) => view?.keys.find((k) => k.key === key);

  async function run(work: () => Promise<PersonRestrictions>, done: string) {
    setBusy(true);
    setActionError(null);
    try {
      setView(await work());
      onChange?.();
      setEditing(null);
      notify.success(t("common", done));
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  async function lift(key: string) {
    const sure = await confirm({ title: t("common", K.liftConfirm, { key: label(key) }), body: t("common", K.liftHint), confirmLabel: t("common", K.lift) });
    if (sure) await run(() => userRestrictionsApi.lift(id, userId, key), K.lifted);
  }

  function open(key: RestrictionKeyView | undefined, current?: UserRestriction) {
    setActionError(null);
    setEditing({ draft: key ? draftOf(key, current) : { key: "", count: "", options: [], reason: "", expiresAt: null }, changing: Boolean(current) });
  }

  const addable = view ? unsetKeys(view) : [];
  const draft = editing?.draft ?? null;
  const picked = draft ? keyOf(draft.key) : undefined;
  const setDraft = (d: RestrictionDraft) => editing && setEditing({ ...editing, draft: d });

  return (
    <section data-testid="user-restrictions" className="space-y-4 rounded-2xl border border-card-border bg-card-bg p-4 md:p-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-text-primary">{t("common", K.title)}</h3>
          <p className="text-xs text-text-secondary">{t("common", K.hint)}</p>
        </div>
        {canAct && view && addable.length > 0 && (
          <Button variant="secondary" size="sm" icon={<Ban size={12} aria-hidden />} disabled={busy} onClick={() => open(undefined)}>
            {t("common", K.add)}
          </Button>
        )}
      </div>

      {actionError !== null && editing === null && <Alert tone="error">{message(actionError)}</Alert>}
      {loadError !== null ? (
        <Alert tone="error">{message(loadError)}</Alert>
      ) : !view ? (
        <TableSkeleton rows={2} columns={2} withPagination={false} />
      ) : view.restrictions.length === 0 ? (
        <p className="text-sm text-text-secondary">{t("common", K.none)}</p>
      ) : (
        <ul className="divide-y divide-card-border text-sm">
          {view.restrictions.map((r) => (
            <li key={r.key} className="flex flex-wrap items-center gap-2 py-2">
              <span className="font-bold text-text-primary">{label(r.key)}</span>
              {valueBadges(r)}
              {r.expiresAt && <Badge>{t("common", K.until, { date: formatInstant(r.expiresAt, lang, { withTime: true }) ?? r.expiresAt })}</Badge>}
              <span className="text-xs text-text-secondary">
                {r.reason} · {formatInstant(r.at, lang, { withTime: false })}
              </span>
              {canAct && (
                <span className="ms-auto flex gap-1">
                  <Button variant="quiet" size="sm" icon={<Pencil size={12} aria-hidden />} disabled={busy} onClick={() => open(keyOf(r.key), r)}>
                    {t("common", K.change)}
                  </Button>
                  <Button variant="quiet" size="sm" icon={<X size={12} aria-hidden />} disabled={busy} onClick={() => void lift(r.key)}>
                    {t("common", K.lift)}
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={t("common", editing?.changing ? K.dialogChange : K.dialogAdd)}
        footer={
          <>
            <Button variant="quiet" onClick={() => setEditing(null)}>
              {t("common", K.cancel)}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!draft || !picked || !restrictionDraftOk(draft, picked)}
              onClick={() => draft && picked && void run(() => userRestrictionsApi.set(id, userId, picked.key, restrictionWriteBody(draft, picked)), K.saved)}
            >
              {t("common", K.save)}
            </Button>
          </>
        }
      >
        {editing && draft && (
          <div className="space-y-4">
            {actionError !== null && <Alert tone="error">{message(actionError)}</Alert>}
            <Field label={t("common", K.key)}>
              <NativeSelect
                value={draft.key}
                disabled={editing.changing}
                onChange={(e) => {
                  const key = keyOf(e.target.value);
                  setDraft(key ? { ...draftOf(key), reason: draft.reason, expiresAt: draft.expiresAt } : { ...draft, key: "" });
                }}
              >
                <option value="">{t("common", K.pickKey)}</option>
                {(editing.changing ? (picked ? [picked] : []) : addable).map((k) => (
                  <option key={k.key} value={k.key}>
                    {label(k.key)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {picked?.kind === "count" && (
              <Field label={t("common", K.count)} hint={t("common", K.countHint, { max: picked.max })}>
                <Input type="number" inputMode="numeric" min={0} max={picked.max} step={1} dir="ltr" value={draft.count} onChange={(e) => setDraft({ ...draft, count: e.target.value })} />
              </Field>
            )}
            {picked?.kind === "set" && (
              <Field label={t("common", K.options)} hint={t("common", K.optionsHint)}>
                <div className="flex flex-col gap-2">
                  {picked.options.map((o) => (
                    <Checkbox
                      key={o}
                      checked={draft.options.includes(o)}
                      label={optionLabel(o)}
                      onChange={(on) => setDraft({ ...draft, options: on ? [...draft.options, o] : draft.options.filter((x) => x !== o) })}
                    />
                  ))}
                </div>
              </Field>
            )}
            <div className="space-y-1">
              <div className="flex flex-wrap items-end gap-2">
                <DatePicker withTime label={t("common", K.expires)} value={draft.expiresAt} onChange={(expiresAt) => setDraft({ ...draft, expiresAt })} />
                {draft.expiresAt && (
                  <Button variant="quiet" size="sm" onClick={() => setDraft({ ...draft, expiresAt: null })}>
                    {t("common", K.noEnd)}
                  </Button>
                )}
              </div>
              <p className="text-xs text-text-secondary">{t("common", K.expiresHint)}</p>
            </div>
            <Field label={t("common", K.reason)} hint={t("common", K.reasonHint)}>
              <Textarea value={draft.reason} maxLength={KEY_REASON_MAX} rows={3} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
            </Field>
          </div>
        )}
      </Dialog>
    </section>
  );
}
