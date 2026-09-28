"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, RefreshCw, Search } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { authApi, resellerUsersApi, type ResellerUser } from "@/lib/auth-api";
import { myResellerConsolePath, myResellerUserPath } from "@/lib/routes";
import { Pagination } from "../../../../_components/kit/Pagination";
import { TableSkeleton } from "../../../../_components/kit/TableSkeleton";
import { formatInstant } from "../../../../_lib/datetime";
import { Alert, input, primaryButton, quietButton } from "../../../../catalog/_components/catalog-ui";
import { USERS_PAGE_SIZE, USERS_QUERY_MIN, USER_KEYS as K, usersQuery } from "../../../_lib/users";
import { useUserMessage } from "../[userId]/_components/useUserMessage";

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
 *    seat with `tenant.manage` or platform staff; anyone else gets its
 *    sentence;
 *  - **a search is 3 characters or none** (`usersQuery`) — fewer keep the
 *    unfiltered list, never a 400;
 *  - **no phone number is on the wire**, only `phoneMasked`; block is not
 *    offered here.
 */
export function ResellerUsersView({ id }: { id: string }) {
  const { t, lang } = useLocale();
  const message = useUserMessage();

  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState(() => usersQuery("", 1));
  const [answer, setAnswer] = useState<{ items: ResellerUser[]; total: number } | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const [slug, setSlug] = useState<string | null>(null);

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
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <Link href={myResellerConsolePath(id)} className={`${quietButton} mb-2 -ms-2`}>
            <ArrowRight size={12} className="ltr:rotate-180" aria-hidden />
            {t("common", K.backToConsole)}
          </Link>
          <h1 className="text-2xl font-bold text-text-primary md:text-3xl">
            {slug ? t("common", K.title, { slug }) : t("common", K.titlePlain)}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">{t("common", K.subtitle)}</p>
        </div>
        <button type="button" className={quietButton} onClick={retry}>
          <RefreshCw size={12} aria-hidden />
          {t("common", K.refresh)}
        </button>
      </header>

      <div>
        <label className="relative block">
          <Search size={14} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-text-secondary" aria-hidden />
          <input
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={t("common", K.search)}
            aria-label={t("common", K.search)}
            className={`${input} ps-9`}
          />
        </label>
        {short && <p className="mt-1 text-xs text-text-secondary">{t("common", K.searchHint)}</p>}
      </div>

      {loadError !== null ? (
        <div className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-6">
          <Alert>{message(loadError)}</Alert>
          <button type="button" className={primaryButton} onClick={retry}>
            {t("common", K.reload)}
          </button>
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
                    <span>
                      {t("common", K.columns.joined)}: {formatInstant(user.createdAt, lang, { withTime: false })}
                    </span>
                  </p>
                </div>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_TONE[user.status]}`}>
                  {t("common", K.userStatus[user.status])}
                </span>
                <Link
                  href={`${myResellerUserPath(id, user.id)}?${new URLSearchParams({ name: user.fullName })}`}
                  className={quietButton}
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
    </div>
  );
}
