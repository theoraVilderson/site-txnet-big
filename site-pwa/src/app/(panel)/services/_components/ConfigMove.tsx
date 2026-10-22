"use client";

import { useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ApiError } from "@/lib/api-error";
import { billingApi, type ConfigMoveTargets } from "@/lib/billing-api";
import { formatInstant } from "../../_lib/datetime";
import { Button, Dialog, RadioCards, notify } from "../../_components/kit";
import { moveOfferOf, moveWaitOf, targetOptions } from "../_lib/config-move";
import { RefusalNote } from "./RefusalNote";

const M = FrontendI18nKeys.common.myServices.move;

/**
 * «تغییر سرور» on one config (F-410-d): the servers billing offers, by
 * region; asked in a dialog that says the link changes; moved at once
 * (F-410-c). Nothing on the list is patched from the answer: `onMoved`
 * re-reads it, the moved row is gone and the new one has no lines yet, and
 * they arrive on `network.grant.linksCaptured`, which the list already
 * listens to (C-14). The wait after a move is the next read's `nextMoveAt`.
 */
export function ConfigMove({ configId, targets, onMoved }: { configId: string; targets: ConfigMoveTargets | null; onMoved: () => void }) {
  const { t, lang } = useLocale();
  const toMessage = useApiErrorMessage();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<{ message: string; ref?: string } | null>(null);
  const offer = moveOfferOf(targets);
  if (offer.kind === "hidden") return null;

  const at = (iso: string) => t("common", M.nextAt, { at: formatInstant(iso, lang) ?? iso });
  const options = offer.kind === "open" ? targetOptions(offer.panels) : [];
  const chosen = picked !== null && options.some((o) => o.value === picked) ? picked : (options[0]?.value ?? null);

  async function moveTo(panelId: string) {
    setBusy(true);
    setRefused(null);
    try {
      const moved = await billingApi.moveConfig(configId, panelId);
      setOpen(false);
      notify.success(t("common", M.moved, { region: moved.panel.region }));
      onMoved();
    } catch (e) {
      // Refused whole: nothing moved. Inside the wait says from when; the rest is billing's sentence.
      const until = moveWaitOf(e);
      setRefused(until ? { message: at(until) } : { message: toMessage(e), ref: e instanceof ApiError ? e.ref : undefined });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" icon={<ArrowLeftRight size={14} aria-hidden />} disabled={offer.kind === "wait"}
        onClick={() => {
          setRefused(null);
          setOpen(true);
        }}
      >
        {t("common", M.action)}
      </Button>
      {offer.kind === "wait" && <span className="text-xs text-text-secondary">{at(offer.until)}</span>}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("common", M.title)}
        description={t("common", M.hint)}
        footer={
          <>
            <Button variant="quiet" onClick={() => setOpen(false)}>
              {t("common", M.cancel)}
            </Button>
            <Button variant="primary" loading={busy} disabled={chosen === null} onClick={() => chosen && void moveTo(chosen)}>
              {t("common", M.confirm)}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {chosen !== null && (
            <RadioCards ariaLabel={t("common", M.servers)} columns={2} value={chosen} onChange={setPicked} options={options.map((o) => ({ value: o.value, label: <span dir="ltr">{o.label}</span> }))} />
          )}
          {targets && targets.cooldownHours > 0 && <p className="text-xs text-text-secondary">{t("common", M.wait, { hours: targets.cooldownHours })}</p>}
          {refused && <RefusalNote error={refused} />}
        </div>
      </Dialog>
    </>
  );
}
