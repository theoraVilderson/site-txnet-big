"use client";

import { BellOff } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { NotificationItem } from "@/lib/notification-api";
import { useNotifications } from "../../../_hooks/useNotifications";
import { formatInstant } from "../../../_lib/datetime";
import { EmptyState } from "../../kit";
import type { WidgetSource } from "../useWidgetSource";
import { WidgetBody } from "../WidgetFrame";
import { WidgetList } from "../parts";

const D = FrontendI18nKeys.common.dashboard;

/** The latest this many (D4). */
export const NOTIFICATIONS_SHOWN = 5;

/**
 * Notifications (UX-1-q, D4): the latest 5, unread marked. The bell's own
 * read (`useNotifications`), so the two never disagree; reading one is the
 * bell's business.
 */
export default function NotificationsWidget() {
  const { t, lang } = useLocale();
  const { items, isLoading, failed, refresh } = useNotifications();
  const source: WidgetSource<NotificationItem[]> =
    failed && items.length === 0
      ? { state: "error", retry: refresh }
      : isLoading && items.length === 0
        ? { state: "loading", retry: refresh }
        : { state: "ready", data: items.slice(0, NOTIFICATIONS_SHOWN), retry: refresh };

  return (
    <WidgetBody source={source} isEmpty={(list) => list.length === 0} empty={<EmptyState icon={BellOff} title={t("common", D.notifications.empty)} className="py-4" />}>
      {(list) => (
        <WidgetList>
          {list.map((n) => (
            <li key={n.id} className="flex items-start gap-2 py-2.5 first:pt-0">
              <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${n.readAt === null ? "bg-primary" : "bg-transparent"}`} />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-text-primary">{n.title}</p>
                <p className="text-xs text-text-secondary">{formatInstant(n.createdAt, lang)}</p>
              </div>
            </li>
          ))}
        </WidgetList>
      )}
    </WidgetBody>
  );
}
