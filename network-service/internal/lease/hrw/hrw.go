// Package hrw picks which K inbounds of a group a user gets, using weighted
// rendezvous hashing: deterministic (no stored mapping needed), minimal
// movement (adding/removing one inbound moves ~1/N users), weight-aware.
//
// Mode "split"      = K=1
// Mode "replicate"  = K=N
// Anything between  = K of N (recommended K=2 for resilience).
package hrw

import (
	"encoding/binary"
	"hash/fnv"
	"math"
	"sort"
)

type Candidate struct {
	ID      string
	Weight  float64 // capacity share, e.g. server bandwidth
	Healthy bool
	Full    bool // at its client cap: skip for NEW assignments only
}

func score(key, id string, w float64) float64 {
	h := fnv.New64a()
	h.Write([]byte(key))
	h.Write([]byte{0})
	h.Write([]byte(id))
	x := mix(h.Sum64())
	u := (float64(x>>11) + 0.5) / float64(1<<53) // (0,1)
	if w <= 0 {
		w = 1
	}
	return -w / math.Log(u)
}

// splitmix64 finaliser: fnv alone mixes poorly in the high bits.
func mix(z uint64) uint64 {
	z += 0x9e3779b97f4a7c15
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	return z ^ (z >> 31)
}

// Pick returns up to k candidate IDs for key (user id), best first.
// newUser=true skips Full candidates; existing users keep their inbound even
// if it is full (never move people just because others joined).
func Pick(key string, cands []Candidate, k int, newUser bool) []string {
	type sc struct {
		id string
		s  float64
	}
	var all []sc
	for _, c := range cands {
		if !c.Healthy || (newUser && c.Full) {
			continue
		}
		all = append(all, sc{c.ID, score(key, c.ID, c.Weight)})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].s > all[j].s })
	if k > len(all) {
		k = len(all)
	}
	out := make([]string, k)
	for i := range out {
		out[i] = all[i].id
	}
	return out
}

// PickTwoChoices: for a NEW user with K=1, take the two best HRW candidates
// and return the less loaded one (power of two choices). load[id] is e.g.
// active clients / weight.
func PickTwoChoices(key string, cands []Candidate, load map[string]float64) string {
	top := Pick(key, cands, 2, true)
	switch len(top) {
	case 0:
		return ""
	case 1:
		return top[0]
	}
	if load[top[1]] < load[top[0]] {
		return top[1]
	}
	return top[0]
}

// Seed is handy for tests needing a numeric id.
func Seed(id uint64) string {
	var b [8]byte
	binary.LittleEndian.PutUint64(b[:], id)
	return string(b[:])
}
