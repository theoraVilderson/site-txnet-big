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
	// DuplicateOf is the panel this one was found to be (F-027-ce); set only with refused.
	DuplicateOf string
	// Registered is the panel as the duplicate check sees it, once accepted.
	Registered Registered
}

// MemoryStore holds registration state in memory. It is what the pass is
// proved against, until the Postgres-backed Store lands with the panel source.
type MemoryStore struct {
	mu   sync.Mutex
	rows map[string]*Record
	// claims is each panel's configs, as claim tag and uuid pairs.
	claims map[string][][2]string
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{rows: map[string]*Record{}, claims: map[string][][2]string{}}
}

// PutRegistered puts a panel in service, in the given state.
func (m *MemoryStore) PutRegistered(r Registered, state driver.ReviewState) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rows[r.PanelID] = &Record{Pending: r.Pending, ReviewState: state, Registered: r}
}

// Claim gives a panel a config with this claim tag and uuid.
func (m *MemoryStore) Claim(panelID, claimTag, uuid string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.claims[panelID] = append(m.claims[panelID], [2]string{claimTag, uuid})
}

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
		r.TestedAt, r.Fault, r.Detail, r.DuplicateOf = time.Time{}, "", "", ""
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

func (m *MemoryStore) ClaimHolder(_ context.Context, panelID string, tags, uuids []string) (Holder, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	want := map[string]bool{}
	for _, t := range tags {
		want["t:"+t] = true
	}
	for _, u := range uuids {
		want["u:"+u] = true
	}
	ids := make([]string, 0, len(m.claims))
	for id := range m.claims {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if id == panelID {
			continue
		}
		for _, c := range m.claims[id] {
			if want["t:"+c[0]] || want["u:"+c[1]] {
				name := ""
				if r := m.rows[id]; r != nil {
					name = r.Registered.Name
				}
				return Holder{PanelID: id, Name: name}, true, nil
			}
		}
	}
	return Holder{}, false, nil
}

func (m *MemoryStore) Registered(_ context.Context, panelID string) ([]Registered, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Registered
	for id, r := range m.rows {
		if id == panelID || r.Transport != driver.TransportPull ||
			(r.ReviewState != driver.ReviewAccepted && r.ReviewState != driver.ReviewAcceptedLowTrust) {
			continue
		}
		reg := r.Registered
		reg.Pending = r.Pending
		out = append(out, reg)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PanelID < out[j].PanelID })
	return out, nil
}

func (m *MemoryStore) Duplicate(_ context.Context, p Pending, caps driver.Capabilities, holder Holder, at time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.tested(p)
	if r == nil {
		return false, nil
	}
	r.Capabilities = &caps
	r.ReviewState, r.DuplicateOf = driver.ReviewRefused, holder.PanelID
	r.TestedAt, r.Fault, r.Detail = at, "", ""
	return true, nil
}
