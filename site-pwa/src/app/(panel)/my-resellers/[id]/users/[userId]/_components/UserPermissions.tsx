"use client";

import { useEffect, useMemo, useState } from "react";
import { KeyRound, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { ApiError } from "@/lib/api-error";
import { tenantRolesApi, type PermissionArea, type PersonKeys } from "@/lib/auth-api";
import { TableSkeleton } from "../../../../../_components/kit/TableSkeleton";
import { Alert, Badge, Button, Dialog, Field, NativeSelect, SegmentedControl, Textarea, notify, useConfirm } from "../../../../../_components/kit";
import { formatInstant } from "../../../../../_lib/datetime";
import { permissionIndex } from "../../../../_lib/roles";
import { KEY_REASON_MAX, heldKeys, holdsEverything, keyRefusalKey, pickableKeys, reasonOk, type KeySource } from "../../../../_lib/person-keys";
import { useUserMessage } from "./useUserMessage";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

const K = FrontendI18nKeys.common.personKeys;

type Draft = { key: string; effect: "give" | "take"; reason: string };

/**
 * The Permissions section of one user's Profile tab (AC-1-n,
 * `panel-web/contract.reseller-users.md`) over `…/users/:userId/keys`
 * (AC-1-l), on the path's tenant, through the role door:
 *
 *  - **what they hold is their answer** (ADR-0138), each key with every
 *    source that gives it — their role, a group (AC-1-m), a key given; the
 *    keys taken are listed apart, since a take wins over every source;
 *  - **give or take one key, with a reason**, from what this caller may grant
 *    (`grantable`, the Roles page's own list); **lift** puts the key back in
 *    the hands of the role and groups;
 *  - **`canAct` decides whether anything is offered** (ADR-0103); a caller the
 *    role door refuses (no `role.manage`) is shown nothing — the section is
 *    not theirs, and the tab above it still is.
 */
export function UserPermissions({ id, userId, canAct }: { id: string; userId: string; canAct: boolean }) {
  const { t, lang } = useLocale();
  const confirm = useConfirm();
  const userMessage = useUserMessage();
  const message = (e: unknown) => {
    const key = keyRefusalKey(e);
    return key ? t("common", key) : userMessage(e);
  };

  const [view, setView] = useState<PersonKeys | null>(null);
  const [registry, setRegistry] = useState<PermissionArea[]>([]);
  const [grantable, setGrantable] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([tenantRolesApi.keysOf(id, userId), tenantRolesApi.permissions(), canAct ? tenantRolesApi.list(id) : null])
      .then(([keys, reg, list]) => {
        if (!alive) return;
        setView(keys);
        setRegistry(reg.areas);
        setGrantable(list?.grantable ?? []);
      })
      .catch((e) => alive && setLoadError(e));
    return () => {
      alive = false;
    };
  }, [id, userId, canAct]);

  const index = useMemo(() => permissionIndex(registry), [registry]);
  const label = (key: string) => (key === "*" ? t("common", K.wildcard) : index.get(key)?.label ?? key);
  const sourceText = (s: KeySource) =>
    s.kind === "role"
      ? t("common", K.source.role, { name: view?.role.name ?? "" })
      : s.kind === "group"
        ? t("common", K.source.group, { name: s.name })
        : t("common", K.source.given, { reason: s.reason });

  if (loadError instanceof ApiError && loadError.status === 403) return null;

  async function run(work: () => Promise<PersonKeys>, done: string) {
    setBusy(true);
    setActionError(null);
    try {
      setView(await work());
      setDraft(null);
      notify.success(t("common", done));
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  async function lift(key: string) {
    const sure = await confirm({ title: t("common", K.liftConfirm, { key: label(key) }), body: t("common", K.liftHint), confirmLabel: t("common", K.lift) });
    if (sure) await run(() => tenantRolesApi.liftKey(id, userId, key), K.lifted);
  }

  const areas = pickableKeys(registry, grantable);
  const held = view ? heldKeys(view) : [];
  const wildcard = view ? holdsEverything(view) : false;
  const editable = canAct && !wildcard;
  const liftButton = (key: string) => (
    <Button variant="quiet" size="sm" className="ms-auto" icon={<X size={12} aria-hidden />} disabled={busy} onClick={() => void lift(key)}>
      {t("common", K.lift)}
    </Button>
  );

  return (
    <section data-testid="user-permissions" className="space-y-4 rounded-2xl border border-card-border bg-card-bg p-4 md:p-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-text-primary">{t("common", K.title)}</h3>
          <p className="text-xs text-text-secondary">{t("common", K.hint)}</p>
        </div>
        {editable && view && (
          <Button
            variant="secondary"
            size="sm"
            icon={<KeyRound size={12} aria-hidden />}
            disabled={busy}
            onClick={() => {
              setActionError(null);
              setDraft({ key: "", effect: "give", reason: "" });
            }}
          >
            {t("common", K.give)}
          </Button>
        )}
      </div>

      {actionError !== null && draft === null && <Alert tone="error">{message(actionError)}</Alert>}
      {loadError !== null ? (
        <Alert tone="error">{message(loadError)}</Alert>
      ) : !view ? (
        <TableSkeleton rows={3} columns={2} withPagination={false} />
      ) : (
        <>
          {held.length === 0 ? (
            <p className="text-sm text-text-secondary">{t("common", K.none)}</p>
          ) : (
            <ul className="divide-y divide-card-border text-sm">
              {held.map((h) => (
                <li key={h.key} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="font-bold text-text-primary">{label(h.key)}</span>
                  {h.sources.map((s, i) => (
                    <Badge key={i} tone={s.kind === "given" ? "success" : "neutral"}>
                      {sourceText(s)}
                    </Badge>
                  ))}
                  {editable && h.sources.some((s) => s.kind === "given") && liftButton(h.key)}
                </li>
              ))}
            </ul>
          )}

          {view.taken.length > 0 && (
            <div className="space-y-1">
              <p className="text-sm font-bold text-text-primary">{t("common", K.taken)}</p>
              <p className="text-xs text-text-secondary">{t("common", K.takenHint)}</p>
              <ul className="divide-y divide-card-border text-sm">
                {view.taken.map((o) => (
                  <li key={o.key} className="flex flex-wrap items-center gap-2 py-2">
                    <span className="font-bold text-text-primary line-through">{label(o.key)}</span>
                    <span className="text-xs text-text-secondary">
                      {o.reason} · {formatInstant(o.at, lang, { withTime: false })}
                    </span>
                    {editable && liftButton(o.key)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <Dialog
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={t("common", K.dialogTitle)}
        footer={
          <>
            <Button variant="quiet" onClick={() => setDraft(null)}>
              {t("common", K.cancel)}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!draft || !draft.key || !reasonOk(draft.reason)}
              onClick={() => draft && void run(() => tenantRolesApi.setKey(id, userId, draft.key, { effect: draft.effect, reason: draft.reason.trim() }), K.saved)}
            >
              {t("common", K.save)}
            </Button>
          </>
        }
      >
        {draft && (
          <div className="space-y-4">
            {actionError !== null && <Alert tone="error">{message(actionError)}</Alert>}
            {areas.length === 0 && <Alert tone="info">{t("common", K.noneGrantable)}</Alert>}
            <Field label={t("common", K.key)}>
              <NativeSelect value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })}>
                <option value="">{t("common", K.pickKey)}</option>
                {areas.map((area) => (
                  <optgroup key={area.area} label={area.label}>
                    {area.permissions.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </NativeSelect>
            </Field>
            <Field label={t("common", K.effect)}>
              <SegmentedControl
                value={draft.effect}
                ariaLabel={t("common", K.effect)}
                onChange={(effect) => setDraft({ ...draft, effect })}
                options={[
                  { value: "give", label: t("common", K.effectGive) },
                  { value: "take", label: t("common", K.effectTake) },
                ]}
              />
            </Field>
            <Field label={t("common", K.reason)} hint={t("common", K.reasonHint)}>
              <Textarea value={draft.reason} maxLength={KEY_REASON_MAX} rows={3} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
            </Field>
          </div>
        )}
      </Dialog>
    </section>
  );
}
