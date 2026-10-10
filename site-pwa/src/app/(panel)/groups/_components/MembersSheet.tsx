"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Loader2, RotateCcw, RotateCw, Store, Trash2, User, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { UserGroup, UserGroupMember } from "@/lib/auth-api";
import { DatePicker } from "../../_components/kit/DatePicker";
import { tenantApi, type Reseller } from "@/lib/tenant-api";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { formatInstant } from "../../_lib/datetime";
import { canAdministerResellers } from "../../resellers/_lib/resellers";
import {
  MEMBER_IDS_MAX,
  USER_GROUP_KEYS as K,
  canNameResellers,
  changesBody,
  draftAdd,
  draftEnd,
  draftSize,
  draftToggleRemove,
  emptyMembersDraft,
  memberKey,
  memberSearchOf,
  parseIds,
  type MemberPick,
  type MembersDraft,
} from "../_lib/user-groups";
import { Alert, Field, Sheet, useGroupsScope, useMessage } from "./user-groups-ui";
import { UserSearch } from "./UserSearch";
import { Badge, Button, Textarea, useConfirm } from "../../_components/kit";

const PAGE_SIZE = 50;

/** One row the sheet lists: a member on the page, or someone the draft adds. */
type Line = {
  key: string;
  kind: "user" | "tenant";
  id: string;
  label: string;
  /** `YYYY-MM-DD` as saved, or null. */
  savedEnd: string | null;
  pending: boolean;
};

/**
 * One group's members (F-114-m), edited as a draft and saved at once
 * (GR-1-j, user 2026-10-10):
 *
 *  - **one box finds everyone who can join** — the caller's own users, and on
 *    the platform's own group the resellers too, marked as such; a pick lands
 *    in the list as *new*, nothing is sent;
 *  - **one list**: members and pending adds together; remove marks a row (and
 *    undoes), the date chip sets a person's own end;
 *  - **Save** sends every change as one `POST …/members/changes` (GR-1-i) —
 *    all of it or none; a refusal names its row and the draft stays to fix;
 *  - closing with changes unsaved asks first.
 *
 * Nothing is patched from an answer: a save re-reads the page, and
 * `onChanged` the counts.
 */
export function MembersSheet({ group, onClose, onChanged }: { group: UserGroup; onClose: () => void; onChanged: () => void }) {
  const { t, lang } = useLocale();
  const confirm = useConfirm();
  const { me } = usePanelSession();
  const message = useMessage();
  const { tenantId, api } = useGroupsScope();
  const search = memberSearchOf(me, tenantId);
  const searchTenant = tenantId ?? me?.tenant.id ?? "";
  const resellersToo = canNameResellers(me, tenantId) && !group.allTenants;

  const [page, setPage] = useState(1);
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  const [rows, setRows] = useState<{ items: UserGroupMember[]; total: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const key = `${page}|${asked}`;
  const [loaded, setLoaded] = useState<string | null>(null);

  const [draft, setDraft] = useState<MembersDraft>(emptyMembersDraft);
  // The person whose end is open for editing.
  const [editing, setEditing] = useState<string | null>(null);
  const [idText, setIdText] = useState("");
  const [resellers, setResellers] = useState<Reseller[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ text: string; row: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const answer = await api.members(group.id, page, PAGE_SIZE);
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
  }, [api, group.id, page, key]);

  // Resellers the search box can also name, for a caller who may read the list.
  const pickable = resellersToo && canAdministerResellers(me);
  useEffect(() => {
    if (!pickable) return;
    tenantApi.resellers(100, 0).then(setResellers, () => setResellers(null));
  }, [pickable]);

  const present = useMemo(() => new Set((rows?.items ?? []).map(memberKey)), [rows]);
  const taken = useMemo(() => new Set([...present, ...draft.add.map((a) => `${a.kind}:${a.id}`)]), [present, draft.add]);
  const pending = draftSize(draft);

  const pick = (p: MemberPick) => {
    setNotice(null);
    setDraft((d) => draftAdd(d, p, present));
  };

  function addIds() {
    const { ids, bad } = parseIds(idText);
    if (bad.length > 0) return setFailure({ text: t("common", K.errors.badIds, { ids: bad.join(", ") }), row: null });
    if (ids.length > MEMBER_IDS_MAX) return setFailure({ text: t("common", K.errors.tooManyIds), row: null });
    setFailure(null);
    setDraft((d) => ids.reduce((acc, id) => draftAdd(acc, { kind: "user", id, label: id }, present), d));
    setIdText("");
  }

  async function save() {
    const body = changesBody(draft);
    if (!body || busy) return;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      await api.changeMembers(group.id, body);
      setDraft(emptyMembersDraft);
      setEditing(null);
      setNotice(t("common", K.members.saved));
      reload();
      onChanged();
    } catch (e) {
      // All or none (GR-1-i): nothing was written. `facts.detail` names the member refused, when one was.
      const detail = (e as { facts?: Record<string, unknown> } | null)?.facts?.detail;
      const row = typeof detail === "string" ? [`user:${detail}`, `tenant:${detail}`].find((k) => taken.has(k)) ?? null : null;
      setFailure({ text: message(e), row });
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    if (pending > 0 && !(await confirm({ title: t("common", K.members.confirmClose), confirmLabel: t("common", K.members.close), tone: "danger" }))) return;
    onClose();
  }

  // Pending adds first, newest last; then the page's members.
  const lines: Line[] = [
    ...draft.add.map((a) => ({ key: `${a.kind}:${a.id}`, kind: a.kind, id: a.id, label: a.label, savedEnd: null, pending: true })),
    ...(rows?.items ?? []).map((m) => ({
      key: memberKey(m),
      kind: m.memberType,
      id: (m.userId ?? m.tenantId) as string,
      label: m.label ?? t("common", K.members.noLabel),
      savedEnd: m.expiresAt?.slice(0, 10) ?? null,
      pending: false,
    })),
  ];
  const endOf = (line: Line): string | null => {
    if (line.pending) return draft.add.find((a) => `${a.kind}:${a.id}` === line.key)?.endDay ?? null;
    return line.id in draft.ends ? draft.ends[line.id] : line.savedEnd;
  };
  const pages = rows ? Math.max(1, Math.ceil(rows.total / PAGE_SIZE)) : 1;

  return (
    <Sheet
      title={t("common", K.members.title, { name: group.name })}
      onClose={() => void close()}
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          <span className="me-auto text-xs font-bold text-text-secondary">{pending > 0 ? t("common", K.members.pending, { count: pending }) : null}</span>
          <Button variant="quiet" size="sm" disabled={busy || pending === 0} onClick={() => setDraft(emptyMembersDraft)} icon={<RotateCcw size={12} aria-hidden />}>
            {t("common", K.members.discard)}
          </Button>
          <Button variant="primary" size="sm" disabled={pending === 0} loading={busy} onClick={() => void save()}>
            {t("common", K.members.save)}
          </Button>
        </div>
      }
    >
      {group.allTenants && <p className="text-xs font-bold text-primary">{t("common", K.members.allTenantsNote)}</p>}

      <section className="flex flex-col gap-2">
        {search !== "ids" && searchTenant ? (
          <UserSearch
            via={search}
            tenantId={searchTenant}
            busy={busy}
            taken={taken}
            placeholder={t("common", resellersToo ? K.members.searchAllResellers : K.members.searchAll)}
            onAdd={(hit) => pick({ kind: "user", id: hit.id, label: hit.fullName || hit.username || hit.id })}
            resellers={pickable ? resellers : null}
            onAddReseller={(r) => pick({ kind: "tenant", id: r.id, label: r.slug })}
          />
        ) : (
          <Field label={t("common", K.members.byIds)} hint={t("common", K.members.userIdsHint)}>
            <div className="flex flex-col gap-2">
              <Textarea dir="ltr" rows={2} value={idText} onChange={(e) => setIdText(e.target.value)} />
              <Button variant="quiet" size="sm" className="self-start" onClick={addIds}>
                {t("common", K.members.addIds)}
              </Button>
            </div>
          </Field>
        )}
        <p className="text-[11px] text-text-secondary">{t("common", K.members.draftHint)}</p>
      </section>

      {notice && <p className="text-xs font-bold text-primary">{notice}</p>}
      {failure && <Alert>{failure.text}</Alert>}

      {loaded !== key ? (
        <p className="flex items-center gap-1.5 text-xs text-text-secondary">
          <Loader2 size={12} className="animate-spin" aria-hidden />
        </p>
      ) : error ? (
        <div className="flex flex-wrap items-center gap-3">
          <Alert>{message(error)}</Alert>
          <Button variant="quiet" size="sm" onClick={reload} icon={<RotateCw size={12} aria-hidden />}>
            {t("common", K.retry)}
          </Button>
        </div>
      ) : lines.length === 0 ? (
        <p className="text-sm text-text-secondary">{t("common", K.members.empty)}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-text-secondary">{t("common", K.members.total, { count: rows?.total ?? 0 })}</p>
          <ul className="flex flex-col divide-y divide-card-border overflow-hidden rounded-xl border border-card-border">
            {lines.map((line) => {
              const Icon = line.kind === "user" ? User : Store;
              const removed = draft.remove.includes(line.key);
              const end = endOf(line);
              const endMoved = !line.pending && line.id in draft.ends;
              const refused = failure?.row === line.key;
              return (
                <li key={line.key} className={`flex flex-col gap-2 px-3 py-2 ${refused ? "bg-error-bg" : line.pending ? "bg-bg-inner" : ""}`}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <Icon size={14} className="shrink-0 text-text-secondary" aria-label={t("common", line.kind === "user" ? K.members.user : K.members.reseller)} />
                      <span className="flex min-w-0 flex-col">
                        <span className={`truncate text-sm font-bold text-text-primary ${removed ? "line-through opacity-60" : ""}`} dir="auto">
                          {line.label}
                        </span>
                        {line.kind === "user" && (
                          <span className="text-[11px] text-text-secondary">
                            {end ? t("common", K.members.endsOn, { date: formatInstant(`${end}T12:00:00Z`, lang, { withTime: false }) ?? end }) : t("common", K.members.noEnd)}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                      {line.kind === "tenant" && <Badge tone="neutral">{t("common", K.members.reseller)}</Badge>}
                      {line.pending && <Badge tone="success">{t("common", K.members.newBadge)}</Badge>}
                      {removed && <Badge tone="error">{t("common", K.members.removedBadge)}</Badge>}
                      {endMoved && <Badge tone="info">{t("common", K.members.endChangedBadge)}</Badge>}
                      {refused && <Badge tone="error">{t("common", K.members.refusedRow)}</Badge>}
                      {line.kind === "user" && !removed && (
                        <Button
                          variant="quiet"
                          size="sm"
                          disabled={busy}
                          aria-expanded={editing === line.key}
                          onClick={() => setEditing(editing === line.key ? null : line.key)}
                          icon={<CalendarClock size={12} aria-hidden />}
                        >
                          {t("common", K.members.changeEnd)}
                        </Button>
                      )}
                      <Button
                        variant="quiet"
                        size="sm"
                        disabled={busy}
                        onClick={() => setDraft((d) => draftToggleRemove(d, line.key))}
                        icon={removed ? <RotateCcw size={12} aria-hidden /> : line.pending ? <X size={12} aria-hidden /> : <Trash2 size={12} aria-hidden />}
                      >
                        {t("common", removed ? K.members.undo : K.members.remove)}
                      </Button>
                    </span>
                  </div>
                  {editing === line.key && line.kind === "user" && (
                    <div className="flex flex-wrap items-end gap-2">
                      <DatePicker label={t("common", K.members.end)} value={end} onChange={(day) => setDraft((d) => draftEnd(d, line.id, day, line.savedEnd))} />
                      {end && (
                        <Button variant="quiet" size="sm" onClick={() => setDraft((d) => draftEnd(d, line.id, null, line.savedEnd))}>
                          {t("common", K.members.noEnd)}
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {pages > 1 && (
            <nav className="flex justify-between">
              <Button variant="quiet" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                {t("common", K.prev)}
              </Button>
              <Button variant="quiet" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                {t("common", K.next)}
              </Button>
            </nav>
          )}
        </div>
      )}
    </Sheet>
  );
}
