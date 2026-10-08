"use client";

import { useEffect, useId, useState } from "react";
import { Ban, ShieldAlert, ShieldCheck } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { authApi, type AccountStatus, type UserStatusView } from "@/lib/auth-api";
import { holdsPermission } from "@/lib/permissions";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { Button } from "../../_components/kit/Button";
import { Textarea } from "../../_components/kit/Field";
import { useConfirm } from "../../_components/kit/confirm";
import { notify } from "../../_components/kit/notify";

const A = FrontendI18nKeys.common.supportAgent.account;

const STATUS_LABEL: Record<AccountStatus, string> = { active: A.active, suspended: A.suspended, banned: A.banned };

/**
 * Restrict, ban and lift the person in this conversation (BAN-1-f, ADR-0133),
 * over `PUT /api/auth/users/:id/status`.
 *
 * Each act is offered by the caller's own key — `restriction.assign` to
 * restrict and lift a restriction, `user.ban` for everything about a ban — so
 * nothing is drawn that the server would refuse. A block asks for the reason
 * the person reads on their restricted screen or at sign-in; a lift asks only
 * to be sure, because it signs the person out once.
 */
export function UserStatusControl({ userId }: { userId: string }) {
  const { t } = useLocale();
  const { me } = usePanelSession();
  const confirm = useConfirm();
  const toMessage = useApiErrorMessage();
  const reasonId = useId();
  const canRestrict = holdsPermission(me?.permissions, "restriction.assign");
  const canBan = holdsPermission(me?.permissions, "user.ban");

  const [view, setView] = useState<UserStatusView | null>(null);
  const [choosing, setChoosing] = useState<"suspended" | "banned" | null>(null);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canRestrict && !canBan) return;
    let alive = true;
    authApi
      .userStatus(userId)
      .then((v) => alive && setView(v))
      // Refused (an admin, the owner, someone above the caller): nothing to offer.
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [userId, canRestrict, canBan]);

  if ((!canRestrict && !canBan) || !view) return null;

  const save = async (status: AccountStatus, why?: string) => {
    setPending(true);
    setError(null);
    try {
      setView(await authApi.setUserStatus(userId, status, why));
      setChoosing(null);
      setReason("");
      notify.success(t("common", A.done));
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setPending(false);
    }
  };

  const lift = async () => {
    if (await confirm({ title: t("common", A.title), body: t("common", A.liftConfirm), confirmLabel: t("common", A.confirm) })) {
      await save("active");
    }
  };

  const offers: { label: string; icon: React.ReactNode; run: () => void; danger?: boolean }[] = [];
  if (view.status === "active" && canRestrict) offers.push({ label: A.restrict, icon: <ShieldAlert size={14} />, run: () => setChoosing("suspended") });
  if (view.status === "suspended" && canRestrict) offers.push({ label: A.lift, icon: <ShieldCheck size={14} />, run: lift });
  if (view.status !== "banned" && canBan) offers.push({ label: A.ban, icon: <Ban size={14} />, run: () => setChoosing("banned"), danger: true });
  if (view.status === "banned" && canBan) offers.push({ label: A.unban, icon: <ShieldCheck size={14} />, run: lift });

  return (
    <section className="space-y-2 border-t border-card-border pt-3">
      <h3 className="font-bold text-text-primary">{t("common", A.title)}</h3>
      <p className={view.status === "active" ? "text-text-secondary" : "font-bold text-error"}>{t("common", STATUS_LABEL[view.status])}</p>
      {view.statusReason && (
        <p className="text-text-secondary">
          {t("common", A.reason)}: <span dir="auto" className="text-text-primary">{view.statusReason}</span>
        </p>
      )}

      {choosing ? (
        <div className="space-y-2">
          <p className="text-text-secondary">{t("common", choosing === "banned" ? A.banHint : A.restrictHint)}</p>
          <label htmlFor={reasonId} className="block font-bold text-text-primary">
            {t("common", A.reasonLabel)}
          </label>
          <Textarea id={reasonId} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="danger"
              loading={pending}
              disabled={!reason.trim()}
              onClick={() => save(choosing, reason.trim())}
            >
              {t("common", A.confirm)}
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setChoosing(null)}>
              {t("common", A.cancel)}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {offers.map((o) => (
            <Button key={o.label} size="sm" variant={o.danger ? "danger" : "secondary"} icon={o.icon} loading={pending} onClick={o.run}>
              {t("common", o.label)}
            </Button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
    </section>
  );
}
