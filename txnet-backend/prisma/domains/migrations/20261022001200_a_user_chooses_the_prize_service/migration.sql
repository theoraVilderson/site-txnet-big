-- F-707-r. The user's prize service: which of their Grants a wheel or lottery
-- prize of GB or days goes to. One row per user; no row is automatic (the
-- Grant that runs longest). The reward issuer falls back to automatic when
-- the Grant is gone or cannot take the prize, so no foreign key to
-- entitlement.grant: a Grant's end never has to touch this table.
--
-- Additive. Rollback: drop the table and its trigger function
-- `engagement.reward_target_same_tenant`.

CREATE TABLE "engagement"."reward_target" (
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reward_target_pkey" PRIMARY KEY ("tenantId", "userId")
);

-- Its user is its tenant's (`engagement.same_tenant`, F-707-a).
CREATE FUNCTION engagement.reward_target_same_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM identity."user" WHERE id = NEW."userId" AND "tenantId" = NEW."tenantId") THEN
    RAISE EXCEPTION 'engagement_tenant_mismatch: reward_target names a user that is not its tenant''s'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_target_same_tenant BEFORE INSERT OR UPDATE ON "engagement"."reward_target"
  FOR EACH ROW EXECUTE FUNCTION engagement.reward_target_same_tenant();

ALTER TABLE "engagement"."reward_target" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "engagement"."reward_target" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "engagement"."reward_target" TO txnet_app, txnet_cross_tenant;
CREATE POLICY tenant_isolation ON "engagement"."reward_target"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "engagement"."reward_target"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
