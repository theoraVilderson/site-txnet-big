-- F-201-e (D-63): an import's commit finds or creates the tenant's user for
-- each source client by the client's remoteIdentity — the Grant's key — so a
-- second run of the same source finds the person instead of creating them
-- again. Additive: a nullable column, a CHECK and a unique index; every
-- existing row stays null.

ALTER TABLE "identity"."user" ADD COLUMN "remoteIdentity" TEXT;
ALTER TABLE "identity"."user" ADD CONSTRAINT "user_remote_identity_not_blank" CHECK (
    "remoteIdentity" IS NULL OR btrim("remoteIdentity") <> '');
CREATE UNIQUE INDEX "user_tenantId_remoteIdentity_key" ON "identity"."user"("tenantId", "remoteIdentity");
