"use client";

import { useEffect, useState } from "react";
import { CalendarClock, KeyRound, RefreshCw, UserMinus, UserPlus } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { authApi, resellerUsersApi, tenantRolesApi, type ResellerUser, type TenantRole } from "@/lib/auth-api";
import { resellerStaffApi, type StaffSeat, type StaffState } from "@/lib/tenant-api";
import { TableSkeleton } from "../../../../_components/kit/TableSkeleton";
import { DatePicker } from "../../../../_components/kit/DatePicker";
import { formatInstant } from "../../../../_lib/datetime";
import { usePanelSession } from "../../../../_context/PanelSessionContext";
import { useOwnTenantRedirect } from "../../../_lib/useOwnTenantRedirect";
import { USERS_QUERY_MIN, isPlatformTenant, usersQuery } from "../../../_lib/users";
import { assignableRoles, customerRole, endOfDay, teamRefusalKey } from "../../../_lib/team";
import { useUserMessage } from "../../users/[userId]/_components/useUserMessage";
import { ConsentNeeded, PlatformAccessBanner } from "../../../_components/PlatformAccessBanner";
import { consentRefusal } from "../../../_lib/support-access";
import { Alert, Button, Dialog, Field, Input, NativeSelect, PageHeader, useConfirm } from "../../../../_components/kit";

const K = FrontendI18nKeys.common.tenantTeam;

/** How long typing rests before users are searched. */
const TYPING_MS = 350;
/** The platform's team is read in one page: staff are few, and this list has no seats to page by. */
const PLATFORM_TEAM_PAGE = 100;

const STATE_TONE: Record<StaffState, string> = {
  invited: "border-card-border bg-bg-inner text-text-secondary",
  active: "border-primary/20 bg-leaf-bg text-primary",
  expired: "border-gold/20 bg-gold-bg text-gold",
  revoked: "border-error-border bg-error-bg text-error",
};

/** One person on the page, whichever way the tenant keeps its team. */
type Member = {
  /** The row's key: the seat on a reseller, the user on the platform. */
  key: string;
  userId: string;
  name: string;
  username: string | null;
  role: { id: string; name: string } | null;
  /** Reseller seats only — the platform has none (`contract.team.md`). */
  seat: StaffSeat | null;
};

type Asking =
  | { kind: "add" }
  | { kind: "role"; member: Member }
  | { kind: "expiry"; member: Member & { seat: StaffSeat } };

/**
 * A tenant's team (F-1201-c, `panel-web/contract.team.md`), on the path's tenant:
 *
 *  - **a reseller's team is its seats** (F-018-j): role, state and end; invite
 *    an existing user of the reseller, then — when a role was chosen — set it
 *    at auth (F-1201-a: tenant-service never writes a user); move or clear the
 *    end in place (F-1201-b); remove with a confirm, which keeps their role;
 *  - **the platform's team is the people holding a staff role**: no seat and
 *    no end. Adding is giving a role; taking off is giving the template with
 *    no permission;
 *  - **a role is offered only when this caller may give all of it**
 *    (`grantable`, identity invariant 18); auth decides authority over the
 *    person, and its refusal is said as a sentence.
 */
export function TeamView({ id, own = false }: { id: string; own?: boolean }) {
  const { t, lang } = useLocale();
  const confirm = useConfirm();
  const userMessage = useUserMessage();
  const { me } = usePanelSession();
  const platform = isPlatformTenant(id, me);
  useOwnTenantRedirect(own, me?.tenant.id);
  const message = (e: unknown) => {
    const key = teamRefusalKey(e);
    return key ? t("common", key) : userMessage(e);
  };

  const [members, setMembers] = useState<Member[] | null>(null);
  const [roles, setRoles] = useState<{ roles: TenantRole[]; grantable: string[] } | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const [slug, setSlug] = useState<string | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The dialogs' fields.
  const [typed, setTyped] = useState("");
  const [found, setFound] = useState<ResellerUser[] | null>(null);
  const [picked, setPicked] = useState<ResellerUser | null>(null);
  const [roleId, setRoleId] = useState("");
  const [day, setDay] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const team: Promise<Member[]> = platform
      ? resellerUsersApi
          .list(id, { page: 1, pageSize: PLATFORM_TEAM_PAGE, staff: true })
          .then((page) => page.items.map((u) => ({ key: u.id, userId: u.id, name: u.fullName, username: u.username ?? null, role: u.role ?? null, seat: null })))
      : resellerStaffApi.list(id).then((seats) =>
          seats.map((s) => ({ key: s.id, userId: s.userId, name: s.user?.fullName ?? "", username: s.user?.username ?? null, role: s.role, seat: s })),
        );
    Promise.all([team, tenantRolesApi.list(id)])
      .then(([list, r]) => {
        if (!alive) return;
        setMembers(list);
        setRoles(r);
        setLoadError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setMembers(null);
        setLoadError(e);
      });
    return () => {
      alive = false;
    };
  }, [id, platform, asked]);

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

  // The add dialog's search: typing rests, then this tenant's users are asked.
  useEffect(() => {
    if (asking?.kind !== "add") return;
    const q = usersQuery(typed, 1).q;
    if (!q) {
      setFound(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      resellerUsersApi
        .list(id, { q, page: 1, pageSize: 10 })
        .then((page) => alive && setFound(page.items))
        .catch((e) => alive && setActionError(e));
    }, TYPING_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id, typed, asking]);

  const reload = () => {
    setLoadError(null);
    setAsked((n) => n + 1);
  };
  const nameOf = (m: { name: string; username: string | null }) => m.name || m.username || t("common", K.unnamed);
  const offered = roles ? assignableRoles(roles.roles, roles.grantable) : [];

  function open(next: Asking) {
    setActionError(null);
    setNotice(null);
    setTyped("");
    setFound(null);
    setPicked(null);
    setRoleId(next.kind === "role" ? (next.member.role?.id ?? "") : "");
    setDay(next.kind === "expiry" ? (next.member.seat.accessExpiresAt?.slice(0, 10) ?? null) : null);
    setAsking(next);
  }

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await work();
      setAsking(null);
      reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  const add = () =>
    run(async () => {
      if (!picked) return;
      if (platform) {
        await tenantRolesApi.assign(id, picked.id, roleId);
        return;
      }
      await resellerStaffApi.invite(id, { userId: picked.id, ...(day ? { accessExpiresAt: endOfDay(day) } : {}) });
      if (!roleId) return;
      try {
        await tenantRolesApi.assign(id, picked.id, roleId);
      } catch (e) {
        // The seat stands; only the role is missing, and the row offers to set it.
        setNotice(t("common", K.roleNotSet, { reason: message(e) }));
      }
    });

  const changeRole = (member: Member) => run(async () => void (await tenantRolesApi.assign(id, member.userId, roleId)));

  const setExpiry = (seat: StaffSeat, value: string | null) =>
    run(async () => void (await resellerStaffApi.setExpiry(id, seat.id, value ? endOfDay(value) : null)));

  async function remove(member: Member) {
    const sure = await confirm({
      title: t("common", K.removeConfirm, { name: nameOf(member) }),
      body: t("common", platform ? K.removePlatformHint : K.removeHint),
      confirmLabel: t("common", K.remove),
      tone: "danger",
    });
    if (!sure) return;
    setNotice(null);
    setActionError(null);
    try {
      if (member.seat) await resellerStaffApi.remove(id, member.seat.id);
      else {
        const plain = roles && customerRole(roles.roles);
        if (plain) await tenantRolesApi.assign(id, member.userId, plain.id);
      }
      reload();
    } catch (e) {
      setActionError(e);
    }
  }

  const rolePicker = (allowKeep: boolean) => (
    <Field label={t("common", K.role)}>
      <NativeSelect value={roleId} onChange={(e) => setRoleId(e.target.value)}>
        <option value="">{t("common", allowKeep ? K.roleKeep : K.roleRequired)}</option>
        {offered.map((role) => (
          <option key={role.id} value={role.id}>
            {role.name}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );

  const short = typed.trim().length > 0 && typed.trim().length < USERS_QUERY_MIN;
  const visible = members?.filter((m) => m.seat?.state !== "revoked") ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
      <PageHeader
        title={own || platform ? t("common", FrontendI18nKeys.common.shell.menu.team) : slug ? t("common", K.titleOf, { slug }) : t("common", K.title)}
        subtitle={t("common", platform ? K.subtitlePlatform : K.subtitle)}
        actions={
          <>
            <Button variant="quiet" size="sm" onClick={reload} icon={<RefreshCw size={12} aria-hidden />}>
              {t("common", K.refresh)}
            </Button>
            <Button variant="primary" size="sm" disabled={!members} onClick={() => open({ kind: "add" })} icon={<UserPlus size={12} aria-hidden />}>
              {t("common", K.add)}
            </Button>
          </>
        }
      />

      <PlatformAccessBanner tenantId={id} onChange={reload} />
      {notice && <Alert tone="warning">{notice}</Alert>}
      {actionError !== null && asking === null && <Alert tone="error">{message(actionError)}</Alert>}

      {consentRefusal(loadError) ? (
        <ConsentNeeded error={loadError} />
      ) : loadError !== null ? (
        <div className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-6">
          <Alert tone="error">{message(loadError)}</Alert>
          <Button variant="primary" size="sm" onClick={reload}>
            {t("common", K.reload)}
          </Button>
        </div>
      ) : members === null ? (
        <TableSkeleton rows={4} columns={3} />
      ) : visible.length === 0 ? (
        <p className="rounded-2xl border border-card-border bg-card-bg p-6 text-sm text-text-secondary">{t("common", K.empty)}</p>
      ) : (
        <ul className="divide-y divide-card-border overflow-hidden rounded-2xl border border-card-border bg-card-bg">
          {visible.map((member) => (
            <li key={member.key} data-testid={member.seat ? `seat-${member.seat.id}` : `staff-${member.userId}`} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-text-primary">{nameOf(member)}</p>
                <p className="flex flex-wrap gap-x-3 text-xs text-text-secondary">
                  {member.username && <span dir="ltr">@{member.username}</span>}
                  <span>
                    {t("common", K.columns.role)}: <span className="text-text-primary">{member.role?.name ?? t("common", K.noRole)}</span>
                  </span>
                  {member.seat && (
                    <span>
                      {t("common", K.columns.expires)}:{" "}
                      {member.seat.accessExpiresAt ? formatInstant(member.seat.accessExpiresAt, lang, { withTime: false }) : t("common", K.noExpiry)}
                    </span>
                  )}
                </p>
              </div>
              {member.seat && (
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATE_TONE[member.seat.state]}`}>
                  {t("common", K.state[member.seat.state])}
                </span>
              )}
              <Button variant="quiet" size="sm" icon={<KeyRound size={12} aria-hidden />} onClick={() => open({ kind: "role", member })}>
                {t("common", K.changeRole)}
              </Button>
              {member.seat && (
                <Button
                  variant="quiet"
                  size="sm"
                  icon={<CalendarClock size={12} aria-hidden />}
                  onClick={() => open({ kind: "expiry", member: member as Member & { seat: StaffSeat } })}
                >
                  {t("common", K.changeExpiry)}
                </Button>
              )}
              <Button variant="quiet" size="sm" icon={<UserMinus size={12} aria-hidden />} onClick={() => void remove(member)}>
                {t("common", K.remove)}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={
          asking?.kind === "add"
            ? t("common", K.dialogAdd)
            : asking?.kind === "role"
              ? t("common", K.dialogRole, { name: nameOf(asking.member) })
              : asking?.kind === "expiry"
                ? t("common", K.dialogExpiry, { name: nameOf(asking.member) })
                : ""
        }
        footer={
          <>
            <Button variant="quiet" onClick={() => setAsking(null)}>
              {t("common", K.cancel)}
            </Button>
            {asking?.kind === "expiry" && (
              <Button variant="quiet" disabled={busy} onClick={() => void setExpiry(asking.member.seat, null)}>
                {t("common", K.clear)}
              </Button>
            )}
            <Button
              variant="primary"
              loading={busy}
              disabled={
                asking?.kind === "add" ? !picked || (platform && !roleId) : asking?.kind === "role" ? !roleId : asking?.kind === "expiry" ? !day : true
              }
              onClick={() => {
                if (asking?.kind === "add") void add();
                else if (asking?.kind === "role") void changeRole(asking.member);
                else if (asking?.kind === "expiry") void setExpiry(asking.member.seat, day);
              }}
            >
              {t("common", K.save)}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {actionError !== null && asking !== null && <Alert tone="error">{message(actionError)}</Alert>}
          {asking?.kind === "add" && (
            <>
              <Field label={t("common", K.search)} hint={short ? t("common", K.searchHint) : undefined}>
                <Input type="search" value={typed} onChange={(e) => setTyped(e.target.value)} />
              </Field>
              {picked ? (
                <p className="text-sm text-text-primary">{t("common", K.picked, { name: picked.fullName || picked.username || "" })}</p>
              ) : found && found.length === 0 ? (
                <p className="text-sm text-text-secondary">{t("common", K.noMatch)}</p>
              ) : (
                found && (
                  <ul className="divide-y divide-card-border rounded-xl border border-card-border">
                    {found.map((u) => (
                      <li key={u.id} className="flex items-center gap-2 px-3 py-2">
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {u.fullName || t("common", K.unnamed)} {u.username && <span dir="ltr" className="text-xs text-text-secondary">@{u.username}</span>}
                        </span>
                        <Button variant="quiet" size="sm" onClick={() => setPicked(u)}>
                          {t("common", K.pick)}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )
              )}
              {rolePicker(!platform)}
              {!platform && (
                <>
                  <Field label={t("common", K.expiry)} hint={t("common", K.expiryHint)}>
                    <DatePicker label={t("common", K.expiry)} value={day} onChange={setDay} />
                  </Field>
                  <p className="text-xs text-text-secondary">{t("common", K.inviteNote)}</p>
                </>
              )}
            </>
          )}
          {asking?.kind === "role" && rolePicker(false)}
          {asking?.kind === "expiry" && (
            <Field label={t("common", K.expiry)} hint={t("common", K.expiryHint)}>
              <DatePicker label={t("common", K.expiry)} value={day} onChange={setDay} />
            </Field>
          )}
        </div>
      </Dialog>
    </div>
  );
}
