# main-db (OPS-1-a, ADR-0126, hosting/contract.md H1): the stock Postgres image
# plus pgBackRest, so every WAL segment is archived the moment it closes.
# The pg-backup container (H3) runs this same image with its own entrypoint.
ARG DOCKER_REGISTRY
FROM ${DOCKER_REGISTRY}/postgres:18-alpine
RUN apk add --no-cache pgbackrest
COPY pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
COPY pgbackrest-repo.sh /usr/local/bin/pgbackrest-repo.sh
COPY entrypoint.sh /usr/local/bin/txnet-postgres-entrypoint.sh
COPY pg-backup.sh /usr/local/bin/pg-backup.sh
ENTRYPOINT ["/bin/sh", "/usr/local/bin/txnet-postgres-entrypoint.sh"]
# Setting ENTRYPOINT clears the base image's CMD, so it is restated.
CMD ["postgres"]
