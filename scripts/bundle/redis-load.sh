# Loads /bundle/dump.rdb into /data as the AOF memory-data starts from, and
# prints the keyspace it holds (OPS-1-ad). Run in a throwaway container of
# memory-data's own image: by a bundle on scratch storage, which proves every
# bundle's Redis loads; by a restore on memory-data's volume.
# memory-data runs with --appendonly yes, so an RDB alone in its volume would
# be ignored at start: the AOF is written here, from the loaded keys.
set -e
rm -rf /data/appendonlydir /data/dump.rdb
cp /bundle/dump.rdb /data/dump.rdb
redis-server --dir /data --dbfilename dump.rdb --appendonly no --save "" --port 6399 --daemonize yes --logfile /tmp/r.log
until [ "$(redis-cli -p 6399 ping 2>/dev/null)" = PONG ]; do sleep 0.2; done
redis-cli -p 6399 config set appendonly yes >/dev/null
until redis-cli -p 6399 info persistence | tr -d '\r' | grep -qx 'aof_rewrite_in_progress:0' \
   && redis-cli -p 6399 info persistence | tr -d '\r' | grep -qx 'aof_rewrite_scheduled:0' \
   && redis-cli -p 6399 info persistence | tr -d '\r' | grep -qx 'aof_enabled:1' \
   && [ -n "$(ls /data/appendonlydir 2>/dev/null)" ]; do sleep 0.2; done
redis-cli -p 6399 info persistence | tr -d '\r' | grep -x 'aof_last_bgrewrite_status:ok' >/dev/null
redis-cli -p 6399 info keyspace
redis-cli -p 6399 shutdown nosave >/dev/null 2>&1 || true
rm -f /data/dump.rdb
chown -R redis:redis /data
