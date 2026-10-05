"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Bot, Monitor } from "lucide-react";
import { authApi, type ActiveSession } from "@/lib/auth-api";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { formatInstant } from "../../_lib/datetime";
import { describeDevice, onSessionsChanged } from "../_lib/sessions";
import { Alert } from "../../_components/kit/Alert";
import { Button } from "../../_components/kit/Button";
import { Card, CardHeader } from "../../_components/kit/Card";
import { notify } from "../../_components/kit/notify";

const S = FrontendI18nKeys.common.sessions;

/** Which confirm is open: one place by id, or every other place. */
type Ending = { kind: "one"; session: ActiveSession } | { kind: "others" };

/**
 * The account's active sessions, Telegram-style (SES-1-b over auth-api
 * `contract.sessions.md`): every browser and bot chat signed in right now,
 * this device first, and ending any of the others — or all of them at once.
 *
 * Ending a place is more than a sign-out there (SES-1-a): the account also
 * leaves that place's switcher, and a bot is disconnected from it. The confirm
 * says so, because a person who ends their own Telegram stops getting notices
 * there until they sign in to the bot again.
 *
 * This device has no button: leaving it is the panel's ordinary sign-out.
 */
export function SessionsSection() {
  const { t, lang } = useLocale();
  const toMessage = useApiErrorMessage();
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [asked, setAsked] = useState(0);
  const [ending, setEnding] = useState<Ending | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    authApi
      .activeSessions()
      .then((answer) => {
        if (!live) return;
        setSessions(answer.sessions);
        setLoadFailed(false);
      })
      .catch(() => live && setLoadFailed(true));
    return () => {
      live = false;
    };
  }, [asked]);

  // Another card ended places (a password change): re-read, as after an end here.
  useEffect(() => onSessionsChanged(() => setAsked((n) => n + 1)), []);

  const end = async () => {
    if (!ending) return;
    setPending(true);
    setError(null);
    try {
      if (ending.kind === "one") {
        await authApi.terminateSession(ending.session.id);
        notify.success(t("common", S.ended));
      } else {
        const answer = await authApi.terminateOtherSessions();
        notify.success(t("common", S.endedOthers, { count: answer.terminated }));
      }
      setEnding(null);
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setPending(false);
      // Re-read either way: a refused end is usually a list one rotation old.
      setAsked((n) => n + 1);
    }
  };

  const others = sessions?.filter((s) => !s.current) ?? [];

  const name = (s: ActiveSession) => {
    if (s.surface !== "web") return t("common", S.surface[s.surface]);
    const device = describeDevice(s.userAgent);
    return device ? t("common", S.device, device) : t("common", S.unknownDevice);
  };

  const confirm = (
    <div className="space-y-3 rounded-2xl border border-error/20 bg-bg-inner p-4">
      <h3 className="flex items-center gap-2 text-sm font-bold text-text-primary">
        <AlertTriangle size={16} className="shrink-0 text-error" aria-hidden />
        {t("common", ending?.kind === "others" ? S.confirm.othersTitle : S.confirm.title)}
      </h3>
      <p className="text-sm text-text-primary">
        {t("common", ending?.kind === "others" ? S.confirm.othersBody : S.confirm.body)}
      </p>
      {ending?.kind === "one" && ending.session.surface !== "web" && (
        <p className="text-sm font-bold text-text-primary">{t("common", S.confirm.bot)}</p>
      )}
      <div className="flex gap-2">
        <Button variant="danger" size="sm" loading={pending} onClick={end}>
          {t("common", S.confirm.yes)}
        </Button>
        <Button variant="secondary" size="sm" disabled={pending} onClick={() => setEnding(null)}>
          {t("common", S.confirm.no)}
        </Button>
      </div>
    </div>
  );

  return (
    <Card padding="lg">
      <CardHeader title={t("common", S.title)} subtitle={t("common", S.hint)} />

      {loadFailed ? (
        <Alert
          tone="error"
          action={
            <Button variant="secondary" size="sm" onClick={() => setAsked((n) => n + 1)}>
              {t("common", S.reload)}
            </Button>
          }
        >
          {t("common", S.loadFailed)}
        </Alert>
      ) : sessions === null ? null : (
        <div className="space-y-3">
          <ul className="divide-y divide-card-border">
            {sessions.map((s) => (
              <li key={s.id} className="py-3">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 shrink-0 text-text-secondary" aria-hidden>
                    {s.surface === "web" ? <Monitor size={18} /> : <Bot size={18} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-text-primary" dir="auto">
                      {name(s)}
                    </p>
                    <p className="text-xs text-text-secondary" dir="auto">
                      {s.current ? (
                        <span className="font-bold text-primary">{t("common", S.thisDevice)}</span>
                      ) : (
                        t("common", S.lastActive, { when: formatInstant(s.lastActiveAt, lang) ?? "" })
                      )}
                      {s.ipAddress && <span dir="ltr"> · {s.ipAddress}</span>}
                    </p>
                  </div>
                  {!s.current && (
                    <Button
                      variant="quiet"
                      size="sm"
                      className="shrink-0 text-error"
                      disabled={pending || ending !== null}
                      onClick={() => {
                        setError(null);
                        setEnding({ kind: "one", session: s });
                      }}
                    >
                      {t("common", S.terminate)}
                    </Button>
                  )}
                </div>
                {ending?.kind === "one" && ending.session.id === s.id && <div className="mt-3">{confirm}</div>}
              </li>
            ))}
          </ul>

          {others.length === 0 && <p className="text-sm text-text-secondary">{t("common", S.none)}</p>}
          {error && <Alert tone="error">{error}</Alert>}

          {others.length > 1 &&
            (ending?.kind === "others" ? (
              confirm
            ) : (
              <Button
                variant="secondary"
                disabled={pending || ending !== null}
                onClick={() => {
                  setError(null);
                  setEnding({ kind: "others" });
                }}
              >
                {t("common", S.terminateOthers)}
              </Button>
            ))}
        </div>
      )}
    </Card>
  );
}
