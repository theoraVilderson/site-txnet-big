"""The figures a move compares between the old server and the new (OPS-1-ac, H23).

Parsing and comparison only; server_move.py runs the commands that produce the text.
"""

# How a figure may differ on the target. `exact`: a database row or a byte
# cannot appear or vanish while every writer is stopped. `at_most`: a Redis key
# with a TTL and a queued message with an expiry can only expire in the
# minutes the move takes — never grow, which would mean a second writer.
EXACT = "exact"
AT_MOST = "at_most"
# All of them gone is a flush, not expiry, when the copy took minutes: sessions alone live 30 days.
SOME_LEFT = "some_left"
MOVE_RULES = {"redis:volatile": SOME_LEFT, "mq:messages": SOME_LEFT}
# A restore can come days after its bundle, so any expiring key may be gone.
RESTORE_RULES = {"redis:volatile": AT_MOST, "mq:messages": AT_MOST}

# Prints `schema.table|rows` for every base table. Run as the superuser, whom
# RLS does not filter (hosting H4).
TABLE_COUNTS_SQL = (
    "select table_schema || '.' || table_name || '|' || "
    "(xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', "
    "table_schema, table_name), false, true, '')))[1]::text "
    "from information_schema.tables where table_type = 'BASE TABLE' "
    "and table_schema not in ('pg_catalog', 'information_schema') order by 1"
)

# Every file's content hash and every symlink's target, sorted, so the same
# tree lists the same on both servers. Its exit status is xargs's: one file
# that cannot be read fails the listing instead of dropping out of it.
CONTENT_LISTING_SHELL = (
    'cd "$1" && find . -type l -printf "%p -> %l\\n" | LC_ALL=C sort '
    '&& find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum'
)
# Path, size and link target of files and symlinks — no mtime (rsync's
# sub-second precision varies by version) and no directory (its size is the
# filesystem's). For backup repositories, whose files are written once and
# never rewritten in place (pgBackRest sets and WAL, restic's content-addressed
# packs): reading 4.6 GB costs 116s of downtime (measured 2026-10-23).
METADATA_LISTING_SHELL = 'cd "$1" && find . \\( -type f -o -type l \\) -printf "%p %s %l\\n" | LC_ALL=C sort'


def parse_keyspace(info):
    """`INFO keyspace` -> keys with no TTL and keys with one, over every db."""
    persistent = volatile = 0
    for line in info.splitlines():
        if not line.startswith("db") or ":" not in line:
            continue
        fields = dict(pair.split("=", 1) for pair in line.split(":", 1)[1].split(","))
        keys, expires = int(fields["keys"]), int(fields["expires"])
        persistent += keys - expires
        volatile += expires
    return {"redis:persistent": persistent, "redis:volatile": volatile}


def parse_counts(rows):
    """TABLE_COUNTS_SQL's output -> {"pg:<schema.table>": rows}."""
    figures = {}
    for line in rows.splitlines():
        if "|" in line:
            table, count = line.rsplit("|", 1)
            figures["pg:" + table] = int(count)
    return figures


def parse_queues(rows):
    """`rabbitmqctl list_queues messages` -> the total queued."""
    return {"mq:messages": sum(int(line) for line in rows.split() if line.strip())}


def compare(source, target, rules=MOVE_RULES):
    """Every way target falls short of source, one line each; [] when it is whole.
    `rules` names the figures that may shrink; every other one is exact."""
    problems = []
    for name, expected in sorted(source.items()):
        if name not in target:
            problems.append("%s: missing on the new server" % name)
            continue
        found = target[name]
        rule = rules.get(name, EXACT)
        if rule == EXACT and found != expected:
            problems.append("%s: %s before, %s now" % (name, expected, found))
        elif rule != EXACT and (found > expected or (rule == SOME_LEFT and found == 0 < expected)):
            problems.append("%s: %s before, %s now (may only shrink by expiry)" % (name, expected, found))
    return problems
