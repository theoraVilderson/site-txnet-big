---
id: network
layer: domain
status: active
version: 1
updated: 2026-10-23
---

# IBSng (F-027-ay)

A topic file of `contract.md` (§10), beside `contract.drivers.md`, whose "What
every family is" holds here unchanged. It will govern
`network-service/internal/driver/ibsng/`, which F-027-ay-b (read side) and
F-027-ay-c (write side) build. Until then it holds what a real install proved
(F-027-ay-a): the rules those rows build on.

IBSng has no API documentation. The source of truth is the last open-source
release, **IBSng A1.24** (SourceForge, 2008-01-14, sha256 `c7117a6a…49d18a8`),
and the dev install of that same tarball (ADR-0160 decision 5). A field install
that answers differently runs the same probe, and the difference is fixed in
the one driver, never forked into a second.

**The ceiling is IBSng's traffic accounting, its credit switched off**
(ADR-0160 decision 13). Each of our users carries
`traffic_periodic_accounting_daily` = 36500 days (a period that never comes
round) and `traffic_periodic_accounting_daily_limit` in bytes. Each sits in
the group `txnet`, whose charge `txnet` prices nothing, with a credit of 1
that is never spent.

## Proved on a real install (F-027-ay-a)

IBSng A1.24 runs in dev-docker (`dev-docker/ibsng/`, profile `ibsng`), with
its own Postgres. `probe.py` there re-proves rules 1-10 and 12 in eighteen checks.
It plays the NAS with `radclient`, against a `Mikrotik` RAS at 127.0.0.1 with
SNMP off. Each rule is what the install did, read against its code.

1. **XML-RPC on port 1235, one struct per call.** Method `handler.method`
   (`user.getUserInfo`), path `/`. The struct carries `auth_name`,
   `auth_pass`, `auth_type=ADMIN` and the call's arguments. A failure is a
   Fault whose string is `CODE|text`: `INCORRECT_PASSWORD`,
   `USERID_DOESNT_EXISTS`, `TO_VALUE_INVALID`, `DELETE_USER_IS_ONLINE`. The
   driver classifies by `CODE`, never by the text.
2. **A list argument goes as a struct keyed `"0"`, `"1"`, ….** `Request.fixList`
   returns the key's own name for a real XML-RPC array, so a charge rule's
   `dows` sent as a list reads as the days `d`, `o`, `w`, `s`. IBSng's PHP
   client sends structs.
3. **A page is at most 3000 rows** (`report_lib.checkFromTo`), for
   `user.searchUser` and every report; `to - from > 3000` is
   `TO_VALUE_INVALID`.
4. **`user.getUserInfo` reads many users in one call** (`user_id="3,4"`): a
   struct keyed by the id as a string, each `{basic_info, attrs,
   online_status}`. Every attribute value is a string. **`attrs` carries
   `normal_password` in clear.** The driver drops it as it decodes, and never
   logs or keeps it (ADR-0160 decision 2).
5. **The limit counts upload plus download, from the last update.**
   `traffic_periodic_accounting_daily_usage` is read live: it includes an open
   session's bytes as of the NAS's last interim update. The first login sets
   `…_reset`, 100 years out. Writing `…_usage` through `updateUserAttrs` does
   nothing, so `ResetUsage` has nothing to call.
6. **Credit refuses a login only at zero.** The charge `txnet` has one rule:
   every day, every RAS, `cpm=0`, `cpk=0`. A zero rate leaves the credit
   untouched (`InternetCharge`: no rate, no end). A credit of 0 still refuses
   the login (`initUser`), which is why every user holds 1.
7. **Over the limit, a login is refused**: Access-Reject, `Reply-Message =
   "E=915"` (`TRAFFIC_QUOTA_EXCEEDED`). A locked user (`lock` attribute) is
   refused too; deleting the attribute lets them back.
8. **Crossing the limit mid-session, IBSng decides the kill itself.** It
   re-checks an online user at most every 30 seconds (`MIN_REMAINING_TIME`),
   timed by the remaining bytes over the charge rule's `assumed_kps`. So
   `assumed_kps` is 125000 (~1 Gbit/s): a figure below the line rate would
   check late. The session's `kill_reason` reads `User Traffic quota has been
   exceeded`. On a `Mikrotik` RAS the kill is `ssh <mikrotik_ssh_username>@<nas>
   '/ppp active remove [/ppp active find name=… address=…]'`. A NAS that
   refuses that login keeps the session to its end; the next login is still
   refused. Against a real NAS: not yet tested.
9. **Usage stops at the last interim update.** A `Mikrotik` RAS with SNMP off
   ignores a Stop's own octets, so the tail after the last update is never
   counted. It follows, though not run, that a NAS sending no interim
   updates is counted nothing at all.
   It also drops a Stop without `Acct-Terminate-Cause`, and an update in the
   same second as the one before (it divides by the seconds between).
10. **Two readings of bytes.** `report.getOnlineUsers` returns
    `[normal, voip]`; a row's `in_bytes` is `Acct-Output-Octets` (to the user)
    and `out_bytes` is `Acct-Input-Octets`, floats. `report.getInOutUsages`
    returns `[user_id, "I: <name>", in, out]` summed over closed sessions.
11. **`user.delUser` refuses an online user** (`DELETE_USER_IS_ONLINE`), so
    the driver's delete has to end the sessions first (`user.killUser`,
    F-027-ay-c; not yet probed).
12. **A user is two calls.** `user.addNewUsers` (count, credit, owner, group)
    returns the new ids, and `user.updateUserAttrs` writes the rest:
    `normal_username`, `normal_password` with `normal_generate_password=0`,
    `normal_generate_password_len=0`, `normal_save_usernames=0`, `comment`,
    and the two traffic attributes. `user.searchUser` finds one by
    `{normal_username, normal_username_op: "equals"}`.
