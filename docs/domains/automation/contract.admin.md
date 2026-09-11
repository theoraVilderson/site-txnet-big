---
id: automation
layer: domain
status: active
version: 5
updated: 2026-09-10
---

# Contract — automation: the admin surface

Split out of [contract.worker.md](contract.worker.md) at 250 lines (§10). That
file is the runtime — the exchange, the queues, the tick, the dead-letter path.
This one is the five HTTP routes an admin drives it with, which have a
different audience and change for different reasons.

Five routes under `/admin/workers`, all behind `worker.manage`. They are in
`auth-service` because `worker-service` serves no HTTP by design (ADR-0027) and
because this is the process that already authenticates an admin — the two meet
at the three tables and at one exchange, and nowhere else.

A worker is addressed by its **`key`**, never by its uuid: the key is what the
job class declares, what invariant #4 protects, and the routing suffix of the
tick, so it is the identifier an operator reading a log already has.

**The write surface holds invariant #2 where a person can be told about it.**
Before this, a `bot_schedule` row could only be typed in by hand, so a shape
that could never run was both reachable and unreportable — the publisher
declined it into a log nobody reads. `set schedule` calls the same
`scheduleShapeError` the publisher calls and refuses with the rule that was
broken; `list workers` answers a `shapeError` per schedule, so a row already in
the table is visible too.

**Nothing is deleted.** A schedule is switched off, not removed:
`bot_execution_log` explains past runs and `setByAdminId` says who asked for
them, and deleting the row that explains a run leaves the history unreadable.

**`run now` is a publish, not a call.** The route answers "asked for", never
"finished" — the run happens in `worker-service`, which is what keeps the log
row, the timeout and the redelivery in one place (invariant #3). The broker
connection is opened lazily and `RABBITMQ_URL` is optional in `auth-service`:
this process answers `/auth/login`, and a broker that is down must fail that one
route rather than the boot.

**A failed run is nacked without requeue.** Requeueing spins a permanently
failing job at broker speed, which starves everything behind it. The failure is
not lost — it is a `bot_execution_log` row with `status = failed` — and the next
tick arrives on the next interval anyway. Since F-067-d the rejected message is
not lost either; see below.

