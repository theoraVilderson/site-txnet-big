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
	copy(out, rows)
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
