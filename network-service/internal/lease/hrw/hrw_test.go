package hrw

import (
	"fmt"
	"testing"
)

func TestMinimalMovementAndBalance(t *testing.T) {
	var cands []Candidate
	for i := 0; i < 10; i++ {
		cands = append(cands, Candidate{ID: fmt.Sprintf("in%d", i), Weight: 1, Healthy: true})
	}
	const users = 20000
	before := map[string]string{}
	count := map[string]int{}
	for u := 0; u < users; u++ {
		k := fmt.Sprintf("user-%d", u)
		p := Pick(k, cands, 1, false)[0]
		before[k] = p
		count[p]++
	}
	for id, c := range count {
		if c < users/10*85/100 || c > users/10*115/100 {
			t.Errorf("unbalanced %s: %d", id, c)
		}
	}
	// remove in3: only its users may move
	cands[3].Healthy = false
	moved := 0
	for k, old := range before {
		now := Pick(k, cands, 1, false)[0]
		if now != old {
			if old != "in3" {
				t.Fatalf("user %s moved from healthy %s", k, old)
			}
			moved++
		}
	}
	if moved != count["in3"] {
		t.Fatalf("moved %d want %d", moved, count["in3"])
	}
}

func TestWeights(t *testing.T) {
	cands := []Candidate{{ID: "a", Weight: 3, Healthy: true}, {ID: "b", Weight: 1, Healthy: true}}
	n := map[string]int{}
	for u := 0; u < 40000; u++ {
		n[Pick(fmt.Sprint(u), cands, 1, false)[0]]++
	}
	r := float64(n["a"]) / float64(n["b"])
	if r < 2.7 || r > 3.3 {
		t.Fatalf("weight ratio %.2f", r)
	}
}
