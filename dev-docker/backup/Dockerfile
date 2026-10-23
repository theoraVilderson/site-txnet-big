# object-backup (F-414-m, ADR-0120): restic from Alpine's package — the
# registry mirror serves no restic image of its own.
ARG DOCKER_REGISTRY
FROM ${DOCKER_REGISTRY}/alpine:latest
# APK_MIRROR (.env): an Alpine mirror every server we build on reaches; dl-cdn
# stalls mid-TLS from Iranian datacenters (OPS-1-af). Empty keeps dl-cdn.
ARG APK_MIRROR
RUN if [ -n "$APK_MIRROR" ]; then sed -i "s#https\?://dl-cdn.alpinelinux.org/alpine#$APK_MIRROR#" /etc/apk/repositories; fi \
 && apk add --no-cache restic ca-certificates
COPY object-backup.sh /usr/local/bin/object-backup.sh
ENTRYPOINT ["/bin/sh", "/usr/local/bin/object-backup.sh"]
