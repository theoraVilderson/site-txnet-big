# Every base comes through ${DOCKER_REGISTRY}, like every other image here: a
# server built from Iran reaches neither Docker Hub nor gcr.io directly
# (OPS-1-ad's restore test, 2026-10-23, stopped on gcr.io/distroless).

# build
ARG DOCKER_REGISTRY
FROM ${DOCKER_REGISTRY}/golang:1.27-alpine AS build
ENV GOPROXY="https://goproxy.io,direct" GOSUMDB=off GOWORK=off GOFLAGS=-mod=mod
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/locale-service ./cmd/server
# uid/gid 65532 is distroless's `nonroot`, which owns every locales_runtime
# volume already written: the same number keeps them writable.
RUN mkdir -p /out/locales-runtime \
 && echo 'nonroot:x:65532:65532:nonroot:/nonexistent:/sbin/nologin' > /out/passwd \
 && echo 'nonroot:x:65532:' > /out/group

# run: scratch — the binary is static (CGO_ENABLED=0), opens no TLS connection
# and reads no time zone, and writes its temp files beside their targets; what
# distroless added was the nonroot user, copied in here.
FROM scratch
COPY --from=build /out/passwd /etc/passwd
COPY --from=build /out/group /etc/group
COPY --from=build /out/locale-service /usr/local/bin/locale-service
# Mount or COPY the repo's locales/ tree here.
ENV LOCALES_DIR=/locales
# The writable overlay (F-1533-b). Owned by nonroot so a fresh named volume
# mounted here inherits a directory the service can write; unset
# LOCALES_RUNTIME_DIR to run read-only.
COPY --from=build --chown=nonroot:nonroot /out/locales-runtime /locales-runtime
ENV GRPC_ADDR=:50051
EXPOSE 50051
USER nonroot:nonroot
# `locale-service -healthcheck` dials its own grpc.health.v1 endpoint (no probe binary).
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
  CMD ["/usr/local/bin/locale-service", "-healthcheck"]
ENTRYPOINT ["/usr/local/bin/locale-service"]
