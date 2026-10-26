"use client";

import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { DOMAIN_KEYS as K } from "../../../_lib/domains";
import { IconButton } from "../../../../_components/kit";
import { COPY_FEEDBACK_MS, copyText } from "../../../../_lib/clipboard";

/**
 * The copy button first, at a fixed place, so every row's button sits in one
 * column whatever the text's length; the text (left-to-right) takes the rest.
 */
export function Copyable({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <span className="flex items-start gap-2">
      <CopyButton text={text} />
      <span className="min-w-0 flex-1 pt-1">
        <span dir="ltr" className="block break-all font-mono">{text}</span>
        {children}
      </span>
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  const label = t("common", copied ? K.copied : K.copy);
  return (
    <IconButton
      size="sm"
      aria-label={label}
      title={label}
      className="shrink-0"
      onClick={() => {
        void copyText(text).then((ok) => {
          setCopied(ok);
          setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
        });
      }}
      icon={copied ? <Check size={14} aria-hidden className="text-primary" /> : <Copy size={14} aria-hidden />}
    />
  );
}
