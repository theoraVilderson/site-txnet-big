package db

import "testing"

// The boot assertion is the whole point of this package: Prisma owns the
// schema (ADR-0071), so this service is always one migration behind or ahead
// of the database it is pointed at, and the only safe answer to "ahead" is to
// refuse to start. The diff itself is pure so it can be tested without one.

func TestMissingColumnsNamesEveryAbsentColumn(t *testing.T) {
	required := map[string][]string{
		"panel":  {"id", "driverType", "counterSemantics"},
		"config": {"id", "allocatedCeilingBytes"},
	}
	present := ColumnSet{
		{Table: "panel", Column: "id"},
		{Table: "panel", Column: "driverType"},
		{Table: "config", Column: "id"},
	}

	missing := MissingColumns(required, present)

	want := []ColumnRef{
		{Table: "config", Column: "allocatedCeilingBytes"},
		{Table: "panel", Column: "counterSemantics"},
	}
	if len(missing) != len(want) {
		t.Fatalf("missing = %v, want %v", missing, want)
	}
	for i, ref := range want {
		if missing[i] != ref {
			t.Errorf("missing[%d] = %v, want %v", i, missing[i], ref)
		}
	}
}

func TestMissingColumnsIsEmptyWhenEverythingIsPresent(t *testing.T) {
	required := map[string][]string{"panel": {"id", "panelState"}}
	present := ColumnSet{
		{Table: "panel", Column: "id"},
		{Table: "panel", Column: "panelState"},
		{Table: "panel", Column: "region"}, // a column we do not read is not our business
	}

	if missing := MissingColumns(required, present); len(missing) != 0 {
		t.Fatalf("missing = %v, want none", missing)
	}
}

// A table absent entirely reads as all of its columns missing, rather than as
// a silent pass: `information_schema` returns no rows for it either way.
func TestMissingColumnsReportsAnAbsentTableColumnByColumn(t *testing.T) {
	required := map[string][]string{"radius_session": {"nasId", "acctSessionId"}}

	missing := MissingColumns(required, ColumnSet{})

	if len(missing) != 2 {
		t.Fatalf("missing = %v, want both columns", missing)
	}
}

func TestRequiredColumnsManifestIsWellFormed(t *testing.T) {
	if len(RequiredColumns) == 0 {
		t.Fatal("the manifest is empty; the boot assertion would assert nothing")
	}
	for table, columns := range RequiredColumns {
		if table == "" {
			t.Error("manifest has an unnamed table")
		}
		if len(columns) == 0 {
			t.Errorf("table %q lists no columns", table)
		}
		seen := map[string]bool{}
		for _, column := range columns {
			if column == "" {
				t.Errorf("table %q has an unnamed column", table)
			}
			if seen[column] {
				t.Errorf("table %q lists %q twice", table, column)
			}
			seen[column] = true
		}
	}
}

// Every table in the manifest is one `network` owns (INDEX.md `owns_tables:`).
// A typo here is a service that refuses to boot against a correct database.
func TestManifestNamesOnlyTablesTheUnitOwns(t *testing.T) {
	owned := map[string]bool{
		"panel": true, "config": true, "config_action_log": true,
		"traffic_raw_log": true, "traffic_daily_aggregate": true,
		"ip_access_rule": true, "config_counter_state": true,
		"usage_delta_seen": true, "usage_delta_quarantine": true,
		"usage_hold": true, "panel_drift_event": true,
		"unattributed_usage": true, "radius_session": true,
		"panel_inbound": true,
	}
	for table := range RequiredColumns {
		if !owned[table] {
			t.Errorf("manifest names %q, which network does not own", table)
		}
	}
}
