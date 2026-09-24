-- F-609 — `/sub` answers `Subscription-Userinfo` (catalog §7.5), cached with
-- the body (F-113-c, ADR-0083). The Grant trigger now also fires on what the
-- header is built from and changes rarely — `endsAt` (a renewal), `quotas`,
-- `billingMode` — and a traffic adjustment added to a Grant fires too.
--
-- `consumedBytes` is deliberately not watched: the delta consumer moves it on
-- every pass, and a notification per move would empty the cache it exists to
-- fill. The used figure an app shows lags by up to the render TTL (the user,
-- 2026-09-24). An adjustment or an `endsAt` passing with no write is the same
-- lag, for the same reason: nothing is written, so nothing can fire.
--
-- Rollback: restore `entitlement.notify_sub_grant_changed` and its trigger
-- from 20260924000700, drop `sub_quota_adjustment_added` and its function.

CREATE OR REPLACE FUNCTION entitlement.notify_sub_grant_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR
     OLD.status IS DISTINCT FROM NEW.status OR
     OLD."subscriptionTokenHash" IS DISTINCT FROM NEW."subscriptionTokenHash" OR
     OLD."tenantId" IS DISTINCT FROM NEW."tenantId" OR
     OLD."endsAt" IS DISTINCT FROM NEW."endsAt" OR
     OLD.quotas IS DISTINCT FROM NEW.quotas OR
     OLD."billingMode" IS DISTINCT FROM NEW."billingMode" THEN
    PERFORM pg_notify('sub_invalidate', json_build_object('kind', 'grant', 'id', OLD.id)::text);
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER sub_grant_changed ON entitlement."grant";
CREATE TRIGGER sub_grant_changed
  AFTER UPDATE OF status, "subscriptionTokenHash", "tenantId", "endsAt", quotas, "billingMode" OR DELETE
  ON entitlement."grant"
  FOR EACH ROW EXECUTE FUNCTION entitlement.notify_sub_grant_changed();

-- An adjustment is history: `quota_adjustment_is_history` refuses an update
-- or a delete, so an insert is the only change there is.
CREATE OR REPLACE FUNCTION entitlement.notify_sub_quota_adjustment_added() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.metric = 'traffic_bytes' THEN
    PERFORM pg_notify('sub_invalidate', json_build_object('kind', 'grant', 'id', NEW."grantId")::text);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER sub_quota_adjustment_added
  AFTER INSERT ON entitlement.quota_adjustment
  FOR EACH ROW EXECUTE FUNCTION entitlement.notify_sub_quota_adjustment_added();
