#!/bin/sh
# Installs IBSng into an empty database on first start, as setup.py's
# "Import Tables" and "Change System Password" steps do, then runs it in the
# foreground. The database is IBSNG_DB_* (the `ibsng-db` service).
set -eu

IBS=/usr/local/IBSng
: "${IBSNG_DB_HOST:=ibsng-db}"
: "${IBSNG_DB_USER:=ibs}"
: "${IBSNG_DB_PASSWORD:=ibsdbpass}"
: "${IBSNG_SYSTEM_PASSWORD:=txnet-dev-ibsng}"

cat > "$IBS/core/db_conf.py" <<EOF
DB_HOST="$IBSNG_DB_HOST"
DB_PORT=5432
DB_USERNAME="$IBSNG_DB_USER"
DB_PASSWORD="$IBSNG_DB_PASSWORD"
EOF

export PYTHONPATH="$IBS"
cd "$IBS"

# One python for every database step, so a quote never passes through a shell.
python - "$IBSNG_SYSTEM_PASSWORD" <<'EOF'
import sys, time, pg
from core import db_conf
for _ in range(60):
    try:
        con = pg.connect("IBSng", db_conf.DB_HOST, db_conf.DB_PORT, None, None,
                         db_conf.DB_USERNAME, db_conf.DB_PASSWORD)
        break
    except pg.InternalError:
        time.sleep(1)
else:
    sys.exit("ibsng: database never answered")

if not con.query("select 1 from pg_tables where tablename='defs'").getresult():
    # IBSng (2008) quotes with backslashes, and so does its defs.sql.
    con.query('alter database "IBSng" set standard_conforming_strings to off')
    con.query("set standard_conforming_strings to off")
    for f in ("tables", "functions", "initial", "defs"):
        con.query(open("db/%s.sql" % f).read())
    print "ibsng: tables imported"

from core.lib.password_lib import Password
con.query("update admins set password='%s' where username='system'"
          % Password(sys.argv[1]).getMd5Crypt())
con.close()
EOF

python -W ignore ibs.py
pid=$(cat /var/run/IBSng.pid)
echo "ibsng: ready (pid $pid)"
trap 'kill -TERM "$pid"; while kill -0 "$pid" 2>/dev/null; do sleep 1; done' TERM INT
while kill -0 "$pid" 2>/dev/null; do sleep 5; done
echo "ibsng: exited"
exit 1
