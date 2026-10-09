"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { tenantRolesApi, userGroupsApi, type PermissionArea, type TenantRole, type UserGroup, type UserGroupMember } from "@/lib/auth-api";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { KeyPicker } from "../../_components/KeyPicker";
import { assignableRoles } from "../../my-resellers/_lib/team";
import { USER_GROUP_KEYS as K, accessBody, receivers } from "../_lib/user-groups";
import { Alert, Field, Sheet, useMessage } from "./user-groups-ui";
import { Button, NativeSelect } from "../../_components/kit";

const A = K.access;
/** The members read for "who receives them": one page; the rest are counted. */
const RECEIVERS_PAGE = 50;

type Loaded = { roles: TenantRole[]; grantable: string[]; registry: PermissionArea[]; members: { items: UserGroupMember[]; total: number } };

/**
 * One group's Access (AC-1-o) over `PUT /auth/user-groups/:id/access`
 * (AC-1-m, governance `contract.md`):
 *
 *  - **a role for the group**, from the roles this caller may give whole
 *    (`assignableRoles`, as the Team page offers them) — the one it holds
 *    stays listed even when this caller may not give it;
 *  - **extra keys**, with the Roles page's own picker (F-1201-d);
 *  - **who receives them**: the members the server marks `receivesAccess`
 *    — this tenant's users; a reseller, or another tenant's user in the
 *    platform's group, gets nothing;
 *  - **the whole set is sent** (`accessBody`); an untouched sheet sends nothing.
 *
 * Roles and `grantable` come through the role door, so a caller without
 * `role.manage` is told why instead of being offered a form the server refuses.
 */
export function AccessSheet({ group, onClose, onSaved }: { group: UserGroup; onClose: () => void; onSaved: (g: UserGroup | null) => void }) {
  const { t } = useLocale();
  const { me } = usePanelSession();
  const message = useMessage();
  const tenantId = me?.tenant.id ?? "";

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [roleId, setRoleId] = useState<string | null>(group.access.roleId);
  const [keys, setKeys] = useState<string[]>(group.access.keys);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (group.allTenants || !tenantId) return;
    let alive = true;
    Promise.all([tenantRolesApi.list(tenantId), tenantRolesApi.permissions(), userGroupsApi.members(group.id, 1, RECEIVERS_PAGE)])
      .then(([list, reg, members]) => alive && setLoaded({ roles: list.roles, grantable: list.grantable, registry: reg.areas, members }))
      .catch((e) => alive && setLoadError(e));
    return () => {
      alive = false;
    };
  }, [group.id, group.allTenants, tenantId]);

  async function save() {
    const body = accessBody(group.access, roleId, keys);
    if (!body) return onSaved(null);
    setBusy(true);
    setFailure(null);
    try {
      onSaved(await userGroupsApi.setAccess(group.id, body));
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  }

  const roles = loaded ? assignableRoles(loaded.roles, loaded.grantable) : [];
  const shown = loaded ? receivers(loaded.members.items) : [];
  // Members past the first page are not read; at most this many more could receive it.
  const unread = loaded ? Math.max(0, loaded.members.total - loaded.members.items.length) : 0;

  return (
    <Sheet
      title={t("common", A.title, { name: group.name })}
      onClose={onClose}
      footer={
        !group.allTenants && loaded ? (
          <Button variant="primary" size="sm" onClick={save} loading={busy}>
            {t("common", A.save)}
          </Button>
        ) : undefined
      }
    >
      {group.allTenants ? (
        <Alert>{t("common", A.everyReseller)}</Alert>
      ) : loadError !== null ? (
        <Alert>{message(loadError)}</Alert>
      ) : !loaded ? (
        <TableSkeleton rows={4} columns={1} withPagination={false} />
      ) : (
        <div className="space-y-5">
          <p className="text-xs text-text-secondary">{t("common", A.hint)}</p>
          <Field label={t("common", A.role)}>
            <NativeSelect value={roleId ?? ""} onChange={(e) => setRoleId(e.target.value || null)}>
              <option value="">{t("common", A.noRole)}</option>
              {group.access.roleId && !roles.some((r) => r.id === group.access.roleId) && (
                <option value={group.access.roleId}>{group.access.roleName ?? group.access.roleId}</option>
              )}
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <KeyPicker
            label={t("common", A.keys)}
            registry={loaded.registry}
            grantable={loaded.grantable}
            held={group.access.keys}
            value={keys}
            onChange={setKeys}
          />
          <div data-testid="group-receivers" className="space-y-1">
            <p className="text-sm font-bold text-text-primary">{t("common", A.receivers)}</p>
            <p className="text-xs text-text-secondary">{t("common", A.receiversHint)}</p>
            {shown.length === 0 && unread === 0 ? (
              <p className="text-sm text-text-secondary">{t("common", A.receiversNone)}</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5 text-sm">
                {shown.map((m) => (
                  <li key={m.userId} dir="auto" className="rounded-lg border border-card-border px-2 py-0.5">
                    {m.label ?? m.userId}
                  </li>
                ))}
                {unread > 0 && <li className="px-1 py-0.5 text-text-secondary">{t("common", A.receiversMore, { count: unread })}</li>}
              </ul>
            )}
          </div>
        </div>
      )}
      {failure && <Alert>{failure}</Alert>}
    </Sheet>
  );
}
