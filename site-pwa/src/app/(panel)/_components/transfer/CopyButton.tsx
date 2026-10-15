"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Copy } from "lucide-react";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { haptic } from "@/lib/haptics";
import { DURATION } from "@/lib/motion";
import { COPY_FEEDBACK_MS, copyText } from "../../_lib/clipboard";
import { Button, IconButton, type ButtonVariant } from "../kit";

interface CopyButtonProps {
  value: string;
  label: string;
  copiedLabel: string;
  /** An icon alone (beside a figure) or a labelled button (the page's primary action). */
  iconOnly?: boolean;
  variant?: ButtonVariant;
  className?: string;
}

/**
 * Copy one value a payer types into their bank or wallet (F-803-i): the icon
 * morphs copy → check and back after the panel's copy mark (FE-1-b), with a
 * light buzz where the device has one. Under reduced motion the swap is a fade.
 */
export function CopyButton({ value, label, copiedLabel, iconOnly, variant, className }: CopyButtonProps) {
  const level = useMotionLevel();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    if (!(await copyText(value))) return;
    haptic.copied();
    setCopied(true);
  };

  const morph = level === "full" ? { initial: { opacity: 0, scale: 0.6 }, animate: { opacity: 1, scale: 1 }, exit: { opacity: 0, scale: 0.6 } } : { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } };
  const icon = (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span key={copied ? "check" : "copy"} {...morph} transition={{ duration: DURATION.fast }} className="grid place-items-center">
        {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
      </motion.span>
    </AnimatePresence>
  );
  const name = copied ? copiedLabel : label;

  if (iconOnly) return <IconButton aria-label={name} icon={icon} onClick={() => void copy()} variant={variant} className={className} />;
  return (
    <Button icon={icon} onClick={() => void copy()} variant={variant} className={className} aria-live="polite">
      {name}
    </Button>
  );
}
