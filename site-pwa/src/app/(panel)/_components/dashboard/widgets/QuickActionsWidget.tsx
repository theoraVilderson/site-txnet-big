"use client";

import Link from "next/link";
import { CreditCard, Gift, MessageSquarePlus, ShoppingCart, type LucideIcon } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { PANEL_DEPOSIT, PANEL_SHOP, PANEL_SUPPORT_NEW } from "@/lib/routes";
import { usePanelUiStore } from "../../../_stores/panel-ui-store";

const Q = FrontendI18nKeys.common.dashboard.quick;

const TILE =
  "flex flex-col items-center justify-center gap-2 rounded-2xl border border-card-border bg-bg-inner p-3 text-center text-xs font-bold text-text-primary transition-colors hover:border-primary hover:bg-leaf-bg";

function Face({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <>
      <span className="grid size-9 place-items-center rounded-xl bg-leaf-bg text-primary">
        <Icon size={18} aria-hidden />
      </span>
      {label}
    </>
  );
}

/** Quick actions (UX-1-q, D4): top up, gift code, buy, new ticket. */
export default function QuickActionsWidget() {
  const { t } = useLocale();
  const openGiftCode = usePanelUiStore((s) => s.setGiftCodeOpen);
  return (
    <div className="grid grid-cols-2 gap-2">
      <Link href={PANEL_DEPOSIT} className={TILE}>
        <Face icon={CreditCard} label={t("common", Q.topUp)} />
      </Link>
      <button type="button" onClick={() => openGiftCode(true)} className={TILE}>
        <Face icon={Gift} label={t("common", Q.giftCode)} />
      </button>
      <Link href={PANEL_SHOP} className={TILE}>
        <Face icon={ShoppingCart} label={t("common", Q.buy)} />
      </Link>
      <Link href={PANEL_SUPPORT_NEW} className={TILE}>
        <Face icon={MessageSquarePlus} label={t("common", Q.newTicket)} />
      </Link>
    </div>
  );
}
