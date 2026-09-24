package converge

import (
	"context"
	"sync"
)

// MemoryAllocations holds shares and confirmations in memory. It is what the
// convergence is proved against, and what a single-process run uses until the
// Postgres-backed implementation lands beside the durable `Cursors` — the same
// staging `collect.MemoryCursors` is in.
type MemoryAllocations struct {
	mu       sync.Mutex
	byPanel  map[string][]Allocation
	byConfig map[string]AppliedCeiling
}

func NewMemoryAllocations() *MemoryAllocations {
	return &MemoryAllocations{
		byPanel:  map[string][]Allocation{},
		byConfig: map[string]AppliedCeiling{},
	}
}

// Allocate is the allocator's side, stubbed: it sets one config's share on one
// panel, replacing an earlier share for the same config.
func (m *MemoryAllocations) Allocate(panelID string, allocation Allocation) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rows := m.byPanel[panelID]
	for i, row := range rows {
		if row.ConfigID == allocation.ConfigID {
			rows[i] = allocation
			m.byPanel[panelID] = rows
			return
		}
	}
	m.byPanel[panelID] = append(rows, allocation)
}

func (m *MemoryAllocations) For(_ context.Context, panelID string) ([]Allocation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rows := m.byPanel[panelID]
	out := make([]Allocation, len(rows))
	for i, row := range rows {
		if applied, ok := m.byConfig[row.ConfigID]; ok {
			bytes := applied.Bytes
			row.AppliedBytes = &bytes
		}
		out[i] = row
	}
	return out, nil
}

func (m *MemoryAllocations) Record(_ context.Context, rows []AppliedCeiling) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, row := range rows {
		m.byConfig[row.ConfigID] = row
	}
	return nil
}

// Applied is what the panel was last found to be enforcing for one config. The
// second result is false for a config no panel has ever confirmed one for,
// which is not the same as a ceiling of zero.
func (m *MemoryAllocations) Applied(configID string) (AppliedCeiling, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.byConfig[configID]
	return row, ok
}

// MemoryDesired holds desired state in memory, in the order it was put — the
// same staging as MemoryAllocations, until `network.config` is read directly.
type MemoryDesired struct {
	mu      sync.Mutex
	byPanel map[string][]string
	rows    map[string]DesiredConfig
}

func NewMemoryDesired() *MemoryDesired {
	return &MemoryDesired{byPanel: map[string][]string{}, rows: map[string]DesiredConfig{}}
}

// Put is the action writers' side, stubbed: it sets one config's desired
// state on one panel, replacing an earlier one for the same config.
func (m *MemoryDesired) Put(panelID string, row DesiredConfig) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, seen := m.rows[row.ConfigID]; !seen {
		m.byPanel[panelID] = append(m.byPanel[panelID], row.ConfigID)
	}
	m.rows[row.ConfigID] = row
}

func (m *MemoryDesired) For(_ context.Context, panelID string) ([]DesiredConfig, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]DesiredConfig, 0, len(m.byPanel[panelID]))
	for _, id := range m.byPanel[panelID] {
		out = append(out, m.rows[id])
	}
	return out, nil
}

func (m *MemoryDesired) Record(_ context.Context, outcomes []Outcome) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, o := range outcomes {
		row, ok := m.rows[o.ConfigID]
		if !ok {
			continue
		}
		row.RemoteID, row.State = o.RemoteID, o.State
		if o.Links != nil {
			row.Links = *o.Links
		}
		m.rows[o.ConfigID] = row
	}
	return nil
}

func (m *MemoryDesired) RecordDrift(_ context.Context, verdicts []Verdict) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, v := range verdicts {
		row, ok := m.rows[v.ConfigID]
		if !ok {
			continue
		}
		row.Drift, row.RepairCount, row.RepairedAt = v.Drift, v.RepairCount, v.RepairedAt
		m.rows[v.ConfigID] = row
	}
	return nil
}

// Get is one config's desired state as the pass last left it.
func (m *MemoryDesired) Get(configID string) (DesiredConfig, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.rows[configID]
	return row, ok
}
