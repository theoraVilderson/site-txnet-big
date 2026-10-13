"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale } from "@/context/LocaleContext";
import {
  resellerUsersApi,
  tenantRolesApi,
  type ResellerUserProfile,
  type TenantRole,
} from "@/lib/auth-api";
import { PANEL_GROUPS, myResellerGroupsPath } from "@/lib/routes";
import { TableSkeleton } from "../../../../../_components/kit/TableSkeleton";
import {
  Alert,
  Button,
  Field,
  Input,
  NativeSelect,
  notify,
  useConfirm,
} from "../../../../../_components/kit";
import { formatInstant } from "../../../../../_lib/datetime";
import { SignInAsUser, mayImpersonate } from "../../../../../_components/SignInAsUser";
import { usePanelSession } from "../../../../../_context/PanelSessionContext";
import { ConsentNeeded } from "../../../../_components/PlatformAccessBanner";
import { consentRefusal } from "../../../../_lib/support-access";
import { assignableRoles, teamRefusalKey } from "../../../../_lib/team";
import {
  USER_KEYS as K,
  profileChanges,
  roleEditable,
} from "../../../../_lib/users";
import { useWorkspaceSelf } from "../../../../_lib/workspace";
import { AccessHistory } from "./AccessHistory";
import { UserPermissions } from "./UserPermissions";
import { UserRestrictions } from "./UserRestrictions";
import { useUserMessage } from "./useUserMessage";

const P = K.profile;

/**
 * The Profile tab of one user's page (AC-1-b, `panel-web/contract.reseller-users.md`):
 * auth's `GET`/`PATCH …/users/:userId` (AC-1-a) and the role at
 * `PUT …/users/:userId/role` (F-1201-a), on the **path's** tenant.
 *
 *  - **name and username are edited; the email is only removed.** A stored
 *    address is one its owner proved (identity invariant 15), so staff never
 *    type one; the phone is the person's sign-in and is shown masked;
 *  - **the server's `canAct` decides what is offered** (ADR-0103): without it
 *    the tab is read-only and says why;
 *  - **the role is changed only for someone on the team**, on a reseller
 *    (`roleEditable`): a role without a seat admits nothing there, and the
 *    seat is the Team page's;
 *  - **a save sends only what changed** (`profileChanges`), and the answer
 *    replaces what is shown;
 *  - **every key they hold and where it comes from**, give / take / lift one
 *    (AC-1-n): `UserPermissions`, below the role;
 *  - **the caps and bars on them**, add / change / lift one (F-030-f):
 *    `UserRestrictions`, below the permissions;
 *  - **who changed their access, when and why** (AC-1-p): `AccessHistory`,
 *    below the permissions, re-read after a role or key written here;
 *  - **"sign in as this user"** (AC-1-i) on the caller's own tenant, or for
 *    platform staff on a reseller's user under its consent — `mayImpersonate`:
 *    `canAct` (never the owner, ADR-0137) and the route's key. A reseller's own
 *    workspace has no such route, so no button.
 */
export function UserProfile({
  id,
  userId,
  platform,
  own = false,
  onShown,
}: {
  id: string;
  userId: string;
  /** On the session's own `/users`: the team link is `/team`. */
  own?: boolean;
  /** Each answer shown, so the page's title follows a renamed person. */
  onShown?: (p: ResellerUserProfile) => void;
  platform: boolean;
}) {
  const { t, lang } = useLocale();
  const confirm = useConfirm();
  const userMessage = useUserMessage();
  const self = useWorkspaceSelf(id);
  const { me } = usePanelSession();
  const here = usePathname();
  const message = (e: unknown) => {
    const key = teamRefusalKey(e);
    return key ? t("common", key) : userMessage(e);
  };

  const [person, setPerson] = useState<ResellerUserProfile | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [roles, setRoles] = useState<TenantRole[]>([]);
  const [form, setForm] = useState({ fullName: "", username: "" });
  const [roleId, setRoleId] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  /** Bumped by a role or key written here, so the open access history re-reads (AC-1-p). */
  const [accessMoved, setAccessMoved] = useState(0);

  const show = (p: ResellerUserProfile) => {
    setPerson(p);
    onShown?.(p);
    setForm({ fullName: p.fullName, username: p.username ?? "" });
    setRoleId(p.role?.id ?? "");
  };

  useEffect(() => {
    let alive = true;
    resellerUsersApi
      .profile(id, userId)
      .then((p) => alive && show(p))
      .catch((e) => alive && setLoadError(e));
    return () => {
      alive = false;
    };
  }, [id, userId]);

  const canRole = person ? roleEditable(person, platform) : false;
  useEffect(() => {
    if (!canRole) return;
    let alive = true;
    tenantRolesApi
      .list(id)
      .then((r) => alive && setRoles(assignableRoles(r.roles, r.grantable)))
      .catch(() => alive && setRoles([]));
    return () => {
      alive = false;
    };
  }, [id, canRole]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await work();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  if (consentRefusal(loadError)) return <ConsentNeeded error={loadError} />;
  if (loadError !== null)
    return <Alert tone="error">{message(loadError)}</Alert>;
  if (!person) return <TableSkeleton rows={4} columns={2} />;

  const changes = profileChanges(person, form);
  const save = () =>
    run(async () => {
      if (!changes) return;
      show(await resellerUsersApi.editProfile(id, userId, changes));
      notify.success(t("common", P.saved));
    });

  async function removeEmail() {
    const sure = await confirm({
      title: t("common", P.removeEmailConfirm, {
        name: person?.fullName ?? "",
      }),
      body: t("common", P.removeEmailHint),
      confirmLabel: t("common", P.removeEmail),
      tone: "danger",
    });
    if (!sure) return;
    await run(async () => {
      show(await resellerUsersApi.editProfile(id, userId, { email: null }));
      notify.success(t("common", P.emailRemoved));
    });
  }

  const changeRole = () =>
    run(async () => {
      await tenantRolesApi.assign(id, userId, roleId);
      setAccessMoved((n) => n + 1);
      show(await resellerUsersApi.profile(id, userId));
      notify.success(t("common", P.roleSaved));
    });

  const editable = person.canAct;
  const impersonable = (own || platform) && mayImpersonate(person, me, !own);

  return (
    <div className="space-y-6">
      {impersonable && (
        <div className="flex justify-end">
          <SignInAsUser userId={userId} name={person.fullName} tenantId={own ? null : id} returnTo={here ?? "/"} />
        </div>
      )}
      {!editable && <Alert tone="info">{t("common", P.readOnly)}</Alert>}
      {actionError !== null && (
        <Alert tone="error">{message(actionError)}</Alert>
      )}

      <section className="space-y-4 rounded-2xl border border-card-border bg-card-bg p-4 md:p-6">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t("common", P.fullName)}>
            <Input
              value={form.fullName}
              maxLength={120}
              disabled={!editable || busy}
              onChange={(e) =>
                setForm((f) => ({ ...f, fullName: e.target.value }))
              }
            />
          </Field>
          <Field label={t("common", P.username)}>
            <Input
              dir="ltr"
              value={form.username}
              maxLength={32}
              disabled={!editable || busy}
              onChange={(e) =>
                setForm((f) => ({ ...f, username: e.target.value }))
              }
            />
          </Field>
        </div>
        {editable && (
          <Button
            variant="primary"
            size="sm"
            disabled={!changes || busy}
            onClick={save}
          >
            {t("common", P.save)}
          </Button>
        )}
      </section>

      <dl className="grid gap-4 rounded-2xl border border-card-border bg-card-bg p-4 text-sm md:grid-cols-2 md:p-6">
        <div>
          <dt className="text-text-secondary">{t("common", P.phone)}</dt>
          <dd dir="ltr" className="text-start">
            {person.phoneMasked ?? "—"}
          </dd>
          <dd className="mt-1 text-xs text-text-secondary">
            {t("common", P.phoneHint)}
          </dd>
        </div>
        <div>
          <dt className="text-text-secondary">{t("common", P.email)}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <span dir="ltr">
              {person.emailMasked ?? t("common", P.noEmail)}
            </span>
            {editable && person.emailMasked && (
              <Button
                variant="danger"
                size="sm"
                disabled={busy}
                onClick={removeEmail}
              >
                {t("common", P.removeEmail)}
              </Button>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-text-secondary">{t("common", P.status)}</dt>
          <dd>{t("common", K.userStatus[person.status])}</dd>
        </div>
        <div>
          <dt className="text-text-secondary">{t("common", P.joined)}</dt>
          <dd>{formatInstant(person.createdAt, lang, { withTime: false })}</dd>
        </div>
      </dl>

      <section className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-4 md:p-6">
        {canRole ? (
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t("common", P.role)}>
              <NativeSelect
                value={roleId}
                disabled={busy}
                onChange={(e) => setRoleId(e.target.value)}
              >
                {/* The held role stays listed even when this caller may not give it. */}
                {person.role &&
                  !roles.some((r) => r.id === person.role?.id) && (
                    <option value={person.role.id}>{person.role.name}</option>
                  )}
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || !roleId || roleId === person.role?.id}
              onClick={changeRole}
            >
              {t("common", P.roleSave)}
            </Button>
          </div>
        ) : (
          <div className="text-sm">
            <p className="text-text-secondary">{t("common", P.role)}</p>
            <p>{person.role?.name ?? t("common", P.noRole)}</p>
            {editable && !platform && (
              <Link
                href={own ? PANEL_GROUPS : myResellerGroupsPath(id, self)}
                className="mt-2 inline-block text-xs font-bold text-primary hover:underline"
              >
                {t("common", P.roleOnTeam)}
              </Link>
            )}
          </div>
        )}
      </section>

      <UserPermissions id={id} userId={userId} canAct={editable} onChange={() => setAccessMoved((n) => n + 1)} />
      <UserRestrictions id={id} userId={userId} canAct={editable} />
      <AccessHistory id={id} userId={userId} refresh={accessMoved} />
    </div>
  );
}
