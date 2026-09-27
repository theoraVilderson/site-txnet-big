package publish

import (
	"context"
	"encoding/json"
	"os"
	"sort"
	"strconv"
	"testing"
	"time"

	"network-service/internal/leaseplan"
)

// The Go half of the block request wire (F-027-dc, ADR-0036, C-08). The
// TypeScript half is billing-service's `block-request.spec.ts`; both read
// `contracts/network/block-request.json`, and the reserve Go adds to Quota
// is held to the same figures billing prices a block with.

const blockFixturePath = "../../../contracts/network/block-request.json"

type blockFixture struct {
	Version     int `json:"version"`
	RoutingKeys struct {
		Prefix       string `json:"prefix"`
		BlockRequest string `json:"blockRequest"`
	} `json:"routingKeys"`
	Message    []declaredField `json:"message"`
	Affordable []struct {
		Rate    string `json:"rate"`
		Balance string `json:"balance"`
		Bytes   string `json:"bytes"`
	} `json:"affordable"`
}

func loadBlockFixture(t *testing.T) blockFixture {
	t.Helper()
	raw, err := os.ReadFile(blockFixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var f blockFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestBlockRequestMatchesTheFixture(t *testing.T) {
	f := loadBlockFixture(t)
	if f.RoutingKeys.BlockRequest != BlockRequestRoutingKey || f.Version != BlockRequestMessageVersion {
		t.Fatalf("fixture says %s v%d, Go publishes %s v%d", f.RoutingKeys.BlockRequest, f.Version,
			BlockRequestRoutingKey, BlockRequestMessageVersion)
	}
	if len(BlockRequestRoutingKey) <= len(f.RoutingKeys.Prefix) || BlockRequestRoutingKey[:len(f.RoutingKeys.Prefix)] != f.RoutingKeys.Prefix {
		t.Fatalf("%s is not under %s", BlockRequestRoutingKey, f.RoutingKeys.Prefix)
	}

	rec := &recordingTransport{}
	at := time.Date(2026, 9, 27, 10, 0, 0, 0, time.UTC)
	req := leaseplan.BlockRequest{GrantID: "4b0c7d1e-2f3a-4b5c-8d6e-7f8091a2b3c4", PurchasedBytes: 1 << 30,
		TargetBytes: 2_250_000_000, RateBps: 100_000_000, RequestedAt: at}
	if err := (BlockRequests{Transport: rec}).RequestBlock(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if len(rec.sent) != 1 || rec.sent[0].routingKey != BlockRequestRoutingKey {
		t.Fatalf("want one message under %s, got %+v", BlockRequestRoutingKey, rec.sent)
	}
	var got map[string]any
	if err := json.Unmarshal(rec.sent[0].body, &got); err != nil {
		t.Fatal(err)
	}
	var keys, want []string
	for k := range got {
		keys = append(keys, k)
	}
	for _, field := range f.Message {
		want = append(want, field.Name)
		if field.Type == "bytes" {
			if _, ok := got[field.Name].(string); !ok {
				t.Errorf("%s is bytes: a decimal string, got %T", field.Name, got[field.Name])
			}
		}
	}
	sort.Strings(keys)
	sort.Strings(want)
	if len(keys) != len(want) {
		t.Fatalf("fields %v, fixture declares %v", keys, want)
	}
	for i := range keys {
		if keys[i] != want[i] {
			t.Fatalf("fields %v, fixture declares %v", keys, want)
		}
	}
	again := &recordingTransport{}
	_ = (BlockRequests{Transport: again}).RequestBlock(context.Background(), req)
	if again.sent[0].messageID != rec.sent[0].messageID {
		t.Fatal("one request republished must carry one message id")
	}
}

func TestTheReserveIsComputedToTheFixturesFigures(t *testing.T) {
	for _, row := range loadBlockFixture(t).Affordable {
		want, _ := strconv.ParseInt(row.Bytes, 10, 64)
		if got := leaseplan.BytesAffordable(row.Rate, row.Balance); got != want {
			t.Errorf("BytesAffordable(%s, %s) = %d, fixture says %d", row.Rate, row.Balance, got, want)
		}
	}
}
