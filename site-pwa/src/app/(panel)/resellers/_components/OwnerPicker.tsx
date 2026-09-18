"use client";

import { useEffect, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { authApi, type UserSearchHit } from "@/lib/auth-api";
import { RESELLER_KEYS as K, ownerSelectable, userQuery } from "../_lib/resellers";
import { input, quietButton, useMessage } from "./resellers-ui";

/** Wait for the typing to settle: the search is rate-limited per caller (F-018-ad). */
const DEBOUNCE_MS = 300;

/**
 * The create sheet's owner field (F-018-ae): search the platform's users by
 * phone, username or email and pick one. What is sent stays `ownerUserId`; a
 * user who is not active is shown but cannot be picked (`owner_inactive`).
 */
export function OwnerPicker({ picked, onPick }: { picked: UserSearchHit | null; onPick: (hit: UserSearchHit | null) => void }) {
  const { t } = useLocale();
  const message = useMessage();
  const [text, setText] = useState("");
  // The answer is kept with the query it answers, so a stale one is never shown
  // and nothing has to be cleared when the text changes.
  const [answer, setAnswer] = useState<{ q: string; hits: UserSearchHit[] | null; failure: string | null } | null>(null);
  const q = userQuery(text);
  const current = q && answer?.q === q ? answer : null;
  const hits = current?.hits ?? null;
  const failure = current?.failure ?? null;
  const busy = !!q && !picked && !current;

  useEffect(() => {
    if (!q || picked) return;
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const { users } = await authApi.searchUsers(q);
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
  }, [q, picked]);

  if (picked) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-primary/30 bg-bg-inner px-3 py-2">
        <HitLine hit={picked} />
        <button type="button" className={quietButton} onClick={() => onPick(null)}>
          {t("common", K.create.ownerChange)}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute top-1/2 -translate-y-1/2 text-text-secondary start-3" aria-hidden />
        <input
          className={`${input} ps-8`}
          value={text}
          placeholder={t("common", K.create.ownerSearch)}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {!q && <p className="text-xs text-text-secondary">{t("common", K.create.ownerSearchHint)}</p>}
      {busy && (
        <p className="flex items-center gap-1.5 text-xs text-text-secondary">
          <Loader2 size={12} className="animate-spin" aria-hidden />
          {t("common", K.create.ownerSearching)}
        </p>
      )}
      {failure && <p className="text-xs text-error">{failure}</p>}
      {hits && hits.length === 0 && <p className="text-xs text-text-secondary">{t("common", K.create.ownerNoMatch)}</p>}
      {hits && hits.length > 0 && (
        <ul className="flex flex-col divide-y divide-card-border overflow-hidden rounded-xl border border-card-border">
          {hits.map((hit) => {
            const selectable = ownerSelectable(hit);
            return (
              <li key={hit.id}>
                <button
                  type="button"
                  disabled={!selectable}
                  onClick={() => onPick(hit)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-start hover:bg-[var(--leaf-bg)] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                >
                  <HitLine hit={hit} />
                  {!selectable && <span className="shrink-0 text-xs text-error">{t("common", K.create.ownerUnavailable)}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function HitLine({ hit }: { hit: UserSearchHit }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate text-sm font-bold text-text-primary">{hit.fullName}</span>
      <span className="truncate text-xs text-text-secondary" dir="ltr">
        {[hit.username && `@${hit.username}`, hit.phoneMasked].filter(Boolean).join(" · ")}
      </span>
    </span>
  );
}
