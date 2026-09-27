package db

// OrderedConfigUpdate is a batched UPDATE of `network.config` that takes its
// row locks in id order (F-027-cv). A plain `UPDATE … FROM unnest(…)` locks
// rows in whatever order the plan reaches them, so two passes over the same
// panel — bulk, hot, a woken turn — or a pass and billing's re-split, each
// holding one row and waiting on the other's, deadlock (SQLSTATE 40P01) and
// one statement's whole batch is lost. Every writer taking the rows in the
// same order cannot form that cycle.
//
// rows is the batch, aliased `v` with an `id` column holding the config id as
// text: `unnest($1::text[], $2::bigint[]) AS v(id, bytes)`. set is the SET
// list, reading the batch as `v`. The lock is `NO KEY UPDATE`, the one the
// UPDATE itself takes, so a row referencing the config is not held up by it.
func OrderedConfigUpdate(set, rows string) string {
	return `
WITH v AS (SELECT * FROM ` + rows + `),
locked AS (
  SELECT c.id FROM network.config c JOIN v ON c.id = v.id::uuid
   ORDER BY c.id
     FOR NO KEY UPDATE OF c)
UPDATE network.config c
   SET ` + set + `
  FROM locked l JOIN v ON v.id::uuid = l.id
 WHERE c.id = l.id`
}
