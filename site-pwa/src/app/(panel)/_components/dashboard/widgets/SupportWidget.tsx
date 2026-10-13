"use client";

import Link from "next/link";
import { Headphones } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { PANEL_SUPPORT, PANEL_SUPPORT_NEW, panelSupportThreadPath } from "@/lib/routes";
import { supportApi } from "@/lib/support-api";
import { STATUS_KEYS } from "../../../support/_lib/support";
import { isUnfinished } from "../../../support/_lib/support-agent";
import { Badge, EmptyState } from "../../kit";
import { FooterLink, WidgetList } from "../parts";
import { useWidgetSource } from "../useWidgetSource";
import { WidgetBody } from "../WidgetFrame";

const D = FrontendI18nKeys.common.dashboard;

const SHOWN = 5;

/** Support (UX-1-q, D4): the caller's open threads, unread first, then the list's order. */
export default function SupportWidget() {
  const { t } = useLocale();
  const source = useWidgetSource("support", async () => {
    const open = (await supportApi.list()).items.filter((c) => isUnfinished(c.status));
    return [...open.filter((c) => c.unread > 0), ...open.filter((c) => !(c.unread > 0))].slice(0, SHOWN);
  });
  return (
    <WidgetBody
      source={source}
      isEmpty={(items) => items.length === 0}
      empty={
        <EmptyState
          icon={Headphones}
          title={t("common", D.support.empty)}
          action={
            <Link href={PANEL_SUPPORT_NEW} className="text-sm font-bold text-primary hover:underline">
              {t("common", D.quick.newTicket)}
            </Link>
          }
          className="py-4"
        />
      }
    >
      {(items) => (
        <div className="flex h-full flex-col">
          <WidgetList>
            {items.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 py-2.5 first:pt-0">
                <div className="min-w-0">
                  <Link href={panelSupportThreadPath(c.id)} className="block truncate text-sm font-bold text-text-primary hover:text-primary">
                    {c.subject}
                  </Link>
                  <p className="text-xs text-text-secondary">{t("common", STATUS_KEYS[c.status])}</p>
                </div>
                {c.unread > 0 && <Badge tone="info">{t("common", D.support.unread, { count: c.unread })}</Badge>}
              </li>
            ))}
          </WidgetList>
          <FooterLink href={PANEL_SUPPORT}>{t("common", D.support.seeAll)}</FooterLink>
        </div>
      )}
    </WidgetBody>
  );
}
