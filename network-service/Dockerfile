# =============================================================================
# The network plane's collector (ADR-0071). Build context is this directory:
# unlike auth-handler, this module has no `replace` onto a sibling module, so
# it needs nothing from the repo root.
#
# This image publishes no Traefik router and takes no traffic from the edge.
# The process connects as `txnet_cross_tenant` and never answers a user
# request — see the compose service for why that is a property, not a setting.
# =============================================================================

# ---------- base: fetch deps ----------
ARG DOCKER_REGISTRY
FROM ${DOCKER_REGISTRY}/golang:1.27-alpine AS base
ENV GOPROXY="https://goproxy.io,direct" GOSUMDB=off GOWORK=off GOFLAGS=-mod=mod
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

# ---------- dev: live reload with air (compose bind-mounts the source) ----------
FROM base AS dev
RUN go install github.com/air-verse/air@v1.52.3
COPY . .
EXPOSE 8090
CMD ["air", "-c", ".air.toml"]

# ---------- builder: static binary ----------
FROM base AS builder
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/network-service ./cmd/server

# ---------- prod: minimal image ----------
FROM ${DOCKER_REGISTRY}/alpine:3.19 AS prod
RUN apk --no-cache add ca-certificates wget
WORKDIR /srv
COPY --from=builder /out/network-service .
ENV HTTP_PROXY="" HTTPS_PROXY="" NO_PROXY="" \
    http_proxy="" https_proxy="" no_proxy=""
EXPOSE 8090
CMD ["./network-service"]
