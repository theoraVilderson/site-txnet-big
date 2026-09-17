import { Inject, Injectable } from '@nestjs/common';
import { CampaignTextState, Language } from '@prisma/client';
import { TRANSLATOR, type Translator } from '@txnet-backend/shared-core';

import { LocaleService } from '../locale/locale.service';
import { CampaignActor, CampaignAdminRefused, CampaignAdminService } from './campaign-admin.service';

/** One language's text as delivery picks it; `subject: null` = the translated default in `lang`. */
export type PickedText = { lang: string; subject: string | null; body: string };

export type CampaignTextView = {
  lang: Language;
  subject: string | null;
  body: string;
  state: CampaignTextState;
  updatedAt: string;
};

export type CampaignTextsView = {
  sourceLang: Language;
  subject: string | null;
  messageBody: string;
  /** Every language but the source that has a draft or a published text. */
  texts: CampaignTextView[];
  /** Languages with neither — what "draft missing" would fill. */
  missing: Language[];
};

const LANGUAGES = Object.values(Language);

/** `DEFAULT_LANGUAGE` as a `Language`; a deployment default outside the enum reads as its first value. */
export function languageOr(value: string | null | undefined, fallback: string): Language {
  const lang = value ?? fallback;
  return (LANGUAGES as string[]).includes(lang) ? (lang as Language) : LANGUAGES[0];
}

/**
 * **What one recipient receives** (F-035-h): the published text in their
 * language, else the campaign's own source text. A draft is never an input —
 * callers pass published texts only. Body and subject always come from the
 * same language, so a text with no subject gets the default in *its* language.
 */
export function textFor(
  campaign: { messageBody: string; subject: string | null; sourceLang: string | null },
  published: readonly { lang: string; subject: string | null; body: string }[],
  userLang: string,
  defaultLang: string,
): PickedText {
  const own = published.find((t) => t.lang === userLang);
  if (own) return { lang: own.lang, subject: own.subject, body: own.body };
  return { lang: campaign.sourceLang ?? defaultLang, subject: campaign.subject, body: campaign.messageBody };
}

/**
 * A campaign in every language (F-035-h, the user's call 2026-09-17): the admin
 * writes the source, the `Translator` drafts the rest, an admin edits or
 * publishes each — catalog's review loop (ADR-0050), kept in
 * `notification_campaign_text` rather than locale-service, because a campaign
 * is one tenant's one-off message, not text every client downloads.
 *
 * Access is the campaign's: every call goes through
 * {@link CampaignAdminService.managed}, which picks the pool by the caller and
 * refuses anything past a draft (invariants 7, 8).
 */
@Injectable()
export class CampaignTextService {
  constructor(
    private readonly campaigns: CampaignAdminService,
    @Inject(TRANSLATOR) private readonly translator: Translator,
    private readonly locale: LocaleService,
  ) {}

  async list(actor: CampaignActor, id: string): Promise<CampaignTextsView> {
    return (await this.load(actor, id, false)).view;
  }

  private async load(actor: CampaignActor, id: string, draft: boolean) {
    const { db, campaign } = await this.campaigns.managed(actor, id, { draft });
    const sourceLang = languageOr(campaign.sourceLang, this.locale.getDefaultLanguage());
    const rows = await db.notificationCampaignText.findMany({
      where: { campaignId: id },
      orderBy: { lang: 'asc' },
      select: { lang: true, subject: true, body: true, state: true, updatedAt: true },
    });
    const texts = rows.filter((r) => r.lang !== sourceLang).map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }));
    const written = new Set<string>(texts.map((t) => t.lang));
    const view: CampaignTextsView = {
      sourceLang,
      subject: campaign.subject,
      messageBody: campaign.messageBody,
      texts,
      missing: LANGUAGES.filter((l) => l !== sourceLang && !written.has(l)),
    };
    return { db, view };
  }

  /**
   * Drafts, from the source, every language with no text yet. A language the
   * engine cannot translate whole — body, and subject when there is one — gets
   * no draft: half a message is worse than the source.
   */
  async draftMissing(actor: CampaignActor, id: string): Promise<CampaignTextsView & { drafted: number }> {
    const { db, view: before } = await this.load(actor, id, true);
    const data: { campaignId: string; lang: Language; subject: string | null; body: string; state: CampaignTextState }[] = [];
    for (const lang of before.missing) {
      const body = await this.translate(before.messageBody, before.sourceLang, lang);
      const subject = before.subject ? await this.translate(before.subject, before.sourceLang, lang) : null;
      if (!body || (before.subject && !subject)) continue;
      data.push({ campaignId: id, lang, subject, body, state: CampaignTextState.draft });
    }
    if (data.length === 0) return { ...before, drafted: 0 };
    // `skipDuplicates`: an admin's text written meanwhile wins over a draft.
    const { count } = await db.notificationCampaignText.createMany({ data, skipDuplicates: true });
    return { ...(await this.list(actor, id)), drafted: count };
  }

  /** An admin's own text for one language, published as written. */
  async write(
    actor: CampaignActor,
    id: string,
    lang: Language,
    input: { subject?: string | null; body: string },
  ): Promise<CampaignTextView> {
    const { db, campaign } = await this.campaigns.managed(actor, id, { draft: true });
    this.assertNotSource(campaign.sourceLang, lang);
    const text = { subject: input.subject ?? null, body: input.body, state: CampaignTextState.published };
    const row = await db.notificationCampaignText.upsert({
      where: { campaignId_lang: { campaignId: id, lang } },
      create: { campaignId: id, lang, ...text },
      update: text,
    });
    return toTextView(row);
  }

  /** A draft published as it is. */
  async publish(actor: CampaignActor, id: string, lang: Language): Promise<CampaignTextView> {
    const { db, campaign } = await this.campaigns.managed(actor, id, { draft: true });
    this.assertNotSource(campaign.sourceLang, lang);
    const { count } = await db.notificationCampaignText.updateMany({
      where: { campaignId: id, lang },
      data: { state: CampaignTextState.published },
    });
    if (count === 0) throw new CampaignAdminRefused('text_not_found', `${id} ${lang}`);
    const row = await db.notificationCampaignText.findUnique({ where: { campaignId_lang: { campaignId: id, lang } } });
    if (!row) throw new CampaignAdminRefused('text_not_found', `${id} ${lang}`);
    return toTextView(row);
  }

  private assertNotSource(sourceLang: Language | null, lang: Language): void {
    if (languageOr(sourceLang, this.locale.getDefaultLanguage()) === lang) {
      throw new CampaignAdminRefused('text_is_source', `${lang} is the campaign's source; edit the campaign instead`);
    }
  }

  private async translate(text: string, from: string, to: string): Promise<string | null> {
    try {
      return await this.translator.translate(text, from, to, 'message');
    } catch {
      return null; // the port promises never to throw; a driver that does costs one draft
    }
  }
}

function toTextView(row: { lang: Language; subject: string | null; body: string; state: CampaignTextState; updatedAt: Date }): CampaignTextView {
  return { lang: row.lang, subject: row.subject, body: row.body, state: row.state, updatedAt: row.updatedAt.toISOString() };
}
