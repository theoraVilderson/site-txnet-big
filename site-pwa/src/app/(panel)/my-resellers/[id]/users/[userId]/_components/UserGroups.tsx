"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Trash2, Users } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { ApiError } from "@/lib/api-error";
import { groupsApi, type PersonGroup } from "@/lib/auth-api";
import { TableSkeleton } from "../../../../../_components/kit/TableSkeleton";
import { DatePicker } from "../../../../../_components/kit/DatePicker";
import { Alert, Badge, Button, buttonClass, Field, NativeSelect, notify, useConfirm } from "../../../../../_components/kit";
import { formatInstant, instantOf, type WallTime } from "../../../../../_lib/datetime";
import { refusalKey } from "../../../../../groups/_lib/user-groups";
import { USER_KEYS, groupsPagePath, personGroupLists } from "../../../../_lib/users";
import { useWorkspaceSelf } from "../../../../_lib/workspace";
import { useUserMessage } from "./useUserMessage";

const K = USER_KEYS.profile.groups;

/**
 * The Profile tab's groups (GR-1-u, ADR-0139 (1)) — where the role picker was:
 * the groups this person is in, with each membership's end, and add / remove.
 * One person's change is the members route's (`POST …/members/changes`,
 * GR-1-i), so every rule of a member write holds here unchanged: the writer
 * holds every key the group gives, has authority over the person, and stays
 * inside `staff_members_max`.
 *
 * `tenantId` null is the session's own groups; otherwise the path's tenant's,
 * behind its door. A caller who may not manage groups gets a 403 and no section.
 */
export function UserGroups({
  tenantId,
  userId,
  name,
  canAct,
  onChange,
}: {
  tenantId: string | null;
  userId: string;
  name: string;
  canAct: boolean;
  /** A membership written here, so the access shown below re-reads. */
  onChange?: () => void;
}) {
  const { t, lang } = useLocale();
  const confirm = useConfirm();
  const userMessage = useUserMessage();
  const message = (e: unknown) => {
    const key = refusalKey(e);
    return key ? t("common", key) : userMessage(e);
  };
  const api = groupsApi(tenantId);
  const self = useWorkspaceSelf(tenantId ?? "");

  const [groups, setGroups] = useState<PersonGroup[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [pick, setPick] = useState("");
  const [end, setEnd] = useState<WallTime | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  const load = () => api.personGroups(userId).then(setGroups);

  useEffect(() => {
    let alive = true;
    groupsApi(tenantId)
      .personGroups(userId)
      .then((g) => alive && setGroups(g))
      .catch((e) => alive && setLoadError(e));
    return () => {
      alive = false;
    };
  }, [tenantId, userId]);

  if (loadError instanceof ApiError && loadError.status === 403) return null;
  if (loadError !== null) return <Alert tone="error">{message(loadError)}</Alert>;
  if (!groups) return <TableSkeleton rows={2} columns={2} />;

  const { member, joinable } = personGroupLists(groups);

  async function run(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    setActionError(null);
    try {
      await work();
      await load();
      onChange?.();
      notify.success(t("common", done));
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  const add = () =>
    run(async () => {
      await api.changeMembers(pick, { add: [{ userId, expiresAt: end ? instantOf(end) : null }], remove: [], ends: [] });
      setPick("");
      setEnd(null);
    }, K.added);

  async function remove(group: PersonGroup) {
    const sure = await confirm({
      title: t("common", K.removeConfirm, { name, group: group.name }),
      body: t("common", K.removeHint),
      confirmLabel: t("common", K.remove),
      tone: "danger",
    });
    if (sure) await run(() => api.changeMembers(group.id, { add: [], remove: [{ userId }], ends: [] }), K.removed);
  }

  return (
    <section className="space-y-4 rounded-2xl border border-card-border bg-card-bg p-4 md:p-6">
      <div>
        <h3 className="flex items-center gap-2 font-bold">
          <Users size={16} aria-hidden />
          {t("common", K.title)}
        </h3>
        <p className="mt-1 text-xs text-text-secondary">{t("common", K.hint)}</p>
      </div>
      {actionError !== null && <Alert tone="error">{message(actionError)}</Alert>}

      {groups.length === 0 ? (
        <p className="text-sm text-text-secondary">{t("common", K.none)}</p>
      ) : member.length === 0 ? (
        <p className="text-sm text-text-secondary">{t("common", K.notInAny)}</p>
      ) : (
        <ul className="divide-y divide-card-border text-sm">
          {member.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-bold">{g.name}</span>
                {g.givesKeys && <Badge tone="info">{t("common", K.givesKeys)}</Badge>}
                <span className="text-xs text-text-secondary">
                  {g.expiresAt ? t("common", K.until, { date: formatInstant(g.expiresAt, lang, { withTime: true }) ?? g.expiresAt }) : t("common", K.noEnd)}
                </span>
              </span>
              {canAct && g.mayChange && (
                <Button variant="quiet" size="sm" disabled={busy} onClick={() => void remove(g)} icon={<Trash2 size={12} aria-hidden />}>
                  {t("common", K.remove)}
                </Button>
              )}
              {canAct && !g.mayChange && <span className="w-full text-xs text-text-secondary">{t("common", K.notYours)}</span>}
            </li>
          ))}
        </ul>
      )}

      {canAct && joinable.length > 0 && (
        <div className="flex flex-wrap items-end gap-3 border-t border-card-border pt-4">
          <Field label={t("common", K.addTo)}>
            <NativeSelect value={pick} disabled={busy} onChange={(e) => setPick(e.target.value)}>
              <option value="">{t("common", K.pickGroup)}</option>
              {joinable.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <DatePicker withTime label={t("common", K.end)} value={end} onChange={setEnd} />
          <Button variant="primary" size="sm" disabled={busy || !pick} onClick={add}>
            {t("common", K.add)}
          </Button>
        </div>
      )}
      {/* With every group taken the add row used to vanish silently; say why and where to make one (user, 2026-10-14). */}
      {canAct && joinable.length === 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-card-border pt-4">
          <p className="text-sm text-text-secondary">{t("common", K.noneLeft)}</p>
          <Link href={groupsPagePath(tenantId, self)} className={buttonClass({ variant: "quiet", size: "sm" })}>
            {t("common", K.openGroups)}
            <ArrowLeft size={12} className="ltr:rotate-180" aria-hidden />
          </Link>
        </div>
      )}
    </section>
  );
}
