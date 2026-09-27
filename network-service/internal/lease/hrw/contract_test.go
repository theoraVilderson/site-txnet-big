package hrw

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// The Go half of rendezvous placement (F-027-di). Billing places a buyer in
// TypeScript and a mover here must pick the same inbounds for it.
// `contracts/network/hrw.json` holds cases this package produced; the
// TypeScript half is billing-service/src/app/traffic/hrw.spec.ts.
const hrwFixture = "../../../../contracts/network/hrw.json"

func TestContractCases(t *testing.T) {
	raw, err := os.ReadFile(hrwFixture)
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Cases []struct {
			Name       string `json:"name"`
			Key        string `json:"key"`
			K          int    `json:"k"`
			NewUser    bool   `json:"newUser"`
			Candidates []struct {
				ID      string  `json:"id"`
				Weight  float64 `json:"weight"`
				Healthy bool    `json:"healthy"`
				Full    bool    `json:"full"`
			} `json:"candidates"`
			Want []string `json:"want"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Cases) == 0 {
		t.Fatal("no cases")
	}
	for _, c := range f.Cases {
		var cands []Candidate
		for _, x := range c.Candidates {
			cands = append(cands, Candidate{ID: x.ID, Weight: x.Weight, Healthy: x.Healthy, Full: x.Full})
		}
		if got := Pick(c.Key, cands, c.K, c.NewUser); !reflect.DeepEqual(got, c.Want) {
			t.Errorf("%s: got %v want %v", c.Name, got, c.Want)
		}
	}
}
