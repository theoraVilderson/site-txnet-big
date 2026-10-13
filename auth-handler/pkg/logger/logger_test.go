package logger

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"testing"
)

// H13 (hosting/contract.md): a line logged with a request's context names the
// request, under the key the Node services use, so one Loki query by
// `requestId` reads the gate and the services behind it.
func TestALineLoggedWithARequestNamesIt(t *testing.T) {
	var out bytes.Buffer
	log := newLogger(&out, slog.LevelInfo)

	log.InfoContext(WithRequestID(context.Background(), "trace-0001"), "token validation failed", "path", "/api")
	log.InfoContext(context.Background(), "boot")
	log.With("component", "gate").InfoContext(WithRequestID(context.Background(), "trace-0002"), "derived")

	lines := bytes.Split(bytes.TrimSpace(out.Bytes()), []byte("\n"))
	if len(lines) != 3 {
		t.Fatalf("want 3 lines, got %d: %s", len(lines), out.String())
	}
	var first, second, third map[string]any
	for i, dst := range []*map[string]any{&first, &second, &third} {
		if err := json.Unmarshal(lines[i], dst); err != nil {
			t.Fatalf("line %d is not JSON: %v", i, err)
		}
	}
	if first["requestId"] != "trace-0001" || first["msg"] != "token validation failed" {
		t.Errorf("first line = %v, want requestId trace-0001", first)
	}
	if _, has := second["requestId"]; has {
		t.Errorf("a line outside a request names one: %v", second)
	}
	if third["requestId"] != "trace-0002" || third["component"] != "gate" {
		t.Errorf("a derived logger lost the request: %v", third)
	}
}
