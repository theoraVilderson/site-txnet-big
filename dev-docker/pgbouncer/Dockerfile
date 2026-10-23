# db-pool (OPS-1-h, ADR-0126, hosting/contract.md H7): PgBouncer in transaction
# mode in front of main-db, so a hundred service replicas share 25 server
# connections per role instead of holding their own. Alpine's package is the
# upstream release (1.25 on 3.24); no PgBouncer image of our own to maintain.
ARG DOCKER_REGISTRY
FROM ${DOCKER_REGISTRY}/alpine:latest
# postgresql-client for the pg_isready healthcheck; su-exec because PgBouncer
# refuses to run as root and the entrypoint must write the tmpfs first.
# The package creates no user of its own, so the image does.
# APK_MIRROR (.env): an Alpine mirror every server we build on reaches; dl-cdn
# stalls mid-TLS from Iranian datacenters (OPS-1-af). Empty keeps dl-cdn.
ARG APK_MIRROR
RUN if [ -n "$APK_MIRROR" ]; then sed -i "s#https\?://dl-cdn.alpinelinux.org/alpine#$APK_MIRROR#" /etc/apk/repositories; fi \
 && apk add --no-cache pgbouncer postgresql-client su-exec \
 && addgroup -S pgbouncer && adduser -S -D -H -G pgbouncer pgbouncer
COPY entrypoint.sh /usr/local/bin/db-pool-entrypoint.sh
EXPOSE 6432
ENTRYPOINT ["/bin/sh", "/usr/local/bin/db-pool-entrypoint.sh"]
