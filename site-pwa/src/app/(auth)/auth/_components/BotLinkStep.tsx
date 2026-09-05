"use client";

import { motion } from "framer-motion";
import { ChevronRight, ExternalLink, Loader2 } from "lucide-react";
import { useAuthUI } from "@auth/auth/_context/AuthUIContext";
import type { BotLinkRequired, BotLinkStatus } from "@/lib/auth-api";

interface BotLinkStepProps {
  link: BotLinkRequired;
  status: BotLinkStatus | null;
  onBack: () => void;
}

/**
 * Shown when the chosen messenger is not connected to this account yet. The
 * user opens the bot, shares their contact there, and the code arrives in the
 * chat — this screen only waits (see `useBotLink`).
 */
export function BotLinkStep({ link, status, onBack }: BotLinkStepProps) {
  const { t, isRtl } = useAuthUI();
  const failed = status?.state === "failed";

  return (
    <motion.div
      key="bot-link-step"
      initial={{ opacity: 0, x: isRtl ? 30 : -30, filter: "blur(5px)" }}
      animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
      exit={{ opacity: 0, x: isRtl ? -30 : 30, filter: "blur(5px)" }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="mb-5 text-center"
    >
      <p className="text-text-secondary text-sm leading-7 mb-6">
        {t.botLinkSubtitle}
      </p>

      <a
        href={link.deepLink}
        target="_blank"
        rel="noopener noreferrer"
        className="w-full inline-flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-primary text-white font-bold shadow transition-transform hover:scale-[1.01]"
      >
        <ExternalLink size={18} aria-hidden />
        {t.botLinkOpen}
      </a>

      <div
        role="status"
        aria-live="polite"
        className="mt-6 text-sm flex items-center justify-center gap-2"
      >
        {failed ? (
          <span className="text-error font-bold">{t.botLinkFailed}</span>
        ) : (
          <span className="text-text-secondary flex items-center gap-2">
            <Loader2 size={16} className="animate-spin text-primary" />
            {t.botLinkWaiting}
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={onBack}
        className="mt-6 mx-auto flex items-center justify-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
      >
        <ChevronRight size={16} className={isRtl ? "" : "rotate-180"} />
        {t.botLinkChangeMethod}
      </button>
    </motion.div>
  );
}
