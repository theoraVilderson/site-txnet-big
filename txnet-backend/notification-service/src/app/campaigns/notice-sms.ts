import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { TenantType } from '@prisma/client';

import type { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { SmsLineSource } from './sms-line';

/** One notice's SMS, rendered by auth-service in the user's language, to the phone it verified. */
export type NoticeSms = { tenantId: string; userId: string; to: string; text: string };

/** `no_line`: the tenant sends no SMS (D-41). `refused`: the gateway refused this number. Both final. */
export type NoticeSmsAnswer = { sent: true } | { sent: false; reason: 'no_line' | 'refused' };

type OwnerDb = { tenant: Pick<CrossTenantPrismaService['tenant'], 'findFirst'> };

/**
 * **A notice's SMS** (F-601-t, ADR-0097 part 2): a `security` notice, and a
 * `critical` one no bot reached, told on the line {@link SmsLineResolver}
 * picks for the recipient's tenant — the campaigns' one place that decides
 * (D-38, D-41). The recipient's tenant stands where a campaign's would: the
 * platform owner's user goes out on the platform's line, a reseller's user on
 * that reseller's own line, and a reseller with none sends no SMS.
 *
 * A line that is configured but could not be opened, or answered for its
 * account (`line_down`, `retry`), is a 503: the worker's event stays owed. No
 * line and a refused number are answers, so nothing retries them.
 *
 * The line is opened per send (one vault read): these are rare by design —
 * security events, and critical notices that reached no bot.
 */
@Injectable()
export class NoticeSmsService {
  constructor(
    private readonly lines: SmsLineSource,
    private readonly db: OwnerDb,
  ) {}

  async send(sms: NoticeSms): Promise<NoticeSmsAnswer> {
    const owner = (await this.db.tenant.findFirst({ where: { tenantType: TenantType.platform_owner }, select: { id: true } }))?.id ?? null;
    const isOwner = sms.tenantId === owner;
    const resolver = await this.lines.resolverFor(isOwner ? owner : null, isOwner ? [] : [sms.tenantId]);
    const answer = resolver.lineFor(sms.tenantId, sms.tenantId, owner);
    if (answer.kind === 'none') return { sent: false, reason: 'no_line' };
    if (answer.kind === 'stalled') throw new ServiceUnavailableException(`tenant ${sms.tenantId}'s SMS line could not be opened`);
    const result = await answer.line.send(sms.to, sms.text);
    if (result.status === 'sent') return { sent: true };
    if (result.status === 'refused') return { sent: false, reason: 'refused' };
    throw new ServiceUnavailableException(`tenant ${sms.tenantId}'s SMS line answered ${result.status}: ${result.description}`);
  }
}
