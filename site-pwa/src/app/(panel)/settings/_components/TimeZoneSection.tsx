"use client";

import { useEffect, useState } from "react";
import { authApi, type MeTimeZone } from "@/lib/auth-api";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { browserZone } from "@/lib/time-zone";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { ZoneSelect } from "../../_components/ZoneSelect";
import { Alert } from "../../_components/kit/Alert";
import { Button } from "../../_components/kit/Button";
import { Card, CardHeader } from "../../_components/kit/Card";
import { Field } from "../../_components/kit/Field";
import { SaveBar } from "../../_components/kit/SaveBar";

const Z = FrontendI18nKeys.common.timeZone;

/**
 * The user's own time zone (TZ-1-e, ADR-0108 point 7; auth-api
 * `contract.time-zone.md`). A pick is `source: user`. "Automatic" clears the
 * pick and lets this browser report again — two calls, because a browser
 * report is never stored over a pick. What reads as "now in use" is the
 * server's resolved answer, never inferred from the field, and the panel's
 * dates follow it at once (`zoneChanged`). Saved through the `SaveBar`
 * (UX-1-s, K11); Discard goes back to the stored pick.
 */
export function TimeZoneSection() {
  const { t } = useLocale();
  const toMessage = useApiErrorMessage();
  const { zoneChanged } = usePanelSession();
  const [stored, setStored] = useState<MeTimeZone | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [asked, setAsked] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const device = browserZone();

  useEffect(() => {
    let live = true;
    authApi
      .timeZone()
      .then((z) => {
        if (!live) return;
        setStored(z);
        setPicked(z.source === "user" ? z.timezone : null);
      })
      .catch(() => live && setLoadFailed(true));
    return () => {
      live = false;
    };
  }, [asked]);

  const save = async () => {
    setError(null);
    try {
      let answer = await authApi.saveTimeZone(picked, "user");
      if (picked === null && device) answer = await authApi.saveTimeZone(device, "browser");
      setStored(answer);
      setPicked(answer.source === "user" ? answer.timezone : null);
      zoneChanged(answer.resolved);
    } catch (e) {
      setError(toMessage(e));
      throw e;
    }
  };

  const chosen = stored?.source === "user" ? stored.timezone : null;

  return (
    <Card padding="lg">
      <CardHeader title={t("common", Z.title)} subtitle={t("common", Z.hint)} />

      {loadFailed ? (
        <Alert
          tone="error"
          action={
            <Button variant="secondary" size="sm" onClick={() => {
                setLoadFailed(false);
                setAsked((n) => n + 1);
              }}>
              {t("common", Z.reload)}
            </Button>
          }
        >
          {t("common", Z.loadFailed)}
        </Alert>
      ) : stored === null ? null : (
        <div className="space-y-3">
          <Field
            id="my-zone"
            label={t("common", Z.label)}
            hint={t("common", Z.inUse, { zone: stored.resolved.zone, from: t("common", Z.from[stored.resolved.from]) })}
            error={error ?? undefined}
          >
            <ZoneSelect
              value={picked}
              nullLabel={device ? t("common", Z.automatic, { zone: device }) : t("common", Z.automaticUnknown)}
              onChange={(zone) => {
                setPicked(zone);
                setError(null);
              }}
            />
          </Field>
          <SaveBar
            dirty={picked !== chosen}
            onSave={save}
            onDiscard={() => {
              setPicked(chosen);
              setError(null);
            }}
            savedMessage={t("common", Z.saved)}
          />
        </div>
      )}
    </Card>
  );
}
