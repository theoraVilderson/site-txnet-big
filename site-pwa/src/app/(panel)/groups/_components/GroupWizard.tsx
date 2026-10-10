"use client";

import { useEffect, useMemo, useState } from "react";
import { BadgeDollarSign, Crown, FilePlus2, Headset, Palette, ShoppingBag, UsersRound, type LucideIcon } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { tenantRolesApi, type GroupPreset, type PermissionArea, type UserGroup } from "@/lib/auth-api";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { KeyPicker } from "../../_components/KeyPicker";
import { permissionIndex } from "../../my-resellers/_lib/roles";
import {
  USER_GROUP_KEYS,
  canNameResellers,
  createGroupBody,
  emptyGroupForm,
  groupKeyAreas,
  isPlatformGroup,
  presetDraft,
  validateGroupForm,
  type Errors,
  type GroupForm,
} from "../_lib/user-groups";
import { Alert, Field, useGroupsScope, useMessage } from "./user-groups-ui";
import { Alert as Note, Button, Checkbox, Input, RadioCards, Wizard, useWizard } from "../../_components/kit";

const K = USER_GROUP_KEYS;
const W = K.wizard;
const STEPS = ["start", "name", "access", "review"] as const;
/** "From scratch" — the one start that is not a preset. */
const SCRATCH = "scratch";
const ICONS: Record<string, LucideIcon> = { support: Headset, finance: BadgeDollarSign, sales: ShoppingBag, look: Palette, admin: Crown };

type Loaded = { areas: PermissionArea[]; presets: GroupPreset[]; grantable: string[] };

/**
 * A new group, step by step (GR-1-h): start from a preset or from scratch,
 * name it, tick its keys, review, create — then add its members. A preset is
 * a template the server answers beside the key registry (`GET
 * /auth/permissions`); it only fills this form, narrowed by `presetDraft` to
 * what this creator can give, and the keys it had to leave out are named.
 *
 * Two writes, the existing ones: `create`, then `setAccess` when it gives
 * anything. A refused second write keeps the group made, and the next submit
 * sends only the access, so a retry never makes a second group.
 */
export function GroupWizard({ onClose, onDone }: { onClose: (changed: boolean) => void; onDone: (g: UserGroup, addMembers: boolean) => void }) {
  const { t } = useLocale();
  const { me } = usePanelSession();
  const { tenantId, api } = useGroupsScope();
  const message = useMessage();
  const keyTenant = tenantId ?? me?.tenant.id ?? "";
  const platform = canNameResellers(me, tenantId);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [start, setStart] = useState<string>(SCRATCH);
  const [form, setForm] = useState<GroupForm>(emptyGroupForm);
  const [nameTouched, setNameTouched] = useState(false);
  const [keys, setKeys] = useState<string[]>([]);
  const [dropped, setDropped] = useState<string[]>([]);
  const [errors, setErrors] = useState<Errors<GroupForm>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<UserGroup | null>(null);
  const [done, setDone] = useState<UserGroup | null>(null);

  useEffect(() => {
    if (!keyTenant) return;
    let alive = true;
    Promise.all([tenantRolesApi.permissions(), tenantRolesApi.list(keyTenant)])
      .then(([reg, list]) => {
        if (!alive) return;
        setLoaded({ areas: groupKeyAreas(reg.areas, isPlatformGroup(me, tenantId)), presets: reg.presets ?? [], grantable: list.grantable });
      })
      .catch((e) => alive && setLoadError(e));
    return () => {
      alive = false;
    };
  }, [keyTenant, me, tenantId]);

  const labels = useMemo(() => (loaded ? permissionIndex(loaded.areas) : new Map()), [loaded]);
  // "Every reseller" holds resellers, who are given nothing (`access_on_resellers`).
  const givesKeys = !form.allTenants;
  const sentKeys = givesKeys ? keys : [];

  function pick(id: string) {
    setStart(id);
    const next = loaded?.presets.find((p) => p.id === id) ?? null;
    const draft = loaded ? presetDraft(next, loaded.areas, loaded.grantable, isPlatformGroup(me, tenantId)) : { keys: [], dropped: [] };
    setKeys(draft.keys);
    setDropped(draft.dropped);
    if (!nameTouched) setForm((f) => ({ ...f, name: next ? next.label : "" }));
  }

  const wizard = useWizard({
    count: STEPS.length,
    validate: (i) => {
      if (STEPS[i] === "start") return loaded !== null;
      if (STEPS[i] !== "name") return true;
      const found = validateGroupForm(form);
      setErrors(found);
      return Object.keys(found).length === 0;
    },
    onMove: () => setFailure(null),
  });
  const step = STEPS[wizard.index];

  async function submit() {
    setBusy(true);
    setFailure(null);
    let group = created;
    try {
      if (!group) {
        group = await api.create(createGroupBody(form, me, tenantId));
        setCreated(group);
      }
    } catch (e) {
      setFailure(message(e));
      setBusy(false);
      return;
    }
    try {
      if (sentKeys.length > 0) group = await api.setAccess(group.id, { roleId: null, keys: [...sentKeys].sort() });
      setDone(group);
    } catch (e) {
      setFailure(t("common", W.accessFailed, { reason: message(e) }));
    } finally {
      setBusy(false);
    }
  }

  const label = (key: string) => labels.get(key)?.label ?? key;
  const dirty = start !== SCRATCH || form.name.trim() !== "" || keys.length > 0 || form.allTenants;

  return (
    <Wizard
      title={t("common", W.title)}
      icon={UsersRound}
      steps={STEPS.map((s) => ({ id: s, title: t("common", W.steps[s]) }))}
      wizard={wizard}
      dirty={dirty && !done}
      closeQuestion={t("common", W.confirmClose)}
      busy={busy}
      submitLabel={t("common", W.create)}
      onSubmit={() => void submit()}
      onClose={() => onClose(created !== null)}
      intro={<p className="text-sm font-bold text-text-primary">{t("common", W.intro[step])}</p>}
      error={failure ? <Alert>{failure}</Alert> : undefined}
      done={
        done ? (
          <div className="space-y-4" data-testid="group-wizard-done">
            <p className="text-base font-bold text-text-primary" dir="auto">
              {t("common", W.doneTitle, { name: done.name })}
            </p>
            <p className="text-sm text-text-secondary">
              {sentKeys.length > 0 ? t("common", W.doneBody, { count: sentKeys.length }) : t("common", W.doneNoKeys)}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" size="sm" icon={<UsersRound size={14} aria-hidden />} onClick={() => onDone(done, true)}>
                {t("common", W.addMembers)}
              </Button>
              <Button variant="quiet" size="sm" onClick={() => onDone(done, false)}>
                {t("common", W.later)}
              </Button>
            </div>
          </div>
        ) : undefined
      }
    >
      {loadError !== null ? (
        <Alert>{message(loadError)}</Alert>
      ) : !loaded ? (
        <TableSkeleton rows={3} columns={2} withPagination={false} />
      ) : step === "start" ? (
        <RadioCards
          ariaLabel={t("common", W.steps.start)}
          value={start}
          onChange={pick}
          columns={2}
          options={[
            ...loaded.presets.map((p) => ({
              value: p.id,
              label: p.label,
              icon: ICONS[p.id] ?? UsersRound,
              description: (
                <>
                  {p.description}
                  <span className="mt-1 block text-[11px] font-bold">
                    {p.every ? t("common", W.presetEvery) : t("common", W.presetKeys, { count: presetDraft(p, loaded.areas, loaded.grantable, isPlatformGroup(me, tenantId)).keys.length })}
                  </span>
                </>
              ),
            })),
            { value: SCRATCH, label: t("common", W.scratch), icon: FilePlus2, description: t("common", W.scratchHint) },
          ]}
        />
      ) : step === "name" ? (
        <div className="space-y-4">
          <Field label={t("common", K.form.name)} hint={t("common", K.form.nameHint)} error={errors.name}>
            <Input
              value={form.name}
              maxLength={80}
              dir="auto"
              onChange={(e) => {
                setNameTouched(true);
                setForm((f) => ({ ...f, name: e.target.value }));
              }}
            />
          </Field>
          {platform && (
            <Checkbox
              checked={form.allTenants}
              onChange={(allTenants) => setForm((f) => ({ ...f, allTenants }))}
              label={<span className="font-bold">{t("common", K.form.allTenants)}</span>}
              hint={t("common", K.form.allTenantsHint)}
            />
          )}
        </div>
      ) : step === "access" ? (
        !givesKeys ? (
          <Note tone="info">{t("common", K.access.everyReseller)}</Note>
        ) : (
          <div className="space-y-4">
            {dropped.length > 0 && <Note tone="warning">{t("common", W.dropped, { keys: dropped.map(label).join("، ") })}</Note>}
            <KeyPicker label={t("common", K.access.keys)} registry={loaded.areas} grantable={loaded.grantable} held={[]} value={keys} onChange={setKeys} />
          </div>
        )
      ) : (
        <dl className="space-y-3 text-sm" data-testid="group-wizard-review">
          <div>
            <dt className="text-xs text-text-secondary">{t("common", W.reviewName)}</dt>
            <dd className="font-bold text-text-primary" dir="auto">
              {form.name.trim()}
            </dd>
          </div>
          {form.allTenants && (
            <div>
              <dt className="text-xs text-text-secondary">{t("common", W.reviewMembers)}</dt>
              <dd className="text-text-primary">{t("common", K.form.allTenants)}</dd>
            </div>
          )}
          <div>
            <dt className="text-xs text-text-secondary">{t("common", W.reviewKeys)}</dt>
            <dd>
              {sentKeys.length === 0 ? (
                <p className="text-text-secondary">{t("common", W.noKeys)}</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {[...sentKeys].sort().map((k) => (
                    <li key={k} className="rounded-lg border border-card-border px-2 py-0.5">
                      {label(k)}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        </dl>
      )}
    </Wizard>
  );
}
