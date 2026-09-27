-- F-307-t — a Grant remembers when its owner's open page was last told its
-- consumedBytes, so metering announces it at most once per 30 s per Grant.
-- Additive and nullable: null = never told, the next charge announces.
ALTER TABLE "entitlement"."grant" ADD COLUMN "usagePushedAt" TIMESTAMP(3);
