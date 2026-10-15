-- F-803-l: a manual gateway's usual time to confirm a proof, as its seller
-- states it, for the payer's "usually within n minutes". Additive and nullable:
-- every existing setting shows no figure until its seller sets one.
ALTER TABLE "billing"."manual_gateway_setting" ADD COLUMN "confirmWithinMinutes" INTEGER;
ALTER TABLE "billing"."manual_gateway_setting"
  ADD CONSTRAINT "manual_gateway_setting_confirmWithinMinutes_check"
  CHECK ("confirmWithinMinutes" IS NULL OR "confirmWithinMinutes" BETWEEN 1 AND 1440);
