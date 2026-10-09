"use client";

import { useEffect, useMemo, useState } from "react";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { authApi, tenantRolesApi, type PermissionArea, type TenantRole } from "@/lib/auth-api";
import { TableSkeleton } from "../../../../_components/kit/TableSkeleton";
import { usePanelSession } from "../../../../_context/PanelSessionContext";
import { useOwnTenantRedirect } from "../../../_lib/useOwnTenantRedirect";
import { isPlatformTenant } from "../../../_lib/users";
import { editorAreas, permissionIndex, unknownKeys } from "../../../_lib/roles";
import { useUserMessage } from "../../users/[userId]/_components/useUserMessage";
import { ConsentNeeded, PlatformAccessBanner } from "../../../_components/PlatformAccessBanner";
import { consentRefusal } from "../../../_lib/support-access";
import { Alert, Badge, Button, Checkbox, Dialog, Field, Input, PageHeader, useConfirm } from "../../../../_components/kit";

const K = FrontendI18nKeys.common.tenantRoles;

/** The editor's open state: a new role, or the one being edited. */
type Editing = { role: TenantRole | null; name: string; keys: string[] };

/**
 * A tenant's roles (F-1201-d, `panel-web/contract.team.md`) on the path's
 * tenant (F-1201-a, ADR-0134):
 *
 *  - **its own roles** with how many of its people hold each, and **the
 *    templates** every tenant shares, which have nothing to edit;
 *  - **the editor offers what the server will accept** — `grantable` from the
 *    list (the tenant ceiling for a reseller's owner, `*` for SuperAdmin),
 *    grouped by area and labelled from the registry (AC-1-f). A key the role
 *    holds that this caller may not grant is shown locked, never dropped;
 *  - **a role someone holds is not deleted from here**: the button is off and
 *    says why — the server would answer `role.inUse` anyway.
 *
 * No permission is judged here: `ResellerAccess` admits, and its refusal is the
 * page's sentence.
 */
export function RolesView({ id, own: ownTenant = false }: { id: string; own?: boolean }) {
  const { t } = useLocale();
  const confirm = useConfirm();
  const message = useUserMessage();
  const { me } = usePanelSession();
  const platform = isPlatformTenant(id, me);
  useOwnTenantRedirect(ownTenant, me?.tenant.id);

  const [answer, setAnswer] = useState<{ roles: TenantRole[]; grantable: string[] } | null>(null);
  const [registry, setRegistry] = useState<PermissionArea[]>([]);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const [slug, setSlug] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([tenantRolesApi.list(id), tenantRolesApi.permissions()])
      .then(([list, reg]) => {
        if (!alive) return;
        setAnswer(list);
        setRegistry(reg.areas);
        setLoadError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setAnswer(null);
        setLoadError(e);
      });
    return () => {
      alive = false;
    };
  }, [id, asked]);

  // The name for the title, when the visitor owns it; staff see the plain title.
  useEffect(() => {
    let alive = true;
    authApi
      .ownedResellers()
      .then((r) => alive && setSlug(r.resellers.find((x) => x.id === id)?.slug ?? null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id]);

  const index = useMemo(() => permissionIndex(registry), [registry]);
  const own = answer?.roles.filter((r) => !r.isTemplate) ?? [];
  const templates = answer?.roles.filter((r) => r.isTemplate) ?? [];
  const reload = () => {
    setLoadError(null);
    setAsked((n) => n + 1);
  };

  async function save() {
    if (!editing) return;
    setSaving(true);
    setActionError(null);
    try {
      const name = editing.name.trim();
      if (editing.role) {
        await tenantRolesApi.update(id, editing.role.id, {
          ...(name !== editing.role.name ? { name } : {}),
          permissions: editing.keys,
        });
      } else {
        await tenantRolesApi.create(id, { name, permissions: editing.keys });
      }
      setEditing(null);
      reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setSaving(false);
    }
  }

  async function remove(role: TenantRole) {
    const sure = await confirm({ title: t("common", K.deleteConfirm, { name: role.name }), confirmLabel: t("common", K.delete), tone: "danger" });
    if (!sure) return;
    setActionError(null);
    try {
      await tenantRolesApi.remove(id, role.id);
      reload();
    } catch (e) {
      setActionError(e);
    }
  }

  const chips = (role: TenantRole) =>
    role.permissions.length === 0 ? (
      <span className="text-xs text-text-secondary">{t("common", K.noPermissions)}</span>
    ) : (
      <span className="flex flex-wrap gap-1">
        {role.permissions.map((key) => (
          <Badge key={key} tone="neutral">
            {index.get(key)?.label ?? key}
          </Badge>
        ))}
      </span>
    );

  const toggle = (key: string, on: boolean) =>
    setEditing((e) => e && { ...e, keys: on ? [...e.keys, key] : e.keys.filter((k) => k !== key) });

  const areas = editing && answer ? editorAreas(registry, answer.grantable, editing.role?.permissions ?? []) : [];
  const strays = editing ? unknownKeys(editing.role?.permissions ?? [], index) : [];
  const nameOk = editing ? editing.name.trim().length >= 2 && editing.name.trim().length <= 40 : false;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
      <PageHeader
        title={ownTenant || platform ? t("common", FrontendI18nKeys.common.shell.menu.roles) : slug ? t("common", K.titleOf, { slug }) : t("common", K.title)}
        subtitle={t("common", K.subtitle)}
        actions={
          <>
            <Button variant="quiet" size="sm" onClick={reload} icon={<RefreshCw size={12} aria-hidden />}>
              {t("common", K.refresh)}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!answer}
              onClick={() => setEditing({ role: null, name: "", keys: [] })}
              icon={<Plus size={12} aria-hidden />}
            >
              {t("common", K.create)}
            </Button>
          </>
        }
      />

      <PlatformAccessBanner tenantId={id} onChange={reload} />
      {actionError !== null && editing === null && <Alert tone="error">{message(actionError)}</Alert>}

      {consentRefusal(loadError) ? (
        <ConsentNeeded error={loadError} />
      ) : loadError !== null ? (
        <div className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-6">
          <Alert tone="error">{message(loadError)}</Alert>
          <Button variant="primary" size="sm" onClick={reload}>
            {t("common", K.reload)}
          </Button>
        </div>
      ) : answer === null ? (
        <TableSkeleton rows={4} columns={2} />
      ) : (
        <>
          <section data-testid="own-roles" className="space-y-2">
            <h2 className="text-sm font-bold text-text-primary">{t("common", K.own)}</h2>
            {own.length === 0 ? (
              <p className="rounded-2xl border border-card-border bg-card-bg p-6 text-sm text-text-secondary">{t("common", K.empty)}</p>
            ) : (
              <ul className="divide-y divide-card-border overflow-hidden rounded-2xl border border-card-border bg-card-bg">
                {own.map((role) => (
                  <li key={role.id} data-testid={`role-${role.id}`} className="flex flex-wrap items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-text-primary">
                        {role.name}
                        <span className="text-xs font-normal text-text-secondary">{t("common", K.members, { count: role.members })}</span>
                      </p>
                      {chips(role)}
                    </div>
                    <Button
                      variant="quiet"
                      size="sm"
                      icon={<Pencil size={12} aria-hidden />}
                      onClick={() => {
                        setActionError(null);
                        setEditing({ role, name: role.name, keys: role.permissions });
                      }}
                    >
                      {t("common", K.edit)}
                    </Button>
                    <Button
                      variant="quiet"
                      size="sm"
                      icon={<Trash2 size={12} aria-hidden />}
                      disabled={role.members > 0}
                      title={role.members > 0 ? t("common", K.inUse) : undefined}
                      onClick={() => void remove(role)}
                    >
                      {t("common", K.delete)}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section data-testid="template-roles" className="space-y-2">
            <h2 className="text-sm font-bold text-text-primary">{t("common", K.templates)}</h2>
            <p className="text-xs text-text-secondary">{t("common", K.templatesHint)}</p>
            <ul className="divide-y divide-card-border overflow-hidden rounded-2xl border border-card-border bg-card-bg">
              {templates.map((role) => (
                <li key={role.id} className="space-y-1.5 px-4 py-3">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-text-primary">
                    {role.name}
                    <span className="text-xs font-normal text-text-secondary">{t("common", K.members, { count: role.members })}</span>
                  </p>
                  {chips(role)}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        size="lg"
        title={editing?.role ? t("common", K.dialogEdit, { name: editing.role.name }) : t("common", K.dialogCreate)}
        footer={
          <>
            <Button variant="quiet" onClick={() => setEditing(null)}>
              {t("common", K.cancel)}
            </Button>
            <Button variant="primary" loading={saving} disabled={!nameOk} onClick={() => void save()}>
              {t("common", K.save)}
            </Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-4">
            {actionError !== null && <Alert tone="error">{message(actionError)}</Alert>}
            <Field label={t("common", K.name)} hint={t("common", K.nameHint)}>
              <Input value={editing.name} maxLength={40} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <div className="space-y-3">
              <p className="text-sm font-bold text-text-primary">{t("common", K.permissions)}</p>
              <p className="text-xs text-text-secondary">{t("common", areas.length === 0 ? K.noneGrantable : K.onlyYours)}</p>
              {areas.map((area) => (
                <fieldset key={area.area} className="space-y-2 rounded-xl border border-card-border p-3">
                  <legend className="px-1 text-xs font-bold text-text-secondary">{area.label}</legend>
                  {area.permissions.map((p) => (
                    <div key={p.key} className="flex items-start justify-between gap-2">
                      <Checkbox
                        checked={editing.keys.includes(p.key)}
                        disabled={p.locked}
                        onChange={(on) => toggle(p.key, on)}
                        label={p.label}
                        hint={p.description || undefined}
                      />
                      {p.platformOnly && <Badge tone="neutral">{t("common", K.platformOnly)}</Badge>}
                    </div>
                  ))}
                </fieldset>
              ))}
              {strays.length > 0 && (
                <fieldset className="space-y-2 rounded-xl border border-card-border p-3">
                  <legend className="px-1 text-xs font-bold text-text-secondary">{t("common", K.other)}</legend>
                  {strays.map((key) => (
                    <Checkbox key={key} checked={editing.keys.includes(key)} disabled onChange={() => undefined} label={<span dir="ltr">{key}</span>} />
                  ))}
                </fieldset>
              )}
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
