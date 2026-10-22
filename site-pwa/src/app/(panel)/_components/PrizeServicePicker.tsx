"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ApiError } from "@/lib/api-error";
import { rewardTargetApi, type PrizeService, type RewardTarget } from "@/lib/billing/reward-target";
import { useCatalogTexts } from "../catalog/_lib/meter-names";
import { serviceName } from "../services/_lib/my-services";
import { Card, CardHeader, Select } from "./kit";
import { notify } from "./kit/notify";

const K = FrontendI18nKeys.common.prizeService;
const UNNAMED = FrontendI18nKeys.common.myServices.unnamed;
/** Billing's `RewardTargetRejection`, each with its sentence. */
const REFUSAL_KEYS: Record<string, string> = K.refusals;
/** The select's value for `null`; never a Grant id, which is a uuid. */
const AUTOMATIC = "automatic";

/**
 * The user's prize service (F-707-s, billing F-707-r) on the wheel and the
 * lotteries pages: which service GB and days won there are added to. One saved
 * choice for both, so an automatic lottery — which has no step to ask in —
 * follows it too.
 *
 * Shown only when there are two services or more a prize can reach. The page
 * keeps no choice of its own: it draws billing's answer, so a refused choice
 * leaves billing's in place.
 */
export function PrizeServicePicker() {
  const { t } = useLocale();
  const texts = useCatalogTexts();
  const errorMessage = useApiErrorMessage();
  const [target, setTarget] = useState<RewardTarget | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    rewardTargetApi
      .view()
      .then((v) => alive && setTarget(v))
      // An extra on its page: a failed read hides the picker and the page stands, as when there is nothing to choose.
      .catch(() => alive && setTarget(null));
    return () => {
      alive = false;
    };
  }, []);

  if (!target || target.services.length < 2) return null;

  /** As My services names it; a service only one kind of prize reaches says which. */
  const nameOf = (s: PrizeService) => {
    const name = s.label ?? serviceName(texts, s) ?? t("common", UNNAMED);
    if (!s.takesTraffic) return t("common", K.daysOnly, { name });
    if (!s.takesDays) return t("common", K.trafficOnly, { name });
    return name;
  };
  const options = [{ value: AUTOMATIC, label: t("common", K.automatic) }, ...target.services.map((s) => ({ value: s.id, label: nameOf(s) }))];

  async function choose(value: string) {
    const grantId = value === AUTOMATIC ? null : value;
    if (!target || grantId === target.chosenGrantId) return;
    setSaving(true);
    try {
      setTarget(await rewardTargetApi.choose(grantId));
      notify.success(t("common", K.saved));
    } catch (e) {
      const reason = e instanceof ApiError ? e.reason : undefined;
      notify.error(reason && reason in REFUSAL_KEYS ? t("common", REFUSAL_KEYS[reason]) : errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader title={t("common", K.title)} subtitle={t("common", K.hint)} />
      <Select value={target.chosenGrantId ?? AUTOMATIC} onChange={choose} options={options} ariaLabel={t("common", K.title)} disabled={saving} />
    </Card>
  );
}
