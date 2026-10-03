-- F-033-c, ADR-0113: a stored file is public (served by Host, branding) or
-- private (served only through a short-lived signed URL, support attachments).
-- Every existing row is branding, so every existing row is public.
ALTER TABLE "storage"."stored_object" ADD COLUMN "private" BOOLEAN NOT NULL DEFAULT false;
