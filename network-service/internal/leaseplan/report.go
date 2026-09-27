package leaseplan

import (
	"bufio"
	"encoding/json"
	"io"
	"math"
	"sort"
	"time"
)

// MaxTurnGap is the longest a cut is assumed to last between two plans of one
// Grant. A longer gap is the service down or the Grant idle, and nothing is
// counted across it (`contract.lease.md` rule 14).
const MaxTurnGap = 10 * time.Minute

// Report is the shadow read back from the service's log: per Grant, the
// planner beside the live allocator (F-027-da, ADR-0093 rule 3).
type Report struct {
	Grants []GrantReport
}

// GrantReport is one Grant over every plan the log holds of it.
type GrantReport struct {
	ID          string
	Turns       int
	First, Last time.Time
	// Quota and Used are the last plan's.
	Quota, Used int64
	// Overshoot is Used past Quota at the last plan; 0 under it. It is what
	// the live ceilings let through, since only they are enforced.
	Overshoot int64
	// LiveCommitOver and PlannerCommitOver are the most each side ever
	// committed past Quota: Used plus every enabled config's room under its
	// ceiling. Negative = it never committed the whole bag.
	LiveCommitOver, PlannerCommitOver int64
	// LiveFalseCut and PlannerFalseCut are config-seconds a config could not
	// pass traffic (disabled, or its counter at its ceiling) while the Grant
	// still had bytes left.
	LiveFalseCut, PlannerFalseCut time.Duration
	// MaxDivergence is the largest Σ|want − allocated| of one plan with bytes
	// left, as a share of Quota: how far the planner's ceilings stood from
	// billing's split.
	MaxDivergence float64
	// Closed: the planner had closed the Grant at the last plan.
	Closed bool
}

type planLine struct {
	Time     time.Time     `json:"time"`
	Msg      string        `json:"msg"`
	Grant    string        `json:"grant"`
	Quota    int64         `json:"quota"`
	Used     int64         `json:"used"`
	Closed   bool          `json:"closed"`
	Replicas []ReplicaView `json:"replicas"`
}

// ReadReport reads a log stream and keeps only the `lease shadow plan` lines;
// every other line, JSON or not, is skipped.
func ReadReport(r io.Reader) (Report, error) {
	byGrant := map[string]*GrantReport{}
	type pending struct {
		at               time.Time
		liveCut, planCut int
	}
	prev := map[string]pending{}

	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024) // a plan line carries every replica
	for sc.Scan() {
		var pl planLine
		if json.Unmarshal(sc.Bytes(), &pl) != nil || pl.Msg != "lease shadow plan" || pl.Grant == "" {
			continue
		}
		g := byGrant[pl.Grant]
		if g == nil {
			g = &GrantReport{ID: pl.Grant, First: pl.Time, LiveCommitOver: math.MinInt64, PlannerCommitOver: math.MinInt64}
			byGrant[pl.Grant] = g
		}
		if p, ok := prev[pl.Grant]; ok {
			if gap := pl.Time.Sub(p.at); gap > 0 && gap <= MaxTurnGap {
				g.LiveFalseCut += gap * time.Duration(p.liveCut)
				g.PlannerFalseCut += gap * time.Duration(p.planCut)
			}
		}

		live, plan, diverge := pl.Used, pl.Used, int64(0)
		var liveCut, planCut int
		for _, v := range pl.Replicas {
			live += room(v.Counter, v.Seen, v.SeenEnabled)
			plan += room(v.Counter, v.Want, v.WantEnabled)
			if cut(v.Counter, v.Seen, v.SeenEnabled) {
				liveCut++
			}
			if cut(v.Counter, v.Want, v.WantEnabled) {
				planCut++
			}
			if v.Allocated != nil {
				diverge += abs(v.Want - *v.Allocated)
			}
		}
		if pl.Used >= pl.Quota { // a cut past the bag is the point, not a false one,
			liveCut, planCut, diverge = 0, 0, 0 // and a closed bag's split is stale
		}
		prev[pl.Grant] = pending{at: pl.Time, liveCut: liveCut, planCut: planCut}

		g.Turns++
		g.Last, g.Quota, g.Used, g.Closed = pl.Time, pl.Quota, pl.Used, pl.Closed
		g.Overshoot = max(0, pl.Used-pl.Quota)
		g.LiveCommitOver = max(g.LiveCommitOver, live-pl.Quota)
		g.PlannerCommitOver = max(g.PlannerCommitOver, plan-pl.Quota)
		if pl.Quota > 0 {
			g.MaxDivergence = max(g.MaxDivergence, float64(diverge)/float64(pl.Quota))
		}
	}
	if err := sc.Err(); err != nil {
		return Report{}, err
	}

	rep := Report{}
	for _, g := range byGrant {
		rep.Grants = append(rep.Grants, *g)
	}
	sort.Slice(rep.Grants, func(i, j int) bool { return rep.Grants[i].ID < rep.Grants[j].ID })
	return rep, nil
}

// room is what a config can still pass: nothing when disabled, the gap to its
// ceiling otherwise. A ceiling of 0 is none applied, which bounds nothing, so
// it adds no room the report can count.
func room(counter, limit int64, enabled bool) int64 {
	if !enabled || limit <= 0 {
		return 0
	}
	return max(0, limit-counter)
}

func cut(counter, limit int64, enabled bool) bool {
	return !enabled || (limit > 0 && counter >= limit)
}

func abs(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}
