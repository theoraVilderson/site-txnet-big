"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogIn, UserRoundCog } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { authApi, type Me } from "@/lib/auth-api";
import { holdsPermission } from "@/lib/permissions";
import { PANEL_HOME } from "@/lib/routes";
import { Alert, Button, Dialog, Field, Textarea } from "./kit";

const K = FrontendI18nKeys.common.impersonation;

/** The reason the server asks, trimmed (identity invariant 7). */
const MIN_REASON = 10;

/**
 * Whether the button is offered (AC-1-i). The server's own `canAct` is the
 * authority rule impersonation asks (ADR-0103, AC-1-h): it is false for the
 * owner (ADR-0137), for yourself and for a peer holding as much. On top, the
 * key the route asks — `user.impersonate` on the caller's own tenant,
 * `platform.impersonate` on a reseller's user, whose consent the server checks
 * — and an active person, the only one a session can be started for. Never
 * the owner of any tenant (ADR-0137): a reseller's owner sits in the
 * platform's tenant, where `canAct` cannot see it.
 */
export function mayImpersonate(
  person: { canAct: boolean; status: string; ownsTenant?: boolean },
  me: Pick<Me, "permissions"> | null,
  reseller: boolean,
): boolean {
  if (!me || !person.canAct || person.ownsTenant || person.status !== "active") return false;
  return holdsPermission(me.permissions, reseller ? "platform.impersonate" : "user.impersonate");
}

/**
 * "Sign in as this user" and its dialog: a reason of at least 10 characters,
 * then the home page as that person. A refusal — no consent, no authority —
 * is the server's sentence, in the dialog.
 */
export function SignInAsUser({
  userId,
  name,
  tenantId,
  returnTo,
}: {
  userId: string;
  name: string;
  /** A reseller's user (F-117-e), or null for the caller's own tenant. */
  tenantId: string | null;
  returnTo: string;
}) {
  const { t } = useLocale();
  const router = useRouter();
  const message = useApiErrorMessage();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ready = reason.trim().length >= MIN_REASON && !busy;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await authApi.impersonate({ userId, name, reasonNote: reason.trim(), tenantId, returnTo });
      setOpen(false);
      router.push(PANEL_HOME);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const close = () => {
    if (busy) return;
    setOpen(false);
    setReason("");
    setError(null);
  };

  return (
    <>
      {/* A titled strip rather than a bare button: what it opens, for how long, and that it is recorded. */}
      <section className="flex flex-col gap-3 rounded-2xl border border-card-border bg-card-bg p-4 sm:flex-row sm:items-center sm:p-5">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-leaf-bg text-primary">
          <UserRoundCog size={20} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-text-primary">{t("common", K.start)}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">{t("common", K.hint)}</p>
        </div>
        <Button variant="secondary" className="sm:shrink-0" icon={<LogIn size={16} aria-hidden />} onClick={() => setOpen(true)}>
          {t("common", K.open)}
        </Button>
      </section>
      <Dialog
        open={open}
        onClose={close}
        title={t("common", K.dialogTitle, { name })}
        description={t("common", K.dialogBody, { name })}
        footer={
          <>
            <Button variant="quiet" onClick={close} disabled={busy}>
              {t("common", K.cancel)}
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void start()} disabled={!ready}>
              {t("common", K.confirm)}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {error !== null && <Alert tone="error">{message(error)}</Alert>}
          <Field label={t("common", K.reason)} hint={t("common", K.reasonHint)}>
            <Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
