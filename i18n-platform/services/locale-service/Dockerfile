# build
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/locale-service ./cmd/server
RUN mkdir -p /out/locales-runtime

# run
FROM gcr.io/distroless/static-debian12:nonroot
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
