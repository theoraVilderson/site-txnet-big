package db

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type fakeRows struct {
	rows [][2]string
	at   int
	err  error
}

func (f *fakeRows) Next() bool { f.at++; return f.at <= len(f.rows) }
func (f *fakeRows) Scan(dest ...any) error {
	row := f.rows[f.at-1]
	*(dest[0].(*string)) = row[0]
	*(dest[1].(*string)) = row[1]
	return nil
}
func (f *fakeRows) Err() error { return f.err }
func (f *fakeRows) Close()     {}

type fakeRow struct {
	user     string
	isMember bool
	err      error
}

func (f fakeRow) Scan(dest ...any) error {
	if f.err != nil {
		return f.err
	}
	*(dest[0].(*string)) = f.user
	*(dest[1].(*bool)) = f.isMember
	return nil
}

type fakeDB struct {
	columns  [][2]string
	queryErr error
	role     fakeRow
}

func (f fakeDB) Query(ctx context.Context, sql string, args ...any) (Rows, error) {
	if f.queryErr != nil {
		return nil, f.queryErr
	}
	return &fakeRows{rows: f.columns}, nil
}

func (f fakeDB) QueryRow(ctx context.Context, sql string, args ...any) Row { return f.role }

func everyRequiredColumn() [][2]string {
	var all [][2]string
	for table, columns := range RequiredColumns {
		for _, column := range columns {
			all = append(all, [2]string{table, column})
		}
	}
	return all
}

func TestAssertColumnsPassesOnTheSchemaItWasWrittenAgainst(t *testing.T) {
	if err := AssertColumns(context.Background(), fakeDB{columns: everyRequiredColumn()}); err != nil {
		t.Fatalf("AssertColumns() = %v, want nil", err)
	}
}

func TestAssertColumnsNamesTheMissingColumnAndWhoOwnsTheSchema(t *testing.T) {
	all := everyRequiredColumn()
	dropped := all[0]
	err := AssertColumns(context.Background(), fakeDB{columns: all[1:]})
	if err == nil {
		t.Fatal("AssertColumns() = nil, want a refusal")
	}
	if !strings.Contains(err.Error(), dropped[1]) {
		t.Errorf("refusal %q does not name the missing column %q", err, dropped[1])
	}
	if !strings.Contains(err.Error(), "ADR-0071") {
		t.Errorf("refusal %q does not say where migrations come from", err)
	}
}

func TestAssertColumnsFailsClosedWhenTheSchemaCannotBeRead(t *testing.T) {
	err := AssertColumns(context.Background(), fakeDB{queryErr: errors.New("connection refused")})
	if err == nil {
		t.Fatal("AssertColumns() = nil, want the read error")
	}
}

func TestAssertCrossTenantRoleAcceptsAMemberOfTheRole(t *testing.T) {
	db := fakeDB{role: fakeRow{user: "txnet_cross_tenant_user", isMember: true}}
	if err := AssertCrossTenantRole(context.Background(), db); err != nil {
		t.Fatalf("AssertCrossTenantRole() = %v, want nil", err)
	}
}

func TestAssertCrossTenantRoleRefusesTheApplicationRole(t *testing.T) {
	db := fakeDB{role: fakeRow{user: "txnet_app_user", isMember: false}}
	err := AssertCrossTenantRole(context.Background(), db)
	if err == nil {
		t.Fatal("AssertCrossTenantRole() = nil, want a refusal")
	}
	if !strings.Contains(err.Error(), "txnet_app_user") {
		t.Errorf("refusal %q does not name the role it connected as", err)
	}
}
