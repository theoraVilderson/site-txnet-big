# object-backup (F-414-m, ADR-0120): restic from Alpine's package — the
# registry mirror serves no restic image of its own.
ARG DOCKER_REGISTRY
FROM ${DOCKER_REGISTRY}/alpine:latest
RUN apk add --no-cache restic ca-certificates
COPY object-backup.sh /usr/local/bin/object-backup.sh
ENTRYPOINT ["/bin/sh", "/usr/local/bin/object-backup.sh"]
