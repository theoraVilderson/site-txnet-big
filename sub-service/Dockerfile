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
ENV GOPROXY="https://goproxy.io,direct" GOSUMDB=off GOWORK=off GOFLAGS=-mod=mod
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
RUN apk --no-cache add ca-certificates wget
WORKDIR /srv
COPY --from=builder /out/sub-service .
ENV HTTP_PROXY="" HTTPS_PROXY="" NO_PROXY="" \
    http_proxy="" https_proxy="" no_proxy=""
EXPOSE 8091
CMD ["./sub-service"]
