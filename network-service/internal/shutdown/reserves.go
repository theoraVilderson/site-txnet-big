package shutdown

import (
	"context"
	"sync"
)

// MemoryReserves holds the extension figures in memory. It is what the
// extension is proved against, and what a single-process run uses until the
// Postgres-backed implementation lands beside the durable `collect.Cursors`
// and `converge.MemoryAllocations` — the same staging those are in.
type MemoryReserves struct {
	mu      sync.Mutex
	byPanel map[string][]Extension
}

func NewMemoryReserves() *MemoryReserves {
	return &MemoryReserves{byPanel: map[string][]Extension{}}
}

// Set is the allocator's side, stubbed: it sets one config's figures on one
// panel, replacing an earlier row for the same config.
func (m *MemoryReserves) Set(panelID string, ext Extension) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rows := m.byPanel[panelID]
	for i, row := range rows {
		if row.ConfigID == ext.ConfigID {
			rows[i] = ext
			m.byPanel[panelID] = rows
			return
		}
	}
	m.byPanel[panelID] = append(rows, ext)
}

func (m *MemoryReserves) Extensions(_ context.Context, panelID string) ([]Extension, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rows := m.byPanel[panelID]
	out := make([]Extension, len(rows))
	copy(out, rows)
	return out, nil
}
