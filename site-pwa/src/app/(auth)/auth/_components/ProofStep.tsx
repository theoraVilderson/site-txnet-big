"use client";

import { BotLinkStep } from "@auth/auth/_components/BotLinkStep";
import { OtpStep } from "@auth/auth/_components/OtpStep";
import type { useBotLink } from "@auth/auth/_hooks/useBotLink";
import type { useOtpDelivery } from "@auth/auth/_hooks/useOtpDelivery";
import type { useOtpTimer } from "@auth/auth/_hooks/useOtpTimer";

/**
 * The step after a code was asked for: the messenger to connect first, or the
 * code to type. Either way back returns to the form, forgetting what was sent.
 */
export function ProofStep({
  linking,
  botLink,
  code,
  onCode,
  timer,
  delivery,
  onResend,
  onBack,
}: {
  /** The send answered a bot link rather than a queued code. */
  linking: boolean;
  botLink: ReturnType<typeof useBotLink>;
  code: string;
  onCode: (code: string) => void;
  timer: ReturnType<typeof useOtpTimer>;
  delivery: ReturnType<typeof useOtpDelivery>;
  onResend: () => void;
  onBack: () => void;
}) {
  if (linking && botLink.link) {
    return <BotLinkStep link={botLink.link} status={botLink.status} onBack={() => { botLink.reset(); onBack(); }} />;
  }
  return (
    <OtpStep
      value={code}
      onChange={onCode}
      timerSeconds={timer.seconds}
      timerFormatted={timer.formatted}
      onResend={onResend}
      onEditPhone={() => { delivery.reset(); onBack(); }}
      delivery={delivery.delivery}
    />
  );
}
