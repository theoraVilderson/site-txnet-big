"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Ban, RefreshCw, Search, ShieldAlert, Undo2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { authApi, resellerUsersApi, type ResellerUser } from "@/lib/auth-api";
import { useWorkspaceSelf } from "../../../_lib/workspace";
import { useOwnTenantRedirect } from "../../../_lib/useOwnTenantRedirect";
import { Pagination } from "../../../../_components/kit/Pagination";
import { TableSkeleton } from "../../../../_components/kit/TableSkeleton";
import { formatInstant } from "../../../../_lib/datetime";
import { usePanelSession } from "../../../../_context/PanelSessionContext";
import { USERS_PAGE_SIZE, USERS_QUERY_MIN, USER_KEYS as K, canBanHere, isPlatformWorkspace, statusActionsOf, userPagePath, usersQuery, type StatusAction } from "../../../_lib/users";
import { useUserMessage } from "../[userId]/_components/useUserMessage";
import { CompensationCapCard, TenantGrantLimitCard } from "../../../_components/GrantLimitCards";
import { grantKeyHeld } from "../../../_lib/grant-actions";
import { ConsentNeeded, PlatformAccessBanner } from "../../../_components/PlatformAccessBanner";
import { consentRefusal } from "../../../_lib/support-access";
import { BulkByFilter } from "./BulkByFilter";
import { FindByLink } from "./FindByLink";
import { Alert, Button, buttonClass, Dialog, Field, Input, PageHeader, Textarea, useConfirm } from "../../../../_components/kit";

/** How long typing rests before the list is asked again. */
const TYPING_MS = 350;

const STATUS_TONE: Record<ResellerUser["status"], string> = {
  active: "border-primary/20 bg-leaf-bg text-primary",
  suspended: "border-gold/20 bg-gold-bg text-gold",
  banned: "border-error-border bg-error-bg text-error",
};

/**
 * A reseller's users (F-311-v, `panel-web/contract.reseller-users.md`): the
 * list auth answers for the reseller the **path** names (F-311-a), newest
 * first, and a way into each one's services.
 *
 *  - **no permission is judged here.** `ResellerAccess` admits the owner, a
 *    seat with `user.read` / `user.write` or platform staff; anyone else gets its
 *    sentence;
 *  - **a search is 3 characters or none** (`usersQuery`) — fewer keep the
 *    unfiltered list, never a 400;
 *  - **no phone number is on the wire**, only `phoneMasked`;
 *  - **restrict and ban ask for the reason the person is shown** (ADR-0133,
 *    BAN-1-h); a lift is asked first. Restrict is the reseller block (F-311-a)
 *    and open to anyone the page admits; a ban needs `user.ban` and acts on
 *    the session's own tenant only (`canBanHere`). Every change signs the
 *    person out once. The row takes the user auth answers;
 *  - **a service is found by a pasted link, and the ticked ones acted on at
 *    once** (F-311-x, `FindByLink`), across every user of the reseller;
 *  - **or chosen by a filter** — a panel, a product, every active service —
 *    and run as a job the page watches (F-311-x1, `BulkByFilter`).
 */
export function ResellerUsersView({ id, own = false }: { id: string; own?: boolean }) {
  const { t, lang } = useLocale();
  const confirm = useConfirm();
  // The platform's own users (F-311-ab) have no console to go back to.
  const { me } = usePanelSession();
  const self = useWorkspaceSelf(id);
  const platform = isPlatformWorkspace(id, me);
  const message = useUserMessage();
  useOwnTenantRedirect(own, me?.tenant.id);

  // `?q=` opens the list already searched — the dashboard's users widget (UX-1-r).
  const searched = useSearchParams()?.get("q") ?? "";
  const [typed, setTyped] = useState(searched);
  const [query, setQuery] = useState(() => usersQuery(searched, 1));
  const [answer, setAnswer] = useState<{ items: ResellerUser[]; total: number } | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const [slug, setSlug] = useState<string | null>(null);
  const [blocking, setBlocking] = useState<string | null>(null);
  const [blockError, setBlockError] = useState<unknown>(null);
  // A restrict or a ban waiting for its reason.
  const [asking, setAsking] = useState<{ user: ResellerUser; action: "restrict" | "ban" } | null>(null);
  const [reason, setReason] = useState("");
  const canBan = canBanHere(id, me);

  const nameOf = (user: ResellerUser) => user.fullName || user.username || t("common", K.unnamed);

  async function apply(user: ResellerUser, action: StatusAction, why?: string) {
    setBlocking(user.id);
    setBlockError(null);
    try {
      const after: Partial<ResellerUser> & { id: string } =
        action === "restrict"
          ? await resellerUsersApi.block(id, user.id, why)
          : action === "lift"
            ? await resellerUsersApi.unblock(id, user.id)
            : await authApi.setUserStatus(user.id, action === "ban" ? "banned" : "active", why);
      setAnswer((before) => before && { ...before, items: before.items.map((u) => (u.id === after.id ? { ...u, ...after } : u)) });
      setAsking(null);
      setReason("");
    } catch (e) {
      setBlockError(e);
    } finally {
      setBlocking(null);
    }
  }

  async function act(user: ResellerUser, action: StatusAction) {
    if (blocking) return;
    if (action === "restrict" || action === "ban") {
      setReason("");
      setAsking({ user, action });
      return;
    }
    const sure = await confirm({
      title: t("common", action === "lift" ? K.unblockConfirm : K.unbanConfirm, { name: nameOf(user) }),
      confirmLabel: t("common", action === "lift" ? K.unblock : K.unban),
    });
    if (sure) await apply(user, action);
  }

  const ACTION_LABEL: Record<StatusAction, string> = { restrict: K.block, lift: K.unblock, ban: K.ban, unban: K.unban };
  const ACTION_ICON: Record<StatusAction, React.ReactNode> = {
    restrict: <ShieldAlert size={12} aria-hidden />,
    lift: <Undo2 size={12} aria-hidden />,
    ban: <Ban size={12} aria-hidden />,
    unban: <Undo2 size={12} aria-hidden />,
  };

  // Typing rests, then the list is asked from page 1.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery((before) => {
        const next = usersQuery(typed, 1);
        return next.q === before.q ? before : next;
      });
    }, TYPING_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  useEffect(() => {
    let alive = true;
    resellerUsersApi
      .list(id, { ...query, pageSize: USERS_PAGE_SIZE })
      .then((page) => {
        if (!alive) return;
        setAnswer({ items: page.items, total: page.total });
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
  }, [id, query, asked]);

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

  const retry = () => {
    setLoadError(null);
    setAsked((n) => n + 1);
  };
  const short = typed.trim().length > 0 && typed.trim().length < USERS_QUERY_MIN;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
      <PageHeader
        title={own || platform ? t("common", FrontendI18nKeys.common.shell.menu.users) : slug ? t("common", K.title, { slug }) : t("common", K.titlePlain)}
        subtitle={t("common", K.subtitle)}
        actions={
          <>
            <Button variant="quiet" size="sm" onClick={retry} icon={<RefreshCw size={12} aria-hidden />}>
            {t("common", K.refresh)}
          </Button>
          </>
        }
      />

      {/* F-117-g: platform staff's consent, request and emergency entry; nothing to anyone else. */}
      <PlatformAccessBanner tenantId={id} onChange={retry} />

      <div>
        <label className="relative block">
          <Search size={14} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-text-secondary" aria-hidden />
          <Input
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={t("common", K.search)}
            aria-label={t("common", K.search)}
            className="ps-9"
          />
        </label>
        {short && <p className="mt-1 text-xs text-text-secondary">{t("common", K.searchHint)}</p>}
      </div>

      <FindByLink id={id} own={own} />
      <BulkByFilter id={id} />
      <TenantGrantLimitCard tenantId={id} />
      {/* Read by whoever compensates, set by `grant.assign` (KS-1-c); for the owner and the platform the door decides. */}
      {(grantKeyHeld(me ?? null, id, "grant.compensate") || grantKeyHeld(me ?? null, id, "grant.assign")) && (
        <CompensationCapCard tenantId={id} canSet={grantKeyHeld(me ?? null, id, "grant.assign")} />
      )}

      {blockError !== null && <Alert tone="error">{message(blockError)}</Alert>}

      {consentRefusal(loadError) ? (
        <ConsentNeeded error={loadError} />
      ) : loadError !== null ? (
        <div className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-6">
          <Alert tone="error">{message(loadError)}</Alert>
          <Button variant="primary" size="sm" onClick={retry}>
            {t("common", K.reload)}
          </Button>
        </div>
      ) : answer === null ? (
        <TableSkeleton rows={5} columns={3} />
      ) : answer.items.length === 0 ? (
        <p className="rounded-2xl border border-card-border bg-card-bg p-6 text-sm text-text-secondary">
          {t("common", query.q ? K.emptySearch : K.empty)}
        </p>
      ) : (
        <>
          <ul className="divide-y divide-card-border overflow-hidden rounded-2xl border border-card-border bg-card-bg">
            {answer.items.map((user) => (
              <li key={user.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-text-primary">{user.fullName || t("common", K.unnamed)}</p>
                  <p className="flex flex-wrap gap-x-3 text-xs text-text-secondary">
                    {user.username && <span dir="ltr">@{user.username}</span>}
                    {user.phoneMasked && <span dir="ltr">{user.phoneMasked}</span>}
                    {user.statusReason && (
                      <span dir="auto" className="text-gold">
                        {user.statusReason}
                      </span>
                    )}
                    <span>
                      {t("common", K.columns.joined)}: {formatInstant(user.createdAt, lang, { withTime: false })}
                    </span>
                  </p>
                </div>
                <span className={`rounded-full border px-2 py-0.5 text-3xs font-medium ${STATUS_TONE[user.status]}`}>
                  {t("common", K.userStatus[user.status])}
                </span>
                {statusActionsOf(user.status, canBan).map((action) => (
                  <Button key={action} variant="quiet" size="sm" disabled={blocking !== null} onClick={() => void act(user, action)}>
                    {ACTION_ICON[action]}
                    {t("common", ACTION_LABEL[action])}
                  </Button>
                ))}
                <Link
                  href={userPagePath(id, user.id, own, self)}
                  className={buttonClass({ variant: "quiet", size: "sm" })}
                >
                  {t("common", K.open)}
                  <ArrowLeft size={12} className="ltr:rotate-180" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
          <Pagination
            page={query.page}
            totalPages={Math.max(1, Math.ceil(answer.total / USERS_PAGE_SIZE))}
            totalItems={answer.total}
            pageSize={USERS_PAGE_SIZE}
            onPageChange={(page) => setQuery((before) => ({ ...before, page }))}
          />
        </>
      )}

      <Dialog
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={asking ? t("common", asking.action === "ban" ? K.banConfirm : K.blockConfirm, { name: nameOf(asking.user) }) : ""}
        footer={
          <>
            <Button variant="quiet" onClick={() => setAsking(null)}>
              {t("common", FrontendI18nKeys.common.supportAgent.account.cancel)}
            </Button>
            <Button
              variant="danger"
              loading={blocking !== null}
              disabled={!reason.trim()}
              onClick={() => asking && void apply(asking.user, asking.action, reason.trim())}
            >
              {asking ? t("common", ACTION_LABEL[asking.action]) : ""}
            </Button>
          </>
        }
      >
        <Field label={t("common", K.reasonLabel)}>
          <Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Dialog>
    </div>
  );
}

