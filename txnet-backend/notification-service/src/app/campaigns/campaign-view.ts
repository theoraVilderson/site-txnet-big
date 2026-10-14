import type { CampaignStatus, Language, NotificationChannel, Prisma } from '@prisma/client';

import type { AudienceFilter } from './campaign-admin.schema';
import type { CampaignView } from './campaign-admin.service';

/** A `notification_campaign` row as the admin service reads it. */
export type CampaignRow = {
  id: string;
  tenantId: string | null;
  createdByAdminId: string;
  channel: NotificationChannel;
  filterCriteria: Prisma.JsonValue;
  messageBody: string;
  subject: string | null;
  sourceLang: Language | null;
  status: CampaignStatus;
  sentCount: number;
  failedCount: number;
  createdAt: Date;
};

/** A row as the panel sees it: the audience parsed back, the time as ISO. */
export function toView(row: CampaignRow): CampaignView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    createdByAdminId: row.createdByAdminId,
    channel: row.channel,
    // Written only through `audienceFilterSchema`; F-035-d parses it again before it trusts it.
    audience: row.filterCriteria as AudienceFilter,
    messageBody: row.messageBody,
    subject: row.subject,
    sourceLang: row.sourceLang,
    status: row.status,
    sentCount: row.sentCount,
    failedCount: row.failedCount,
    createdAt: row.createdAt.toISOString(),
  };
}
