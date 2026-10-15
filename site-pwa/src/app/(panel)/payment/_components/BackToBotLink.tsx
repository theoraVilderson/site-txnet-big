import { Send } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

/**
 * Back to the bot a top-up started in (F-093-u) — the result page's main action
 * then, since that chat is where the payer was. The link is billing's, signed
 * into the result token; a plain anchor, because it leaves the panel for the
 * messenger app.
 */
export function BackToBotLink({ href, className }: { href: string; className: string }) {
  const { t } = useLocale();
  return (
    <a href={href} rel="noopener noreferrer" className={className}>
      <Send size={16} aria-hidden />
      {t("common", FrontendI18nKeys.common.paymentResult.backToBot)}
    </a>
  );
}
