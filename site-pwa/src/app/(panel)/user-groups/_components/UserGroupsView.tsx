"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, RotateCw, Trash2, Users, UsersRound } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { userGroupsApi, type UserGroup } from "@/lib/auth-api";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { formatInstant } from "../../_lib/datetime";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { DataTable } from "../../_components/kit/DataTable";
import { USER_GROUP_KEYS as K, canManageGroups, canNameResellers } from "../_lib/user-groups";
import { Alert, primaryButton, quietButton, useMessage } from "./user-groups-ui";
import { GroupSheet } from "./GroupSheet";
import { MembersSheet } from "./MembersSheet";
import { PageHeader } from "../../_components/kit/PageHeader";
import { useConfirm } from "../../_components/kit";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

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
  const confirm = useConfirm();
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
    if (!(await confirm({ title: t("common", K.confirmDelete, { name: g.name }), confirmLabel: t("common", FrontendI18nKeys.common.kit.confirm.delete), tone: "danger" }))) return;
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

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-8">
      <PageHeader
        icon={UsersRound}
        title={t("common", K.title)}
        subtitle={t("common", K.subtitle)}
        actions={
          <>
            <button type="button" className={primaryButton} onClick={() => setEditing("new")}>
              <Plus size={14} aria-hidden />
              {t("common", K.new)}
            </button>
          </>
        }
      />

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
        <DataTable
          label={t("common", K.title)}
          rows={rows}
          rowKey={(g) => g.id}
          minWidth="min-w-[560px]"
          columns={[
            { id: "name", header: t("common", K.columns.name), cell: (g) => g.name, dir: "auto", className: "font-bold text-text-primary" },
            { id: "users", header: t("common", K.columns.users), cell: (g) => g.userCount },
            ...(platform
              ? [{ id: "resellers", header: t("common", K.columns.resellers), cell: (g: UserGroup) => (g.allTenants ? t("common", K.everyReseller) : g.tenantCount) }]
              : []),
            { id: "created", header: t("common", K.columns.created), cell: (g) => formatInstant(g.createdAt, lang, { withTime: false }), className: "text-text-secondary" },
          ]}
          actions={(g) => [
            { id: "members", label: t("common", K.actions.members), icon: <Users size={14} aria-hidden />, onSelect: () => setMembers(g) },
            { id: "edit", label: t("common", K.actions.edit), icon: <Pencil size={14} aria-hidden />, onSelect: () => setEditing(g) },
            { id: "delete", label: t("common", K.actions.delete), icon: <Trash2 size={14} aria-hidden />, tone: "danger", onSelect: () => remove(g) },
          ]}
        />
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
