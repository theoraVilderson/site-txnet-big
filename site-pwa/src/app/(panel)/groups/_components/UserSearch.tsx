"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, Plus, Search, Store } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { authApi, userGroupsApi, type UserSearchHit } from "@/lib/auth-api";
import type { Reseller } from "@/lib/tenant-api";
import { userQuery } from "../../resellers/_lib/resellers";
import { USER_GROUP_KEYS as K } from "../_lib/user-groups";
import { useMessage } from "./user-groups-ui";
import { Button, Input } from "../../_components/kit";

/** Wait for the typing to settle: both searches are rate-limited per caller. */
const DEBOUNCE_MS = 300;
/** Resellers shown for one query: the slug or the owner matches; a longer list means a sharper query. */
const RESELLER_HITS = 5;

/** The resellers a query names, by slug or by owner, from a list already read. */
export function resellerHits(resellers: readonly Reseller[], q: string): Reseller[] {
  const needle = q.toLowerCase();
  return resellers
    .filter((r) => [r.slug, r.owner?.fullName, r.owner?.username].some((v) => v?.toLowerCase().includes(needle)))
    .slice(0, RESELLER_HITS);
}

/**
 * Find a user to add (F-114-m) through the caller's own tenant's door — the
 * platform owner's `GET /auth/users`, or a reseller's list of its own users.
 * The group routes do not search; a caller with neither door types ids instead.
 *
 * On the platform's own group, `resellers` puts the resellers the same query
 * names in the same list, marked as such (GR-1-j): one box for everyone who
 * can join. `taken` marks who is in already or pending, so nobody is added
 * twice.
 */
export function UserSearch({
  via,
  tenantId,
  onAdd,
  busy,
  resellers,
  onAddReseller,
  taken,
  placeholder,
}: {
  via: "platform" | "reseller";
  tenantId: string;
  onAdd: (hit: UserSearchHit) => void;
  busy: boolean;
  resellers?: readonly Reseller[] | null;
  onAddReseller?: (r: Reseller) => void;
  /** `user:<id>` / `tenant:<id>` keys already in the group or pending. */
  taken?: ReadonlySet<string>;
  placeholder?: string;
}) {
  const { t } = useLocale();
  const message = useMessage();
  const [text, setText] = useState("");
  // The answer is kept with the query it answers, so a stale one is never shown.
  const [answer, setAnswer] = useState<{ q: string; hits: UserSearchHit[] | null; failure: string | null } | null>(null);
  const q = userQuery(text);
  const current = q && answer?.q === q ? answer : null;
  const hits = current?.hits ?? null;
  const shops = q && resellers && onAddReseller ? resellerHits(resellers, q) : [];
  const has = (key: string) => taken?.has(key) ?? false;

  useEffect(() => {
    if (!q) return;
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const users = via === "platform" ? (await authApi.searchUsers(q)).users : (await userGroupsApi.resellerUsers(tenantId, q)).items;
        if (live) setAnswer({ q, hits: users, failure: null });
      } catch (e) {
        if (live) setAnswer({ q, hits: null, failure: message(e) });
      }
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `message` is rebuilt every render; the query is what should re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, via, tenantId]);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute top-1/2 -translate-y-1/2 text-text-secondary start-3" aria-hidden />
        <Input className="ps-8" value={text} placeholder={placeholder ?? t("common", K.members.search)} onChange={(e) => setText(e.target.value)} />
      </div>
      {!q && <p className="text-xs text-text-secondary">{t("common", K.members.searchHint)}</p>}
      {q && !current && (
        <p className="flex items-center gap-1.5 text-xs text-text-secondary">
          <Loader2 size={12} className="animate-spin" aria-hidden />
          {t("common", K.members.searching)}
        </p>
      )}
      {current?.failure && <p className="text-xs text-error">{current.failure}</p>}
      {hits && hits.length === 0 && shops.length === 0 && <p className="text-xs text-text-secondary">{t("common", K.members.noMatch)}</p>}
      {((hits && hits.length > 0) || shops.length > 0) && (
        <ul className="flex flex-col divide-y divide-card-border overflow-hidden rounded-xl border border-card-border">
          {shops.map((r) => (
            <li key={`tenant:${r.id}`} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="flex min-w-0 items-center gap-2">
                <Store size={14} className="shrink-0 text-text-secondary" aria-hidden />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-bold text-text-primary" dir="ltr">
                    {r.slug}
                  </span>
                  <span className="truncate text-xs text-text-secondary">
                    {t("common", K.members.reseller)}
                    {r.owner?.fullName ? ` · ${r.owner.fullName}` : ""}
                  </span>
                </span>
              </span>
              <AddButton done={has(`tenant:${r.id}`)} busy={busy} onClick={() => onAddReseller?.(r)} />
            </li>
          ))}
          {(hits ?? []).map((hit) => (
            <li key={hit.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-bold text-text-primary">{hit.fullName}</span>
                <span className="truncate text-xs text-text-secondary" dir="ltr">
                  {[hit.username && `@${hit.username}`, hit.phoneMasked].filter(Boolean).join(" · ")}
                </span>
              </span>
              <AddButton done={has(`user:${hit.id}`)} busy={busy} onClick={() => onAdd(hit)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Add, or a tick when they are in already or pending. */
function AddButton({ done, busy, onClick }: { done: boolean; busy: boolean; onClick: () => void }) {
  const { t } = useLocale();
  if (done) return <Check size={14} className="shrink-0 text-primary" aria-label={t("common", K.members.addedShort)} />;
  return (
    <Button variant="quiet" size="sm" disabled={busy} onClick={onClick} icon={<Plus size={12} aria-hidden />}>
      {t("common", K.members.add)}
    </Button>
  );
}
