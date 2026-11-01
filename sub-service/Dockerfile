# =============================================================================
# sub-service: `GET /sub/{token}` (ADR-0082). Build context is this directory;
# the module has no `replace` onto a sibling, so it needs nothing from the root.
#
# Unlike network-service this image *is* routed (`PathPrefix(/sub/)`, see the
# compose service). It connects read-only as `txnet_cross_tenant`.
# =============================================================================

# ---------- base: fetch deps ----------
ARG DOCKER_REGISTRY
FROM ${DOCKER_REGISTRY}/golang:1.27-alpine AS base
# PKG_MIRROR (mirrors.env, ADR-0170): the package mirror's go repo first, so a build in an
# outage needs nothing abroad; empty keeps goproxy.io alone.
ARG PKG_MIRROR
ENV GOPROXY="${PKG_MIRROR:+${PKG_MIRROR}/go/,}https://goproxy.io,direct" GOSUMDB=off GOWORK=off GOFLAGS=-mod=mod
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

# ---------- dev: live reload with air (compose bind-mounts the source) ----------
FROM base AS dev
RUN go install github.com/air-verse/air@v1.52.3
COPY . .
EXPOSE 8091
CMD ["air", "-c", ".air.toml"]

# ---------- builder: static binary ----------
FROM base AS builder
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/sub-service ./cmd/server

# ---------- prod: minimal image ----------
FROM ${DOCKER_REGISTRY}/alpine:3.19 AS prod
# APK_MIRROR (mirrors.env, ADR-0170): Alpine's packages, from inside Iran when it is set.
ARG APK_MIRROR
RUN if [ -n "$APK_MIRROR" ]; then sed -i "s#https\?://dl-cdn.alpinelinux.org/alpine#$APK_MIRROR#" /etc/apk/repositories; fi \
 && apk --no-cache add ca-certificates wget
# compose's `working_dir`, where dev mounts the source; `./sub-service` runs from here (K8).
WORKDIR /src
COPY --from=builder /out/sub-service .
ENV HTTP_PROXY="" HTTPS_PROXY="" NO_PROXY="" \
    http_proxy="" https_proxy="" no_proxy=""
EXPOSE 8091
CMD ["./sub-service"]
