"use client";

import { motion } from "framer-motion";
import { MessageCircle, Send, Smartphone } from "lucide-react";
import { useAuthUI } from "@auth/auth/_context/AuthUIContext";
import type { OtpChannel, OtpChannelDescriptor } from "@/lib/auth-api";

interface OtpChannelPickerProps {
  channels: OtpChannelDescriptor[];
  selected?: OtpChannel;
  onSelect: (channel: OtpChannel) => void;
}

const ICONS: Record<OtpChannel, typeof Send> = {
  sms: Smartphone,
  telegram: Send,
  bale: MessageCircle,
};

/**
 * Where the code should be sent. Renders only what the server actually
 * offers — see `useOtpChannels`.
 */
export function OtpChannelPicker({
  channels,
  selected,
  onSelect,
}: OtpChannelPickerProps) {
  const { t } = useAuthUI();

  const label: Record<OtpChannel, string> = {
    sms: t.otpChannelSms,
    telegram: t.otpChannelTelegram,
    bale: t.otpChannelBale,
  };

  return (
    <div className="mt-4">
      <p className="text-text-secondary text-sm mb-2">{t.otpChannelLabel}</p>
      <div
        role="radiogroup"
        aria-label={t.otpChannelLabel}
        className="flex bg-tab-bg rounded-2xl p-1.5 border border-card-border shadow-inner gap-1"
      >
        {channels.map(({ channel }) => {
          const Icon = ICONS[channel];
          const isSelected = channel === selected;
          return (
            <button
              key={channel}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => onSelect(channel)}
              className={`relative flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-bold rounded-xl transition-colors duration-300 ${
                isSelected
                  ? "text-primary"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {isSelected && (
                <motion.span
                  layoutId="otp-channel-pill"
                  transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                  className="absolute inset-0 -z-10 rounded-xl bg-card-bg border border-card-border shadow"
                />
              )}
              <Icon size={16} aria-hidden />
              {label[channel]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
