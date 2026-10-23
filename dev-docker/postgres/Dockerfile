# main-db (OPS-1-a, ADR-0126, hosting/contract.md H1): the stock Postgres image
# plus pgBackRest, so every WAL segment is archived the moment it closes.
# The pg-backup container (H3) runs this same image with its own entrypoint.
ARG DOCKER_REGISTRY
FROM ${DOCKER_REGISTRY}/postgres:18-alpine
# APK_MIRROR (.env): an Alpine mirror every server we build on reaches; dl-cdn
# stalls mid-TLS from Iranian datacenters (OPS-1-af). Empty keeps dl-cdn.
ARG APK_MIRROR
RUN if [ -n "$APK_MIRROR" ]; then sed -i "s#https\?://dl-cdn.alpinelinux.org/alpine#$APK_MIRROR#" /etc/apk/repositories; fi \
 && apk add --no-cache pgbackrest
COPY pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
COPY pgbackrest-repo.sh /usr/local/bin/pgbackrest-repo.sh
COPY entrypoint.sh /usr/local/bin/txnet-postgres-entrypoint.sh
COPY pg-backup.sh /usr/local/bin/pg-backup.sh
ENTRYPOINT ["/bin/sh", "/usr/local/bin/txnet-postgres-entrypoint.sh"]
# Setting ENTRYPOINT clears the base image's CMD, so it is restated.
CMD ["postgres"]
