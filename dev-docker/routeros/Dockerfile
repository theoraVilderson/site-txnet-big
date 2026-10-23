# routeros-chr (F-1601-e, ADR-0160 decision 9): a real RouterOS v7 with User
# Manager, so the usermanager driver's wire shapes are proved on a router and
# not only on the RouterOS documentation. Dev only — docker-compose.dev.yml,
# profile `routeros`; prod never runs it.
#
# The CHR is a VM image, so it runs under qemu. This host has no /dev/kvm, so
# qemu emulates (TCG): a boot takes a minute or two, the REST API answers in
# tens of milliseconds after that, which is all the probes need.
#
# The registry mirror has no qemu or RouterOS image, so this is Alpine + apk
# (the object-backup pattern). The CHR image and the User Manager package are
# fetched here, at build, through the host's proxy (HTTP(S)_PROXY build args,
# which Docker never writes into the image).
ARG DOCKER_REGISTRY
FROM ${DOCKER_REGISTRY}/alpine:latest
ARG ROUTEROS_VERSION
RUN apk add --no-cache qemu-system-x86_64 curl unzip busybox-extras freeradius freeradius-utils openvpn jq \
 && mkdir -p /opt/routeros \
 && curl -fsSL -o /tmp/chr.zip "https://download.mikrotik.com/routeros/${ROUTEROS_VERSION}/chr-${ROUTEROS_VERSION}.img.zip" \
 && unzip -p /tmp/chr.zip > /opt/routeros/chr.img && rm /tmp/chr.zip \
 && curl -fsSL -o "/opt/routeros/user-manager-${ROUTEROS_VERSION}.npk" \
      "https://download.mikrotik.com/routeros/${ROUTEROS_VERSION}/user-manager-${ROUTEROS_VERSION}.npk"
ENV ROUTEROS_VERSION=${ROUTEROS_VERSION}
COPY chr.sh bootstrap.sh probe.sh nas.sh /usr/local/bin/
COPY acct-probe.conf /etc/raddb/acct-probe.conf
ENTRYPOINT ["/bin/sh", "/usr/local/bin/chr.sh"]
