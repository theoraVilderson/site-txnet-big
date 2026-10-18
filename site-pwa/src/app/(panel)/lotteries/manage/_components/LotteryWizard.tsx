"use client";

import { Ticket } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { lotteryAdminApi, type AdminLottery } from "@/lib/engagement-api";
import { displayZone } from "@/lib/time-zone";
import { usePanelSession } from "../../../_context/PanelSessionContext";
import { usePrizeSources } from "../../../_hooks/usePrizeSources";
import { useAudienceGroups } from "../../../_hooks/useAudienceGroups";
import { usePrizeWizard } from "../../../_hooks/usePrizeWizard";
import { Alert, Wizard } from "../../../_components/kit";
import { LOTTERY_ADMIN_KEYS as K, lotteryDraftBody, lotteryFormFrom, validateLotteryForm, type LotteryForm } from "../_lib/lottery-admin";
import { LOTTERY_REFUSAL_STEP, LOTTERY_STEPS, LOTTERY_STEP_HOLDS, newLotteryForm } from "../_lib/lottery-steps";
import { useLotteryMessage } from "./lottery-admin-ui";
import { LotteryReview } from "./LotteryReview";
import { LotteryStepFields } from "./LotterySteps";

const W = K.wizard;

/**
 * A lottery's draft, one part at a time (UX-3-d, `contract.ux.md` K12): title
 * and group → close time and who enters → rules → prizes → review with who
 * enters. A new draft closes a week out; a saved one reopens on its review and
 * is rewritten whole (F-707-i rule 1). Publish stays on the detail page.
 */
export function LotteryWizard({ from, onClose, onSaved }: { from: AdminLottery | null; onClose: () => void; onSaved: (l: AdminLottery) => void }) {
  const { t } = useLocale();
  const { me } = usePanelSession();
  const message = useLotteryMessage();
  const zone = displayZone();
  const { templates } = usePrizeSources();
  const groups = useAudienceGroups(null);

  const w = usePrizeWizard({
    initial: () => (from ? lotteryFormFrom(from, zone) : newLotteryForm(new Date(), zone)),
    steps: LOTTERY_STEPS,
    plan: LOTTERY_STEP_HOLDS,
    // The close is judged against the moment of the check, as billing judges it at save.
    checkOf: (f: LotteryForm) => validateLotteryForm(f, zone, new Date()),
    refusalSteps: LOTTERY_REFUSAL_STEP,
    start: from ? "review" : undefined,
  });
  const set = <F extends keyof LotteryForm>(field: F, value: LotteryForm[F]) => w.setForm((f) => ({ ...f, [field]: value }));
  const send = async (f: LotteryForm) => {
    const body = lotteryDraftBody(f, zone);
    onSaved(await (from ? lotteryAdminApi.replace(from.id, body) : lotteryAdminApi.create(body)));
  };

  return (
    <Wizard
      title={t("common", from ? K.editor.edit : K.editor.create)}
      icon={Ticket}
      steps={LOTTERY_STEPS.map((s) => ({ id: s, title: t("common", W.steps[s].title), subtitle: s === "review" ? undefined : t("common", W.steps[s].subtitle) }))}
      wizard={w.wizard}
      dirty={w.dirty}
      closeQuestion={t("common", W.confirmClose)}
      busy={w.saving}
      submitLabel={t("common", K.editor.save)}
      onSubmit={() => void w.submit(send, message)}
      onClose={onClose}
      intro={w.step === "basics" ? <p className="text-xs text-text-secondary">{t("common", K.editor.draftNote)}</p> : undefined}
      error={w.failure ? <Alert tone="error">{w.failure}</Alert> : undefined}
    >
      {w.step === "review" ? (
        <LotteryReview form={w.form} savedId={from?.id ?? null} zone={zone} groups={groups} onEdit={w.goTo} />
      ) : (
        <LotteryStepFields step={w.step} form={w.form} set={set} shown={w.shown(w.step)} zone={zone} templates={templates} groups={groups} ownerTenant={me?.tenant?.id ?? null} />
      )}
    </Wizard>
  );
}
