"use client";

import { useId } from "react";
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

/** The auth screens' picker, in their own translations. */
export function OtpChannelPicker(props: OtpChannelPickerProps) {
  const { t } = useAuthUI();
  const labels = { title: t.otpChannelLabel, sms: t.otpChannelSms, telegram: t.otpChannelTelegram, bale: t.otpChannelBale };
  return <OtpChannelChoice {...props} labels={labels} />;
}

/**
 * Where the code should be sent. Renders only what the server actually
 * offers — see `useOtpChannels`. The labels come from the caller, so the
 * panel's two-factor switch (SA-1-f) shows the same control outside `(auth)`.
 */
export function OtpChannelChoice({
  channels,
  selected,
  onSelect,
  labels,
}: OtpChannelPickerProps & { labels: Record<OtpChannel | "title", string> }) {
  // Per instance, so the pill never slides between two pickers on one page.
  const pillId = `otp-channel-pill-${useId()}`;
  return (
    <div className="mt-4">
      <p className="text-text-secondary text-sm mb-2">{labels.title}</p>
      <div
        role="radiogroup"
        aria-label={labels.title}
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
                  ? "text-on-accent"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {/* A filled pill under the content, as the kit's SegmentedControl: a `-z-10`
                  pill fell behind the track's own background and only the text colour changed. */}
              {isSelected && (
                <motion.span
                  layoutId={pillId}
                  aria-hidden
                  transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                  className="absolute inset-0 rounded-xl bg-primary shadow-sm"
                />
              )}
              <Icon size={16} aria-hidden className="relative" />
              <span className="relative">{labels[channel]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
