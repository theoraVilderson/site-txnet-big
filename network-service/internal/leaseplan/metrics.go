package leaseplan

import (
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Metrics are the planner's two counters that exist only in this process
// (SPEC §10, F-027-dm): the writes it plans, by panel and `Action.Reason`,
// and the config-seconds a config was cut while its Grant still had bytes.
// Everything else §10 asks for is already on a row — lag and the tick clock
// on `network.panel`, the close on `network.lease_close` — and is read by
// postgres-exporter through `network.planner_panels()` and
// `network.planner_overshoot()`, so it stays readable while this process is
// down. A restart zeroes these two; Prometheus' `increase()` reads that as a
// reset, not a drop. The zero value is ready; a nil Metrics records nothing.
type Metrics struct {
	mu       sync.Mutex
	writes   map[writeKey]uint64
	falseCut map[string]float64 // by panel id, in seconds
}

type writeKey struct{ panel, reason string }

// cutState is one Grant's last plan, for the next plan's false-cut interval:
// when it ran and the panel of every config it found cut.
type cutState struct {
	at     time.Time
	panels []string
}

func (m *Metrics) wrote(panel, reason string) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.writes == nil {
		m.writes = map[writeKey]uint64{}
	}
	m.writes[writeKey{panel, reason}]++
}

func (m *Metrics) cutFor(panels []string, d time.Duration) {
	if m == nil || len(panels) == 0 || d <= 0 {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.falseCut == nil {
		m.falseCut = map[string]float64{}
	}
	for _, p := range panels {
		m.falseCut[p] += d.Seconds()
	}
}

// record counts one plan: its writes, and the false cut its Grant carried
// since its previous plan. The cut is judged the way the shadow report judges
// the live side (`cut`, `ReadReport`): a config disabled or at the ceiling its
// panel enforces, while the Grant is open with bytes left. A gap past
// MaxTurnGap is the service down or the Grant idle, and counts nothing.
func (s *Planner) record(pl Plan, at time.Time) {
	if s.Metrics == nil {
		return
	}
	for _, a := range pl.Actions {
		s.Metrics.wrote(a.PanelID, a.Reason)
	}
	if prev, ok := s.cuts[pl.GrantID]; ok {
		if gap := at.Sub(prev.at); gap <= MaxTurnGap {
			s.Metrics.cutFor(prev.panels, gap)
		}
	}
	var panels []string
	if !pl.Closed && pl.Used < pl.Quota {
		for _, v := range pl.Replicas {
			if cut(v.Counter, v.Seen, v.SeenEnabled) {
				panels = append(panels, v.Panel)
			}
		}
	}
	s.cuts[pl.GrantID] = cutState{at: at, panels: panels}
}

const (
	writesName   = "network_planner_writes_total"
	falseCutName = "network_planner_false_cut_seconds_total"
)

// WriteTo writes both counters in the Prometheus text format, series sorted
// so two scrapes of the same state are the same bytes.
func (m *Metrics) WriteTo(w io.Writer) (int64, error) {
	if m == nil {
		return 0, nil
	}
	m.mu.Lock()
	var b strings.Builder
	fmt.Fprintf(&b, "# HELP %s Ceiling writes the lease planner planned, by panel and Action.Reason.\n# TYPE %s counter\n", writesName, writesName)
	keys := make([]writeKey, 0, len(m.writes))
	for k := range m.writes {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].panel != keys[j].panel {
			return keys[i].panel < keys[j].panel
		}
		return keys[i].reason < keys[j].reason
	})
	for _, k := range keys {
		fmt.Fprintf(&b, "%s{panel=%s,reason=%s} %d\n", writesName, quoteLabel(k.panel), quoteLabel(k.reason), m.writes[k])
	}
	fmt.Fprintf(&b, "# HELP %s Config-seconds a config was cut (disabled or at its panel's ceiling) while its Grant was open with bytes left, by panel.\n# TYPE %s counter\n", falseCutName, falseCutName)
	panels := make([]string, 0, len(m.falseCut))
	for p := range m.falseCut {
		panels = append(panels, p)
	}
	sort.Strings(panels)
	for _, p := range panels {
		fmt.Fprintf(&b, "%s{panel=%s} %s\n", falseCutName, quoteLabel(p), strconv.FormatFloat(m.falseCut[p], 'g', -1, 64))
	}
	m.mu.Unlock()
	n, err := io.WriteString(w, b.String())
	return int64(n), err
}

// quoteLabel is a label value as the text format wants it: quoted, with
// backslash, quote and newline escaped.
func quoteLabel(v string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`).Replace(v) + `"`
}
