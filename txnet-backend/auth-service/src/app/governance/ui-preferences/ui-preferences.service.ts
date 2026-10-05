import { BadRequestException, Injectable } from '@nestjs/common';
import { BackendI18nKeys, ok } from '@txnet-backend/shared-core';

import type { AuthClaims } from '../../auth/token.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UI_PREFERENCE_KEYS, UiPreferences, parseUiPreferencesPatch, readUiPreferences } from './ui-preferences';

/**
 * Display preferences (UX-1-k): `GET`/`PATCH /api/auth/me/ui-preferences`.
 *
 * Only the caller's own rows, by `claims.sub` — `user_setting` has no tenant
 * column and no RLS, so the `userId` filter is the whole boundary. A write is
 * one transaction of upserts, so a patch of two keys lands as both or neither.
 */
@Injectable()
export class UiPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  async read(claims: AuthClaims) {
    return ok(await this.load(claims.sub), BackendI18nKeys.errors.auth.uiPreferences);
  }

  async save(claims: AuthClaims, body: unknown) {
    const parsed = parseUiPreferencesPatch(body);
    if ('reason' in parsed) {
      throw new BadRequestException({ reason: parsed.reason, key: parsed.key, i18nKey: BackendI18nKeys.errors.validation.failed });
    }
    const userId = claims.sub;
    const writes = Object.entries(parsed.patch).map(([key, value]) =>
      this.prisma.userSetting.upsert({
        where: { userId_key: { userId, key } },
        create: { userId, key, category: 'display', value },
        update: { value, category: 'display' },
      }),
    );
    if (writes.length) await this.prisma.$transaction(writes);
    return ok(await this.load(userId), BackendI18nKeys.errors.auth.uiPreferencesSaved);
  }

  private async load(userId: string): Promise<UiPreferences> {
    const rows = await this.prisma.userSetting.findMany({
      where: { userId, key: { in: UI_PREFERENCE_KEYS } },
      select: { key: true, value: true },
    });
    return readUiPreferences(rows);
  }
}
