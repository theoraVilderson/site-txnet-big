"use client";

import { Dices } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { wheelAdminApi, type WheelVersion } from "@/lib/engagement-api";
import { usePanelSession } from "../../../_context/PanelSessionContext";
import { usePrizeSources } from "../../../_hooks/usePrizeSources";
import { useAudienceGroups } from "../../../_hooks/useAudienceGroups";
import { usePrizeWizard } from "../../../_hooks/usePrizeWizard";
import { currencyDecimals, formatMoney, MONEY_MAX_PLACES } from "../../../_lib/money";
import { Alert, Wizard } from "../../../_components/kit";
import { WHEEL_SETTINGS_KEYS as K, emptyWheelForm, formFromVersion, validateWheelForm, wheelVersionBody, type WheelForm } from "../_lib/wheel-settings";
import { WHEEL_REFUSAL_STEP, WHEEL_STEPS, WHEEL_STEP_HOLDS } from "../_lib/wheel-steps";
import { useMessage } from "./wheel-settings-ui";
import { WheelReview } from "./WheelReview";
import { WheelStepFields } from "./WheelSteps";

const W = K.wizard;

/**
 * A new version of the wheel, one part at a time (UX-3-c, `contract.ux.md`
 * K12): cap and on/off → who may spin → prizes, with the disc and each slot's
 * odds → review. It opens on the version it starts from, so a save restates
 * what it does not change; a save is still a new version from the tenant's
 * next day (F-707-f). The odds and the cost are `wheel-settings.ts`'s.
 */
export function WheelWizard({ from, today, currency, onClose, onSaved }: {
  from: WheelVersion | null;
  today: string;
  currency: string | null;
  onClose: () => void;
  onSaved: (v: WheelVersion) => void;
}) {
  const { lang, t } = useLocale();
  const { me } = usePanelSession();
  const message = useMessage();
  const { templates } = usePrizeSources();
  const groups = useAudienceGroups(null);

  // The wheel's money is in its currency's minor units; until it is known, the columns' widest (F-116-s).
  const decimals = currency ? currencyDecimals(currency) : MONEY_MAX_PLACES;
  const money = (amount: string) => (currency ? formatMoney(amount, currency, { lang, t }) : amount);
  const w = usePrizeWizard({
    initial: () => (from ? formFromVersion(from) : emptyWheelForm()),
    steps: WHEEL_STEPS,
    plan: WHEEL_STEP_HOLDS,
    checkOf: (f: WheelForm) => validateWheelForm(f, decimals),
    refusalSteps: WHEEL_REFUSAL_STEP,
  });
  const set = <F extends keyof WheelForm>(field: F, value: WheelForm[F]) => w.setForm((f) => ({ ...f, [field]: value }));

  return (
    <Wizard
      title={from ? t("common", K.editFrom, { version: from.version }) : t("common", K.newVersion)}
      icon={Dices}
      steps={WHEEL_STEPS.map((s) => ({ id: s, title: t("common", W.steps[s].title), subtitle: s === "review" ? undefined : t("common", W.steps[s].subtitle) }))}
      wizard={w.wizard}
      dirty={w.dirty}
      closeQuestion={t("common", W.confirmClose)}
      busy={w.saving}
      submitLabel={t("common", K.save)}
      onSubmit={() => void w.submit(async (f) => onSaved(await wheelAdminApi.save(wheelVersionBody(f))), message)}
      onClose={onClose}
      error={w.failure ? <Alert tone="error">{w.failure}</Alert> : undefined}
    >
      {w.step === "review" ? (
        <WheelReview form={w.form} today={today} currency={currency ?? "—"} decimals={decimals} money={money} groups={groups} onEdit={w.goTo} />
      ) : (
        <WheelStepFields
          step={w.step}
          form={w.form}
          set={set}
          shown={w.shown(w.step)}
          currency={currency ?? "—"}
          isFirst={from === null}
          templates={templates}
          groups={groups}
          ownerTenant={me?.tenant?.id ?? null}
        />
      )}
    </Wizard>
  );
}
