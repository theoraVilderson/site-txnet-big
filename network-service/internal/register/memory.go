package register

import (
	"context"
	"sort"
	"sync"
	"time"

	"network-service/internal/driver"
)

// Record is one panel's registration state, as `network.panel` holds it.
type Record struct {
	Pending
	ReviewState driver.ReviewState
	// Capabilities is nil until a verdict is written.
	Capabilities *driver.Capabilities
	TestedAt     time.Time
	Fault        FaultKind
	Detail       string
}

// MemoryStore holds registration state in memory. It is what the pass is
// proved against, until the Postgres-backed Store lands with the panel source.
type MemoryStore struct {
	mu   sync.Mutex
	rows map[string]*Record
}

func NewMemoryStore() *MemoryStore { return &MemoryStore{rows: map[string]*Record{}} }

// Put registers a panel as `pending` — what `billing-service`'s register route
// writes, and what a re-submission resets to.
func (m *MemoryStore) Put(p Pending) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rows[p.PanelID] = &Record{Pending: p, ReviewState: driver.ReviewPending}
}

// Decide sets a panel's review state from outside this pass, as an owner's
// withdrawal would.
func (m *MemoryStore) Decide(panelID string, state driver.ReviewState) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r := m.rows[panelID]; r != nil {
		r.ReviewState = state
	}
}

// Edit changes a panel's addresses as billing's `PATCH
// /systems/panels/:id` does (F-027-by): back to `pending`, last test cleared.
func (m *MemoryStore) Edit(panelID, apiBaseURL, clientBaseURL string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r := m.rows[panelID]; r != nil {
		r.APIBaseURL, r.ClientBaseURL = apiBaseURL, clientBaseURL
		r.ReviewState, r.Capabilities = driver.ReviewPending, nil
		r.TestedAt, r.Fault, r.Detail = time.Time{}, "", ""
	}
}

// Record returns a copy of one panel's state.
func (m *MemoryStore) Record(panelID string) Record {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r := m.rows[panelID]; r != nil {
		return *r
	}
	return Record{}
}

func (m *MemoryStore) Pending(context.Context) ([]Candidate, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Candidate
	for _, r := range m.rows {
		if r.ReviewState == driver.ReviewPending {
			out = append(out, Candidate{Pending: r.Pending, TestedAt: r.TestedAt, Fault: r.Fault})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PanelID < out[j].PanelID })
	return out, nil
}

// tested is the row p's answer may land on: still pending, at the addresses
// that were tested.
func (m *MemoryStore) tested(p Pending) *Record {
	r := m.rows[p.PanelID]
	if r == nil || r.ReviewState != driver.ReviewPending ||
		r.APIBaseURL != p.APIBaseURL || r.ClientBaseURL != p.ClientBaseURL {
		return nil
	}
	return r
}

func (m *MemoryStore) Answer(_ context.Context, p Pending, caps driver.Capabilities, state driver.ReviewState, at time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.tested(p)
	if r == nil {
		return false, nil
	}
	r.Capabilities = &caps
	r.ReviewState = state
	r.TestedAt, r.Fault, r.Detail = at, "", ""
	return true, nil
}

func (m *MemoryStore) Fail(_ context.Context, p Pending, fault FaultKind, detail string, at time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.tested(p)
	if r == nil {
		return false, nil
	}
	r.TestedAt, r.Fault, r.Detail = at, fault, detail
	return true, nil
}
