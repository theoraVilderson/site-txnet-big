"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RotateCw, Store, Trash2, User } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { userGroupsApi, type UserGroup, type UserGroupMember } from "@/lib/auth-api";
import { tenantApi, type Reseller } from "@/lib/tenant-api";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { formatInstant } from "../../_lib/datetime";
import { Select } from "../../_components/kit/Select";
import { canAdministerResellers } from "../../resellers/_lib/resellers";
import { MEMBER_IDS_MAX, USER_GROUP_KEYS as K, canNameResellers, memberSearchOf, membersBody, parseIds } from "../_lib/user-groups";
import { Alert, Field, Sheet, input, primaryButton, quietButton, useMessage } from "./user-groups-ui";
import { UserSearch } from "./UserSearch";

const PAGE_SIZE = 50;

/**
 * One group's members (F-114-m): newest first, a page of 50, each removable;
 * then add — a user found by search, or ids typed; resellers for the platform
 * owner, unless the group already holds every reseller. Nothing is patched
 * from an answer: every write re-reads the page, and `onChanged` the counts.
 */
export function MembersSheet({ group, onClose, onChanged }: { group: UserGroup; onClose: () => void; onChanged: () => void }) {
  const { t, lang } = useLocale();
  const { me } = usePanelSession();
  const message = useMessage();
  const search = memberSearchOf(me);
  const resellersToo = canNameResellers(me) && !group.allTenants;

  const [page, setPage] = useState(1);
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  const [rows, setRows] = useState<{ items: UserGroupMember[]; total: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const key = `${page}|${asked}`;
  const [loaded, setLoaded] = useState<string | null>(null);

  const [userText, setUserText] = useState("");
  const [tenantText, setTenantText] = useState("");
  const [resellers, setResellers] = useState<Reseller[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const answer = await userGroupsApi.members(group.id, page, PAGE_SIZE);
        if (!alive) return;
        setRows(answer);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setRows(null);
        setError(e);
      } finally {
        if (alive) setLoaded(key);
      }
    })();
    return () => {
      alive = false;
    };
  }, [group.id, page, key]);

  // A list to pick a reseller from, for a caller who may read it; typed ids otherwise.
  const pickable = resellersToo && canAdministerResellers(me);
  useEffect(() => {
    if (!pickable) return;
    tenantApi.resellers(100, 0).then(setResellers, () => setResellers(null));
  }, [pickable]);

  async function write(run: () => Promise<string>): Promise<boolean> {
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      setNotice(await run());
      reload();
      onChanged();
      return true;
    } catch (e) {
      setFailure(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const add = async (userIds: string[], tenantIds: string[]): Promise<boolean> => {
    const body = membersBody(userIds, tenantIds, me);
    if (!body) {
      setFailure(t("common", K.errors.noIds));
      return false;
    }
    return write(async () => {
      const { added } = await userGroupsApi.addMembers(group.id, body);
      return t("common", K.members.added, { count: added });
    });
  };

  function addTyped() {
    const users = parseIds(userText);
    const tenants = resellersToo ? parseIds(tenantText) : { ids: [], bad: [] };
    const bad = [...users.bad, ...tenants.bad];
    if (bad.length > 0) return setFailure(t("common", K.errors.badIds, { ids: bad.join(", ") }));
    if (users.ids.length > MEMBER_IDS_MAX || tenants.ids.length > MEMBER_IDS_MAX) return setFailure(t("common", K.errors.tooManyIds));
    void add(users.ids, tenants.ids).then((ok) => {
      if (!ok) return;
      setUserText("");
      setTenantText("");
    });
  }

  function remove(m: UserGroupMember) {
    const label = m.label ?? t("common", K.members.noLabel);
    if (!window.confirm(t("common", K.members.confirmRemove, { label }))) return;
    void write(async () => {
      if (m.memberType === "user" && m.userId) await userGroupsApi.removeUser(group.id, m.userId);
      else if (m.tenantId) await userGroupsApi.removeTenant(group.id, m.tenantId);
      return "";
    });
  }

  const pages = rows ? Math.max(1, Math.ceil(rows.total / PAGE_SIZE)) : 1;
  return (
    <Sheet title={t("common", K.members.title, { name: group.name })} onClose={onClose}>
      {group.allTenants && <p className="text-xs font-bold text-primary">{t("common", K.members.allTenantsNote)}</p>}

      {loaded !== key ? (
        <p className="flex items-center gap-1.5 text-xs text-text-secondary">
          <Loader2 size={12} className="animate-spin" aria-hidden />
        </p>
      ) : error ? (
        <div className="flex flex-wrap items-center gap-3">
          <Alert>{message(error)}</Alert>
          <button type="button" className={quietButton} onClick={reload}>
            <RotateCw size={12} aria-hidden />
            {t("common", K.retry)}
          </button>
        </div>
      ) : !rows || rows.items.length === 0 ? (
        <p className="text-sm text-text-secondary">{t("common", K.members.empty)}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-text-secondary">{t("common", K.members.total, { count: rows.total })}</p>
          <ul className="flex flex-col divide-y divide-card-border overflow-hidden rounded-xl border border-card-border">
            {rows.items.map((m) => {
              const Icon = m.memberType === "user" ? User : Store;
              return (
                <li key={`${m.memberType}:${m.userId ?? m.tenantId}`} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon size={14} className="shrink-0 text-text-secondary" aria-label={t("common", m.memberType === "user" ? K.members.user : K.members.reseller)} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-bold text-text-primary" dir="auto">{m.label ?? t("common", K.members.noLabel)}</span>
                      <span className="text-[11px] text-text-secondary">{formatInstant(m.addedAt, lang, { withTime: false })}</span>
                    </span>
                  </span>
                  <button type="button" className={quietButton} disabled={busy} onClick={() => remove(m)}>
                    <Trash2 size={12} aria-hidden />
                    {t("common", K.members.remove)}
                  </button>
                </li>
              );
            })}
          </ul>
          {pages > 1 && (
            <nav className="flex justify-between">
              <button type="button" className={quietButton} disabled={page <= 1} onClick={() => setPage(page - 1)}>
                {t("common", K.prev)}
              </button>
              <button type="button" className={quietButton} disabled={page >= pages} onClick={() => setPage(page + 1)}>
                {t("common", K.next)}
              </button>
            </nav>
          )}
        </div>
      )}

      <section className="flex flex-col gap-3 border-t border-card-border pt-4">
        <h3 className="text-xs font-bold text-text-primary">{t("common", K.members.addUsers)}</h3>
        {search !== "ids" && me && <UserSearch via={search} tenantId={me.tenant.id} busy={busy} onAdd={(hit) => void add([hit.id], [])} />}
        <Field label={t("common", K.members.userIds)} hint={t("common", K.members.userIdsHint)}>
          <textarea className={input} dir="ltr" rows={2} value={userText} onChange={(e) => setUserText(e.target.value)} />
        </Field>
        {resellersToo && (
          <>
            <h3 className="text-xs font-bold text-text-primary">{t("common", K.members.addResellers)}</h3>
            {resellers && resellers.length > 0 && (
              <Select
                value=""
                placeholder={t("common", K.members.pickReseller)}
                onChange={(id) => setTenantText((s) => (s.includes(id) ? s : `${s.trim()} ${id}`.trim()))}
                options={resellers.map((r) => ({ value: r.id, label: r.slug }))}
              />
            )}
            <Field label={t("common", K.members.resellerIds)} hint={t("common", K.members.resellerIdsHint)}>
              <textarea className={input} dir="ltr" rows={2} value={tenantText} onChange={(e) => setTenantText(e.target.value)} />
            </Field>
          </>
        )}
        <div>
          <button type="button" className={primaryButton} disabled={busy} onClick={addTyped}>
            {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
            {t("common", K.members.addSubmit)}
          </button>
        </div>
        {notice && <p className="text-xs font-bold text-primary">{notice}</p>}
        {failure && <Alert>{failure}</Alert>}
      </section>
    </Sheet>
  );
}
