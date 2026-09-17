---
id: adr-0055
status: accepted
updated: 2026-09-17
---

# ADR 0055 — A campaign's translations live with the campaign, machine-drafted and admin-published

- **Status:** accepted 2026-09-17 (row F-035-h)
- **Date:** 2026-09-17
- **Affects units:** notification, i18n

## Context

F-035-h adds email, which needs a subject a campaign did not have. The user
asked for more than a subject: a default one, editable, and the whole campaign
translated for recipients in other languages by the local AI translator, each
translation editable by hand — "like the catalog". That is every channel, not
only email, and the body as much as the subject.

ADR-0050 keeps catalog text in locale-service's `shareds` overlay. Campaign text
cannot go there: every client downloads `shareds`, so one reseller's unsent
campaign would reach every panel, and a one-off message would stay in the
overlay forever.

## Decision (D-40, the user's calls)

1. **A table in `notification`.** `notification_campaign_text (campaignId, lang,
   subject?, body, state draft|published)`, unique per campaign and `Language`.
   The campaign's own `messageBody`/`subject` are the source, written in
   `sourceLang` (null = `DEFAULT_LANGUAGE`).
2. **ADR-0050's review loop.** The `Translator` drafts every missing language
   on request (`kind: 'message'`, so the LLM is told it is a message, not a store
   name); an admin publishes a draft or writes their own text. A draft is never
   sent.
3. **Delivery picks per recipient:** the published text in `languagePreference`,
   else the source. An email with no subject gets `notifications.campaign.emailSubject`
   in the language of the body it carries.
4. **A translation never outlives its source.** Changing the source body, subject
   or language deletes every text in that transaction; texts change only while
   the campaign is a draft.
5. **Access is the campaign's.** The table has no `tenantId` or RLS of its own,
   like the recipient rows; every read and write goes through
   `CampaignAdminService.managed`.

## Consequences

- Positive: the translator, its engines and the draft/publish vocabulary are
  reused; no locale-service write path for `notification-service`.
- Negative / accepted cost: a second place holds machine-drafted text beside
  locale-service. The table has no RLS, so the campaign read is its only guard.
- Forecloses: nothing — per-tenant message templates, if they come, are
  locale-service entries and not campaigns.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| A namespace in locale-service's overlay, as the catalog | unsent tenant text served to every client, kept forever, and a new write seam for this service |
| A fixed translated subject, or the body's first line | the user asked for an editable default and translated campaigns |
| Email and translations as two rows | the user's call: both in F-035-h |

## Revisit trigger

If campaigns grow reusable templates, move the template text to locale-service
and keep this table for per-campaign overrides.
