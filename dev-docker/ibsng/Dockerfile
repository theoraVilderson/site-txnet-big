# IBSng A1.24 — the last open-source release (SourceForge, 2008), the one
# install the ibsng driver's wire shapes are proved on (ADR-0160 decision 5,
# F-027-ay-a). Dev only: docker-compose.dev.yml, profile `ibsng`.
ARG DOCKER_REGISTRY
FROM ${DOCKER_REGISTRY}/library/python:2.7-slim-buster

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG IBSNG_URL=https://downloads.sourceforge.net/project/ibsng/IBSng-A1.24.tar.bz2
# The released tarball, pinned: a different file is a different IBSng.
ARG IBSNG_SHA256=c7117a6a2fd252aa9b8149a1ee6606f9320888da347ee4f839614bb9349d18a8

# Buster's packages live on the archive now; the proxy drops a fetch now and
# then, and a second try takes it.
RUN sed -i 's|deb.debian.org|archive.debian.org|g; /security/d; /buster-updates/d' /etc/apt/sources.list \
 && apt-get -o Acquire::Retries=5 update \
 && for i in 1 2 3 4 5; do \
      apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
        gcc libc6-dev libpq-dev curl bzip2 freeradius-utils openssh-client && break; sleep 5; done \
 && command -v radclient gcc ssh \
 && rm -rf /var/lib/apt/lists/*

# IBSng calls the classic `pg.connect` with seven positional arguments, the
# PyGreSQL 4 signature (5.0 dropped `tty`).
RUN pip install --no-cache-dir 'PyGreSQL==4.2.2'

RUN curl -fsSL -o /tmp/ibsng.tar.bz2 "$IBSNG_URL" \
 && echo "$IBSNG_SHA256  /tmp/ibsng.tar.bz2" | sha256sum -c - \
 && tar -xjf /tmp/ibsng.tar.bz2 -C /usr/local \
 && rm /tmp/ibsng.tar.bz2 \
 && find /usr/local/IBSng -name '*.py[co]' -delete \
 && mkdir -p /var/log/IBSng

COPY declare-latin1.py /tmp/
RUN python /tmp/declare-latin1.py /usr/local/IBSng && rm /tmp/declare-latin1.py

# PyGreSQL 4 reads `numeric` as Decimal, which xmlrpclib cannot send (credit,
# a charge rule's prices); the PyGreSQL 3 IBSng was written against read float.
RUN sed -i 's|^import pg$|import pg\npg.set_decimal(float)|' /usr/local/IBSng/core/db/db_pg.py \
 && grep -q 'set_decimal' /usr/local/IBSng/core/db/db_pg.py

# Its addons (the script wrapper, the MikroTik ssh_wrapper that kills a
# session on the NAS) start with #!/usr/bin/python, where a 2008 distro put it.
RUN ln -s /usr/local/bin/python /usr/bin/python

# The XML-RPC server binds loopback by default; the driver calls it from the
# network. setup.py's "Compile Configuration" step, run once at build.
RUN sed -i 's|^IBS_SERVER_IP=.*|IBS_SERVER_IP="0.0.0.0" #server bind ip address|' \
        /usr/local/IBSng/core/defs_lib/defs_defaults.py \
 && cd /usr/local/IBSng && python core/defs_lib/defs2sql.py -i core/defs_lib/defs_defaults.py db/defs.sql

COPY entrypoint.sh probe.py /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh

# 1235 XML-RPC (the driver), 1812/1813 RADIUS (a NAS).
EXPOSE 1235 1812/udp 1813/udp
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
