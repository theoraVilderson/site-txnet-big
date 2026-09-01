// Reference module. Services do NOT import this — they vendor a copy of this
// directory (see i18n-platform/README.md → "Vendoring the Go client"). Keeping a
// go.mod here just lets `go build ./...` / `go vet ./...` check the canonical
// source in isolation.
module github.com/txnet/i18n-platform/clients/go

go 1.22

require (
	google.golang.org/grpc v1.67.1
	google.golang.org/protobuf v1.35.1
)

require (
	golang.org/x/net v0.28.0 // indirect
	golang.org/x/sys v0.24.0 // indirect
	golang.org/x/text v0.17.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20240814211410-ddb44dafa142 // indirect
)
