# Loads /bundle/dump.rdb into /data as the AOF memory-data starts from, and
# prints the keyspace it holds (OPS-1-ad). Run in a throwaway container of
# memory-data's own image: by a bundle on scratch storage, which proves every
# bundle's Redis loads; by a restore on memory-data's volume.
# memory-data runs with --appendonly yes, so an RDB alone in its volume would
# be ignored at start: the AOF is written here, from the loaded keys.
set -e
# Ten minutes at 0.2s a try: a full 768 MB keyspace loads in well under that.
TRIES=3000
rm -rf /data/appendonlydir /data/dump.rdb
cp /bundle/dump.rdb /data/dump.rdb
redis-server --dir /data --dbfilename dump.rdb --appendonly no --save "" --port 6399 --daemonize yes \
  --logfile /tmp/r.log --pidfile /tmp/r.pid

# Gives up when the server has died (a short read, an OOM) or the tries run out,
# with its log: a server that aborted loading once left this waiting forever.
wait_for() {
  tries=0
  until "$@"; do
    tries=$((tries + 1))
    if [ "$tries" -gt "$TRIES" ] || { [ -s /tmp/r.pid ] && ! kill -0 "$(cat /tmp/r.pid)" 2>/dev/null; }; then
      tail -5 /tmp/r.log >&2
      exit 1
    fi
    sleep 0.2
  done
}
answers() { [ "$(redis-cli -p 6399 ping 2>/dev/null)" = PONG ]; }
aof_written() {
  redis-cli -p 6399 info persistence | tr -d '\r' | grep -qx 'aof_rewrite_in_progress:0' \
    && redis-cli -p 6399 info persistence | tr -d '\r' | grep -qx 'aof_rewrite_scheduled:0' \
    && redis-cli -p 6399 info persistence | tr -d '\r' | grep -qx 'aof_enabled:1' \
    && [ -n "$(ls /data/appendonlydir 2>/dev/null)" ]
}
wait_for answers
redis-cli -p 6399 config set appendonly yes >/dev/null
wait_for aof_written
redis-cli -p 6399 info persistence | tr -d '\r' | grep -x 'aof_last_bgrewrite_status:ok' >/dev/null
redis-cli -p 6399 info keyspace
redis-cli -p 6399 shutdown nosave >/dev/null 2>&1 || true
rm -f /data/dump.rdb
chown -R redis:redis /data
