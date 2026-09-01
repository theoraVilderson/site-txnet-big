# i18n-platform — code generation & sync helpers.
#
# Requires: protoc, protoc-gen-go, protoc-gen-go-grpc, go, node.
#   go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
#   go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest

PROTO        := proto/locale/v1/locale.proto
SVC_PBDIR    := services/locale-service/internal/localev1
CLIENT_PBDIR := clients/go/localev1

.PHONY: proto proto-go proto-fanout sync-node tidy run-service clean

# ---------------------------------------------------------------------------
# Go client — a real shared module. Consumers import
#   github.com/txnet/i18n-platform/clients/go
# resolved locally via the repo-root go.work (dev) / a `replace` directive
# (Docker). NOTHING is copied. `make proto` just regenerates the stubs in the
# two Go modules that physically own generated code.
# ---------------------------------------------------------------------------
proto: proto-go proto-fanout ## regenerate the gRPC stubs

proto-go:
	protoc --proto_path=proto \
	  --go_out=. --go_opt=module=github.com/txnet/i18n-platform/services/locale-service \
	  --go-grpc_out=. --go-grpc_opt=module=github.com/txnet/i18n-platform/services/locale-service \
	  $(PROTO)
	gofmt -w $(SVC_PBDIR)

proto-fanout:
	cp $(SVC_PBDIR)/*.go $(CLIENT_PBDIR)/
	# Node client loads proto/locale/v1/locale.proto from an inline string —
	# keep clients/node/proto.ts in sync by hand when the contract changes,
	# then run `make sync-node`.
	cp proto/locale/v1/locale.proto clients/node/locale.proto

# ---------------------------------------------------------------------------
# Node client — @txnet/locale-client. Source of truth is clients/node/.
# It ships COMPILED (dist/) and is consumed as a packed tarball so every tool
# (turbopack, webpack, Nx, tsc) resolves it as a normal package with zero
# per-consumer config. `make sync-node` after ANY edit to client.ts/proto.ts.
# ---------------------------------------------------------------------------
sync-node: ## build @txnet/locale-client and push the tarball to every Node consumer
	sh scripts/sync-node.sh

tidy:
	cd services/locale-service && go mod tidy
	cd clients/go && go mod tidy

run-service: ## run locale-service against the repo's locales/ dir
	cd services/locale-service && LOCALES_DIR=../../../locales GRPC_ADDR=:50051 go run ./cmd/server

clean:
	rm -f clients/go/example/example services/locale-service/locale-service
