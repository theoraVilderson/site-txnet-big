#!/usr/bin/env sh
# Build @txnet/locale-client and push the packed tarball to every Node consumer.
# Same as `make sync-node`, for boxes without `make`.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)   # i18n-platform/
consumers="../txnet-backend ../site-pwa"

cd "$here/clients/node"
npm ci --silent
npm run build
npm pack --pack-destination /tmp --silent

tgz=$(ls -t /tmp/txnet-locale-client-*.tgz | head -1)
cd "$here"
for c in $consumers; do
  mkdir -p "$c/vendor"
  cp "$tgz" "$c/vendor/locale-client.tgz"
  echo "synced -> $c/vendor/locale-client.tgz"
  echo "  then: (cd $c && npm install)"
done
