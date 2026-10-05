"use client";

import { useEffect, useState } from "react";
import { authApi, NOTICE_MESSENGERS, type MeMessenger, type NoticeMessenger } from "@/lib/auth-api";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { Alert } from "../../_components/kit/Alert";
import { Card, CardHeader } from "../../_components/kit/Card";
import { RadioCards } from "../../_components/kit/choice";
import { notify } from "../../_components/kit/notify";

const M = FrontendI18nKeys.common.settings.messenger;

/** Each choice's words — exhaustive, so a messenger added to the list without them does not compile. */
const OPTION_TEXT: Record<NoticeMessenger, string> = {
  both: M.options.both,
  telegram: M.options.telegram,
  bale: M.options.bale,
};

/**
 * Which messenger the user's notices take (F-601-u, over identity's
 * `/auth/me/messenger`): Telegram, Bale or both. Unchosen reads as both,
 * the server's default, so the form opens on it. A platform with no verified
 * chat can still be picked, and says so: until it is linked, the notifier
 * tells the other one — the server's rule, stated here, not enforced here.
 *
 * One choice, so it is written the moment it is picked (UX-1-s, K10): "saved"
 * is a toast; a refusal puts the stored choice back and says why in a toast.
 */
export function MessengerSection() {
  const { t } = useLocale();
  const toMessage = useApiErrorMessage();
  const [state, setState] = useState<MeMessenger | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let live = true;
    authApi
      .messenger()
      .then((m) => live && setState(m))
      .catch(() => live && setLoadFailed(true));
    return () => {
      live = false;
    };
  }, []);

  if (loadFailed) {
    return (
      <Card padding="lg">
        <Alert tone="error">{t("common", M.loadFailed)}</Alert>
      </Card>
    );
  }
  if (!state) return null;

  const pick = async (messenger: NoticeMessenger) => {
    if (pending || messenger === state.messenger) return;
    const before = state;
    setState({ ...state, messenger });
    setPending(true);
    try {
      setState(await authApi.saveMessenger(messenger));
      notify.success(t("common", M.saved));
    } catch (e) {
      setState(before);
      notify.error(toMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Card padding="lg">
      <CardHeader title={t("common", M.title)} subtitle={t("common", M.subtitle)} />
      <RadioCards<NoticeMessenger>
        ariaLabel={t("common", M.title)}
        columns={1}
        value={state.messenger}
        onChange={(v) => void pick(v)}
        options={NOTICE_MESSENGERS.map((option) => ({
          value: option,
          label: t("common", OPTION_TEXT[option]),
          description: option !== "both" && !state.linked.includes(option) ? t("common", M.notLinked) : undefined,
          disabled: pending && option !== state.messenger,
        }))}
      />
    </Card>
  );
}
