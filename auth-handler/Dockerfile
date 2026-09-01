# =============================================================================
# Build context is the REPO ROOT (so the shared Go module
# i18n-platform/clients/go is reachable). In compose:
#   build: { context: .., dockerfile: auth-handler/Dockerfile }
# GOWORK=off → the repo's go.work is ignored inside the image; the
# `replace` directive in auth-handler/go.mod resolves the shared module
# from ./i18n-platform/clients/go instead.
# =============================================================================

# ---------- base: fetch deps ----------
ARG DOCKER_REGISTRY
FROM ${DOCKER_REGISTRY}/golang:1.22-alpine AS base
ENV GOPROXY="https://goproxy.io,direct" GOSUMDB=off GOWORK=off GOFLAGS=-mod=mod
WORKDIR /src
COPY auth-handler/go.mod auth-handler/go.sum ./auth-handler/
COPY i18n-platform/clients/go/ ./i18n-platform/clients/go/
WORKDIR /src/auth-handler
RUN go mod download

# ---------- dev: live reload with air (compose bind-mounts the source) ----------
FROM base AS dev
RUN go install github.com/air-verse/air@v1.52.3
COPY auth-handler/ ./
ENV LOCALE_SERVICE_ADDR=locale-service:50051 LOCALE_SCOPE=backend
EXPOSE 8080
CMD ["air", "-c", ".air.toml"]

# ---------- builder: static binary ----------
FROM base AS builder
COPY auth-handler/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/auth-handler ./cmd/server

# ---------- prod: minimal image ----------
FROM ${DOCKER_REGISTRY}/alpine:3.19 AS prod
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=builder /out/auth-handler .
COPY --from=builder /src/auth-handler/configs ./configs
ENV HTTP_PROXY="" HTTPS_PROXY="" NO_PROXY="" \
    http_proxy="" https_proxy="" no_proxy=""
ENV LOCALE_SERVICE_ADDR=locale-service:50051 LOCALE_SCOPE=backend
EXPOSE 8080
CMD ["./auth-handler"]
