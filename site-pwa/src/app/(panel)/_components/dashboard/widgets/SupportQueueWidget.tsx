"use client";

import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { PANEL_SUPPORT_INBOX } from "@/lib/routes";
import { supportAgentApi, type InboxView } from "@/lib/support-api";
import { FooterLink } from "../parts";
import { useWidgetSource } from "../useWidgetSource";
import { WidgetBody } from "../WidgetFrame";

const D = FrontendI18nKeys.common.dashboard;
const VIEWS = FrontendI18nKeys.common.supportAgent.views;

/** D5's three: unassigned, mine, and waiting on the tenant (`pending`). */
const QUEUE: readonly InboxView[] = ["unassigned", "mine", "pending"];

/**
 * The support queue (UX-1-r, D5): the inbox's first page per view, as the menu
 * badge counts it; a full page that has more reads "50+".
 */
export default function SupportQueueWidget() {
  const { t } = useLocale();
  const source = useWidgetSource("support-queue", () =>
    Promise.all(
      QUEUE.map(async (view) => {
        const page = await supportAgentApi.inbox(view);
        return { view, count: page.items.length, more: page.nextAfter !== null };
      }),
    ),
  );
  return (
    <WidgetBody source={source}>
      {(rows) => (
        <div className="flex h-full flex-col">
          <dl className="grid grid-cols-3 gap-2">
            {rows.map((r) => (
              <div key={r.view} className="flex flex-col-reverse rounded-2xl bg-bg-inner p-3 text-center">
                <dt className="text-xs text-text-secondary">{t("common", VIEWS[r.view])}</dt>
                <dd className="text-xl font-black tabular-nums text-text-primary">{r.more ? `${r.count}+` : r.count}</dd>
              </div>
            ))}
          </dl>
          <FooterLink href={PANEL_SUPPORT_INBOX}>{t("common", D.supportQueue.open)}</FooterLink>
        </div>
      )}
    </WidgetBody>
  );
}
