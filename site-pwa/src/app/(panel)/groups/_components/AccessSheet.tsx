"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { tenantRolesApi, type PermissionArea, type UserGroup, type UserGroupMember } from "@/lib/auth-api";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { KeyPicker } from "../../_components/KeyPicker";
import { USER_GROUP_KEYS as K, accessBody, givenKeys, groupKeyAreas, isPlatformGroup, receivers } from "../_lib/user-groups";
import { Alert, Sheet, useGroupsScope, useMessage } from "./user-groups-ui";
import { Button } from "../../_components/kit";

const A = K.access;
/** The members read for "who receives them": one page; the rest are counted. */
const RECEIVERS_PAGE = 50;

type Loaded = { roleKeys: string[]; grantable: string[]; registry: PermissionArea[]; members: { items: UserGroupMember[]; total: number } };

/**
 * One group's Access (GR-1-f, ADR-0139 (1)) over `PUT …/user-groups/:id/access`
 * (AC-1-m, governance `contract.md`):
 *
 *  - **keys ticked on the group itself**, with the shared `KeyPicker` — no
 *    role is picked. A role an older group was given (AC-1-o) shows as its
 *    keys, ticked, and is folded into them the first time the sheet saves;
 *  - a `platform.` key is offered only on the platform's own group (GR-1-e);
 *  - **who receives them**: the members the server marks `receivesAccess`
 *    — this tenant's users; a reseller, or another tenant's user in the
 *    platform's group, gets nothing;
 *  - **the whole set is sent** (`accessBody`); an untouched sheet sends nothing.
 *
 * What this caller may tick (`grantable`) comes through the tenant's key
 * door, so a caller it refuses is told why instead of being offered a form
 * the server refuses.
 */
export function AccessSheet({ group, onClose, onSaved }: { group: UserGroup; onClose: () => void; onSaved: (g: UserGroup | null) => void }) {
  const { t } = useLocale();
  const { me } = usePanelSession();
  const { tenantId, api } = useGroupsScope();
  const message = useMessage();
  const keyTenant = tenantId ?? me?.tenant.id ?? "";
  const platformGroup = isPlatformGroup(me, tenantId);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [keys, setKeys] = useState<string[]>(group.access.keys);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (group.allTenants || !keyTenant) return;
    let alive = true;
    Promise.all([tenantRolesApi.list(keyTenant), tenantRolesApi.permissions(), api.members(group.id, 1, RECEIVERS_PAGE)])
      .then(([list, reg, members]) => {
        if (!alive) return;
        const roleKeys = list.roles.find((r) => r.id === group.access.roleId)?.permissions ?? [];
        setLoaded({ roleKeys, grantable: list.grantable, registry: reg.areas, members });
        setKeys(givenKeys(group.access, roleKeys));
      })
      .catch((e) => alive && setLoadError(e));
    return () => {
      alive = false;
    };
  }, [api, group.id, group.allTenants, group.access, keyTenant]);

  async function save() {
    if (!loaded) return;
    const body = accessBody(group.access, loaded.roleKeys, keys);
    if (!body) return onSaved(null);
    setBusy(true);
    setFailure(null);
    try {
      onSaved(await api.setAccess(group.id, body));
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  }

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
          <KeyPicker
            label={t("common", A.keys)}
            registry={groupKeyAreas(loaded.registry, platformGroup)}
            grantable={loaded.grantable}
            held={givenKeys(group.access, loaded.roleKeys)}
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
