-- F-101-b (ADR-0043 §4) — Postgres tells auth-service when what a role grants,
-- or which role a user holds, has changed, so the fingerprint the gate compares
-- every token against is rewritten at once instead of when tokens expire.
--
-- A trigger rather than application code, because nothing in the application
-- writes these rows: they change by SQL and by migration, and a trigger is the
-- one writer that sees both.
--
-- Two properties of NOTIFY this leans on. It is delivered only after the writing
-- transaction commits, so the listener always reads the committed set. And
-- Postgres folds identical notifications inside one transaction, so a migration
-- that inserts fifty rows for one role wakes the listener once for that role.
--
-- The payload is JSON carrying ids only — never a permission key — because a
-- notification is visible to every session that LISTENs on the channel.
--
-- Rollback: drop the three triggers and the three functions. Nothing depends on
-- them; without them the keys are simply never rewritten, and a missing key
-- refuses nobody (ADR-0043 §3).

-- A row granted, moved or revoked: that role's set changed. An UPDATE that
-- moves a row between roles changes both, so both are named.
CREATE OR REPLACE FUNCTION identity.notify_role_permissions_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM pg_notify(
      'identity_permissions_changed',
      json_build_object('kind', 'role', 'roleId', NEW."roleId")::text
    );
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM pg_notify(
      'identity_permissions_changed',
      json_build_object('kind', 'role', 'roleId', OLD."roleId")::text
    );
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER role_permission_changed
  AFTER INSERT OR UPDATE OR DELETE ON identity.role_permission
  FOR EACH ROW EXECUTE FUNCTION identity.notify_role_permissions_changed();

-- A user moved to another role. The old role's fingerprint cannot see this, so
-- the user's own key is written.
CREATE OR REPLACE FUNCTION identity.notify_user_role_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'identity_permissions_changed',
    json_build_object('kind', 'user', 'userId', NEW.id, 'roleId', NEW."roleId")::text
  );
  RETURN NULL;
END
$$;

CREATE TRIGGER user_role_changed
  AFTER UPDATE OF "roleId" ON identity."user"
  FOR EACH ROW WHEN (OLD."roleId" IS DISTINCT FROM NEW."roleId")
  EXECUTE FUNCTION identity.notify_user_role_changed();

-- A permission's key renamed changes the fingerprint of every role holding it.
-- Rare, and roles are few, so every role is recomputed.
CREATE OR REPLACE FUNCTION identity.notify_permission_key_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'identity_permissions_changed',
    json_build_object('kind', 'all')::text
  );
  RETURN NULL;
END
$$;

CREATE TRIGGER permission_key_changed
  AFTER UPDATE OF key ON identity.permission
  FOR EACH ROW WHEN (OLD.key IS DISTINCT FROM NEW.key)
  EXECUTE FUNCTION identity.notify_permission_key_changed();
