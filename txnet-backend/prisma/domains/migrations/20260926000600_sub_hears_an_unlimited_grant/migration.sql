-- F-111-s — `/sub` answers `total=0` for a Grant sold with unlimited traffic,
-- read from `grant."trafficUnlimited"`. The Grant trigger now also fires on
-- that column, so a cached `Subscription-Userinfo` never outlives a change to
-- it (sub-api contract.md, the cache rule 4). It is written at issue today;
-- an admin correcting it later must still reach the cache.
--
-- Rollback: restore `entitlement.notify_sub_grant_changed` and its trigger
-- from 20260924000800.

CREATE OR REPLACE FUNCTION entitlement.notify_sub_grant_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR
     OLD.status IS DISTINCT FROM NEW.status OR
     OLD."subscriptionTokenHash" IS DISTINCT FROM NEW."subscriptionTokenHash" OR
     OLD."tenantId" IS DISTINCT FROM NEW."tenantId" OR
     OLD."endsAt" IS DISTINCT FROM NEW."endsAt" OR
     OLD.quotas IS DISTINCT FROM NEW.quotas OR
     OLD."billingMode" IS DISTINCT FROM NEW."billingMode" OR
     OLD."trafficUnlimited" IS DISTINCT FROM NEW."trafficUnlimited" THEN
    PERFORM pg_notify('sub_invalidate', json_build_object('kind', 'grant', 'id', OLD.id)::text);
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER sub_grant_changed ON entitlement."grant";
CREATE TRIGGER sub_grant_changed
  AFTER UPDATE OF status, "subscriptionTokenHash", "tenantId", "endsAt", quotas, "billingMode", "trafficUnlimited" OR DELETE
  ON entitlement."grant"
  FOR EACH ROW EXECUTE FUNCTION entitlement.notify_sub_grant_changed();
