"use client";

import { useEffect, useState } from "react";
import { authApi, type OtpChannel, type OtpChannelDescriptor } from "@/lib/auth-api";

/**
 * The delivery methods the server currently offers, plus the one the user has
 * picked. Which methods exist is an environment decision (`OTP_ALLOWED_CHANNELS`
 * and whether each one is configured), so the screen asks instead of assuming
 * sms/telegram/bale — a deployment with SMS switched off must not render an
 * SMS button.
 *
 * While the list is loading, and if the request fails, `selected` stays
 * undefined and the request goes out without a channel: the server then picks
 * the user's preference or its own first available channel, which is the same
 * behaviour this screen had before it could choose.
 */
export function useOtpChannels() {
  const [channels, setChannels] = useState<OtpChannelDescriptor[]>([]);
  const [selected, setSelected] = useState<OtpChannel | undefined>();
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    authApi
      .otpChannels()
      .then(({ channels }) => {
        if (!alive) return;
        setChannels(channels);
        setSelected((current) => current ?? channels[0]?.channel);
      })
      .catch(() => undefined)
      .finally(() => alive && setIsLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  return {
    channels,
    selected,
    select: setSelected,
    isLoading,
    /** One method is no choice — don't take up the screen with a picker. */
    hasChoice: channels.length > 1,
  };
}
