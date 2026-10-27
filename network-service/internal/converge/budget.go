package converge

// DefaultMaxCreates is the creates one turn makes. A create is the one
// unbounded write: ~2 s on a Marzban of a few hundred users, so a migration's
// thousands would hold the turn — and the bulk pass that waits on every turn —
// for an hour (F-027-fj, LIVE-1). Ten is a purchase's configs at once and a
// turn of ~20 s at worst; the waker carries the rest.
const DefaultMaxCreates = 10

func (v *Provisioning) maxCreates() int {
	if v.MaxCreates > 0 {
		return v.MaxCreates
	}
	return DefaultMaxCreates
}

// mayCreate spends one of the turn's creates, or counts the create Deferred
// once they are spent. Asked just before the panel is, so a config skipped for
// no allowance or no inbound spends nothing. A deferred config records no
// outcome: its row is as it was, and the next turn reaches it (F-027-fj).
func (v *Provisioning) mayCreate(report *ProvisionReport) bool {
	if report.Creates >= v.maxCreates() {
		report.Deferred++
		return false
	}
	report.Creates++
	return true
}
