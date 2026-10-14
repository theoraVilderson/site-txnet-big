#!/bin/sh
# main-db's entrypoint (OPS-1-a): settle pgBackRest's repository first, so the
# first archive_command already has somewhere to push, then hand over to the
# stock entrypoint unchanged.
set -eu
sh /usr/local/bin/pgbackrest-repo.sh
exec docker-entrypoint.sh "$@"
