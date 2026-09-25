"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, RotateCw, Trash2, Users, UsersRound } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { userGroupsApi, type UserGroup } from "@/lib/auth-api";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { formatInstant } from "../../_lib/datetime";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { USER_GROUP_KEYS as K, canManageGroups, canNameResellers } from "../_lib/user-groups";
import { Alert, primaryButton, quietButton, useMessage } from "./user-groups-ui";
import { GroupSheet } from "./GroupSheet";
import { MembersSheet } from "./MembersSheet";

/**
 * An admin's user groups (F-114-m), by name, over `/auth/user-groups`
 * (F-114-j). Every tenant has its own; what is listed is auth-service's
 * answer for the session's tenant. The resellers column and "every reseller"
 * are the platform owner's only.
 *
 * The check here only spares a caller who typed the path a refused read.
 */
export function UserGroupsView() {
  const { lang, t } = useLocale();
  const { me, isLoading: sessionLoading } = usePanelSession();
  const message = useMessage();
  const allowed = canManageGroups(me);
  const platform = canNameResellers(me);

  const [rows, setRows] = useState<UserGroup[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  const [loaded, setLoaded] = useState<number | null>(null);
  const [editing, setEditing] = useState<UserGroup | "new" | null>(null);
  const [members, setMembers] = useState<UserGroup | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    (async () => {
      try {
        const answer = await userGroupsApi.list();
        if (!alive) return;
        setRows(answer);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setRows(null);
        setError(e);
      } finally {
        if (alive) setLoaded(asked);
      }
    })();
    return () => {
      alive = false;
    };
  }, [allowed, asked]);

  // The open members sheet keeps the row it was opened on; a re-read replaces it.
  const open = members ? rows?.find((g) => g.id === members.id) ?? members : null;

  async function remove(g: UserGroup) {
    if (!window.confirm(t("common", K.confirmDelete, { name: g.name }))) return;
    setNotice(null);
    setFailure(null);
    try {
      await userGroupsApi.remove(g.id);
      setNotice(t("common", K.deleted, { name: g.name }));
    } catch (e) {
      setFailure(message(e));
    }
    reload();
  }

  if (sessionLoading) return null;
  if (!allowed) {
    return (
      <div className="mx-auto w-full max-w-7xl p-4 md:p-8">
        <Alert>{t("common", K.notAllowed)}</Alert>
      </div>
    );
  }

  const cell = "px-3 py-2 text-start";
  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary md:text-3xl">
            <UsersRound size={22} className="text-primary" aria-hidden />
            {t("common", K.title)}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">{t("common", K.subtitle)}</p>
        </div>
        <button type="button" className={primaryButton} onClick={() => setEditing("new")}>
          <Plus size={14} aria-hidden />
          {t("common", K.new)}
        </button>
      </header>

      {notice && <p className="text-xs font-bold text-primary">{notice}</p>}
      {failure && <Alert>{failure}</Alert>}

      {loaded !== asked ? (
        <TableSkeleton rows={4} columns={platform ? 5 : 4} withPagination={false} />
      ) : error ? (
        <div className="flex flex-wrap items-center gap-3">
          <Alert>{message(error)}</Alert>
          <button type="button" className={quietButton} onClick={reload}>
            <RotateCw size={12} aria-hidden />
            {t("common", K.retry)}
          </button>
        </div>
      ) : !rows || rows.length === 0 ? (
        <p className="text-sm text-text-secondary">{t("common", K.empty)}</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-card-border bg-card-bg">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-[11px] text-text-secondary">
              <tr>
                <th className={cell}>{t("common", K.columns.name)}</th>
                <th className={cell}>{t("common", K.columns.users)}</th>
                {platform && <th className={cell}>{t("common", K.columns.resellers)}</th>}
                <th className={cell}>{t("common", K.columns.created)}</th>
                <th className={cell} />
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.id} className="border-t border-card-border hover:bg-bg-inner">
                  <td className={`${cell} font-bold text-text-primary`} dir="auto">{g.name}</td>
                  <td className={cell}>{g.userCount}</td>
                  {platform && <td className={cell}>{g.allTenants ? t("common", K.everyReseller) : g.tenantCount}</td>}
                  <td className={`${cell} text-text-secondary`}>{formatInstant(g.createdAt, lang, { withTime: false })}</td>
                  <td className={cell}>
                    <div className="flex flex-wrap justify-end gap-1">
                      <button type="button" className={quietButton} onClick={() => setMembers(g)}>
                        <Users size={12} aria-hidden />
                        {t("common", K.actions.members)}
                      </button>
                      <button type="button" className={quietButton} onClick={() => setEditing(g)}>
                        <Pencil size={12} aria-hidden />
                        {t("common", K.actions.edit)}
                      </button>
                      <button type="button" className={quietButton} onClick={() => remove(g)}>
                        <Trash2 size={12} aria-hidden />
                        {t("common", K.actions.delete)}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <GroupSheet
          group={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(g) => {
            setEditing(null);
            setFailure(null);
            setNotice(t("common", g ? K.form.saved : K.form.unchanged));
            if (g) reload();
          }}
        />
      )}
      {open && <MembersSheet group={open} onClose={() => setMembers(null)} onChanged={reload} />}
    </div>
  );
}
