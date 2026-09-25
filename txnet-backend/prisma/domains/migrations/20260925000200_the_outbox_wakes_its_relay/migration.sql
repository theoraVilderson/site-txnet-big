-- F-067-n (ADR-0084 decision 1) — Postgres wakes the outbox relay, so an event
-- is published about a second after its transaction commits instead of up to
-- one `AUTOMATION_TICK_INTERVAL_MS` later.
--
-- A trigger rather than a call in each producer, the reason ADR-0083 gave for
-- `/sub`: producers are several services in two languages, and the outbox row
-- is the one thing every one of them already writes.
--
-- NOTIFY is delivered only after the inserting transaction commits, so the
-- relay never wakes to a row it cannot see yet. `FOR EACH STATEMENT` with an
-- empty payload: a statement inserting many rows notifies once, and identical
-- payloads in one transaction are folded into one.
--
-- `worker-service` LISTENs (`OutboxRelayListener`). The tick is unchanged and
-- stays the fallback.
--
-- Rollback: drop the trigger and the function. Without them the relay runs on
-- the tick alone, as before.

CREATE OR REPLACE FUNCTION automation.notify_outbox_ready() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('outbox_ready', '');
  RETURN NULL;
END
$$;

CREATE TRIGGER outbox_event_ready
  AFTER INSERT ON automation.outbox_event
  FOR EACH STATEMENT EXECUTE FUNCTION automation.notify_outbox_ready();
