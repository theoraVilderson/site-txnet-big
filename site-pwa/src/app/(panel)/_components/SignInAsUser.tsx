"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UserRoundCog } from "lucide-react";
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
 * — and an active person, the only one a session can be started for.
 */
export function mayImpersonate(
  person: { canAct: boolean; status: string },
  me: Pick<Me, "permissions"> | null,
  reseller: boolean,
): boolean {
  if (!me || !person.canAct || person.status !== "active") return false;
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
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <UserRoundCog size={16} aria-hidden />
        {t("common", K.start)}
      </Button>
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
            <Button variant="primary" onClick={() => void start()} disabled={!ready}>
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
