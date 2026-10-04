-- F-414-g — a guide's text is typed blocks (ADR-0116 point 1): `blocks` JSONB
-- in place of the Markdown `body`. The block types are shared-core's
-- guide-blocks.ts; the database holds the shape it can see alone — an array,
-- 1–100 blocks, at most 64 KiB — the same bounds as the schema.
--
-- `body` is carried over as one text block before it is dropped, so no text is
-- lost (dev held none, 2026-10-04). Rollback: add `body`, set it from the
-- first text block, drop `blocks`.

ALTER TABLE "guide"."guide_translation" ADD COLUMN "blocks" JSONB;

UPDATE "guide"."guide_translation"
   SET "blocks" = jsonb_build_array(jsonb_build_object('type', 'text', 'text', "body"));

ALTER TABLE "guide"."guide_translation"
  ALTER COLUMN "blocks" SET NOT NULL,
  DROP CONSTRAINT "guide_translation_body",
  DROP COLUMN "body",
  ADD CONSTRAINT "guide_translation_blocks" CHECK (
    jsonb_typeof("blocks") = 'array'
    AND jsonb_array_length("blocks") BETWEEN 1 AND 100
    AND octet_length("blocks"::text) <= 65536
  );
