package main

import "testing"

// OPS-1-aj (2026-10-29): the healthcheck dialled "localhost:50052" through
// grpc's DNS resolver, which also asks `_grpc_config.localhost` (TXT) of the
// cluster's DNS and, past the search list, of the upstream one. With no
// upstream — staging, or a national internet (ADR-0165) — that took 7s, the 3s
// probe failed and the kubelet killed a healthy server. Its own loopback needs
// no resolver at all.
func TestDialTargetIsTheLoopbackWithNoResolver(t *testing.T) {
	for addr, want := range map[string]string{
		":50052":          "passthrough:///127.0.0.1:50052",
		"0.0.0.0:50052":   "passthrough:///127.0.0.1:50052",
		"127.0.0.1:50052": "passthrough:///127.0.0.1:50052",
	} {
		if got := dialTarget(addr); got != want {
			t.Errorf("dialTarget(%q) = %q, want %q", addr, got, want)
		}
	}
}
