"use client";

import { useState } from "react";
import { Snowflake } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ApiError } from "@/lib/api-error";
import { billingApi, type GrantRow } from "@/lib/billing-api";
import { formatInstant } from "../../_lib/datetime";
import { Button, useConfirm } from "../../_components/kit";
import { useDailyLimit } from "../_hooks/useDailyLimit";
import { freezeLimitOf, ownFreezeOf } from "../_lib/own-freeze";
import { RefusalNote } from "./RefusalNote";

const F = FrontendI18nKeys.common.myServices.freeze;

/** Who froze it, in the user's words; a hard freeze, or one only support may lift, is support's. */
const BY_KEY = { self: F.bySelf, soft: F.bySoft, support: F.byHard } as const;

type Row = Pick<GrantRow, "id" | "status" | "billingMode" | "frozen" | "frozenUntil" | "freezeMode" | "userMayUnfreeze">;

/**
 * The user's own freeze and unfreeze of one service (F-0401-e over F-0401-c),
 * each asked first. **Nothing is patched from the answer:** billing writes
 * `entitlement.grant.freeze_changed` in the act's transaction and the page
 * re-reads on it (C-14), so the button waits — busy — until the row it was
 * pressed on has moved.
 */
function useOwnFreeze(row: Row) {
  const { t } = useLocale();
  const toMessage = useApiErrorMessage();
  const confirm = useConfirm();
  const [sentAt, setSentAt] = useState<boolean | null>(null);
  const [error, setError] = useState<{ message: string; ref?: string } | null>(null);
  const [limited, setLimited] = useDailyLimit();
  const [busy, setBusy] = useState(false);
  // The row moved since the press: what was sent is done.
  if (sentAt !== null && sentAt !== row.frozen) setSentAt(null);

  async function act(kind: "freeze" | "unfreeze") {
    const ask = kind === "freeze" ? F.confirmFreeze : F.confirmUnfreeze;
    if (busy || !(await confirm({ title: t("common", ask.title), body: t("common", ask.body), confirmLabel: t("common", kind === "freeze" ? F.freeze : F.unfreeze) }))) return;
    setBusy(true);
    setError(null);
    try {
      await (kind === "freeze" ? billingApi.freezeOwnGrant(row.id) : billingApi.unfreezeOwnGrant(row.id));
      setSentAt(row.frozen);
    } catch (e) {
      // Refused whole: nothing changed. The daily cap names when the next is allowed.
      const cap = freezeLimitOf(e);
      if (cap) setLimited(cap);
      else setError({ message: toMessage(e), ref: e instanceof ApiError ? e.ref : undefined });
    } finally {
      setBusy(false);
    }
  }

  return { act, waiting: busy || sentAt === row.frozen, error, limited };
}

/** A frozen service, on its card: who froze it, until when, and the unfreeze where the user may. */
export function FrozenNote({ row }: { row: Row }) {
  const { t, lang } = useLocale();
  const own = useOwnFreeze(row);
  const offer = ownFreezeOf(row);
  if (!row.frozen || offer === null || offer === "freeze") return null;

  return (
    <section aria-label={t("common", F.title)} className="rounded-2xl border border-gold/20 bg-gold-bg px-3 py-2 text-xs text-gold">
      <div className="flex items-center gap-2">
        <Snowflake size={16} className="shrink-0" aria-hidden />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="font-bold">{t("common", BY_KEY[offer === "support" ? "support" : row.freezeMode === "self" ? "self" : "soft"])}</p>
          {row.frozenUntil && <p>{t("common", F.until, { at: formatInstant(row.frozenUntil, lang) ?? row.frozenUntil })}</p>}
        </div>
        {offer === "unfreeze" && (
          <Button variant="primary" size="sm" loading={own.waiting} onClick={() => void own.act("unfreeze")}>
            {t("common", F.unfreeze)}
          </Button>
        )}
      </div>
      {own.error && <RefusalNote error={own.error} className="mt-3" />}
    </section>
  );
}

/** "Freeze this service", under manage: it switches every config off, so it is never above a working setup. */
export function FreezeOwn({ row }: { row: Row }) {
  const { t, lang } = useLocale();
  const own = useOwnFreeze(row);
  if (ownFreezeOf(row) !== "freeze") return null;

  return (
    <section aria-label={t("common", F.title)} className="rounded-2xl border border-card-border p-3">
      <p className="text-sm font-bold text-text-primary">{t("common", F.title)}</p>
      <p className="mt-1 text-xs leading-5 text-text-secondary">{t("common", F.hint)}</p>
      <Button
        size="sm"
        className="mt-3"
        icon={<Snowflake size={14} aria-hidden />}
        loading={own.waiting}
        disabled={own.limited !== null}
        onClick={() => void own.act("freeze")}
      >
        {t("common", F.freeze)}
      </Button>
      {own.limited && (
        <p role="alert" className="mt-3 rounded-2xl border border-error-border bg-error-bg px-3 py-2 text-xs font-medium text-error">
          {t("common", F.limited, { limit: own.limited.limit, at: formatInstant(own.limited.nextAt, lang) ?? own.limited.nextAt })}
        </p>
      )}
      {own.error && <RefusalNote error={own.error} className="mt-3" />}
    </section>
  );
}
