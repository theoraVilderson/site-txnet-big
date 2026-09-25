"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, Search } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { authApi, userGroupsApi, type UserSearchHit } from "@/lib/auth-api";
import { userQuery } from "../../resellers/_lib/resellers";
import { USER_GROUP_KEYS as K } from "../_lib/user-groups";
import { input, quietButton, useMessage } from "./user-groups-ui";

/** Wait for the typing to settle: both searches are rate-limited per caller. */
const DEBOUNCE_MS = 300;

/**
 * Find a user to add (F-114-m) through the caller's own tenant's door — the
 * platform owner's `GET /auth/users`, or a reseller's list of its own users.
 * The group routes do not search; a caller with neither door types ids instead.
 */
export function UserSearch({ via, tenantId, onAdd, busy }: { via: "platform" | "reseller"; tenantId: string; onAdd: (hit: UserSearchHit) => void; busy: boolean }) {
  const { t } = useLocale();
  const message = useMessage();
  const [text, setText] = useState("");
  // The answer is kept with the query it answers, so a stale one is never shown.
  const [answer, setAnswer] = useState<{ q: string; hits: UserSearchHit[] | null; failure: string | null } | null>(null);
  const q = userQuery(text);
  const current = q && answer?.q === q ? answer : null;
  const hits = current?.hits ?? null;

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
        <input className={`${input} ps-8`} value={text} placeholder={t("common", K.members.search)} onChange={(e) => setText(e.target.value)} />
      </div>
      {!q && <p className="text-xs text-text-secondary">{t("common", K.members.searchHint)}</p>}
      {q && !current && (
        <p className="flex items-center gap-1.5 text-xs text-text-secondary">
          <Loader2 size={12} className="animate-spin" aria-hidden />
          {t("common", K.members.searching)}
        </p>
      )}
      {current?.failure && <p className="text-xs text-error">{current.failure}</p>}
      {hits && hits.length === 0 && <p className="text-xs text-text-secondary">{t("common", K.members.noMatch)}</p>}
      {hits && hits.length > 0 && (
        <ul className="flex flex-col divide-y divide-card-border overflow-hidden rounded-xl border border-card-border">
          {hits.map((hit) => (
            <li key={hit.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-bold text-text-primary">{hit.fullName}</span>
                <span className="truncate text-xs text-text-secondary" dir="ltr">
                  {[hit.username && `@${hit.username}`, hit.phoneMasked].filter(Boolean).join(" · ")}
                </span>
              </span>
              <button type="button" className={quietButton} disabled={busy} onClick={() => onAdd(hit)}>
                <Plus size={12} aria-hidden />
                {t("common", K.members.add)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
