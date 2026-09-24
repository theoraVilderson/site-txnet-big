package db

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// F-027-bn: `ConfigsOfGrant` filters `network.config` by `grantId` and orders
// by `createdAt`. Without an index leading with both, every cache miss at
// `/sub` scans every tenant's configs. Prisma owns the schema, so the index
// is asserted where it is declared: in `network.prisma` and in a migration,
// read off disk so a rename on either side fails here.

const domains = "../../../txnet-backend/prisma/domains"

func TestConfigsOfAGrantAreReadThroughAnIndex(t *testing.T) {
	schema, err := os.ReadFile(filepath.Join(domains, "network.prisma"))
	if err != nil {
		t.Fatalf("read network.prisma: %v", err)
	}
	model := regexp.MustCompile(`(?s)\nmodel Config \{.*?\n\}`).Find(schema)
	if !strings.Contains(string(model), "@@index([grantId, createdAt])") {
		t.Errorf("model Config has no @@index([grantId, createdAt])")
	}

	sqls, _ := filepath.Glob(filepath.Join(domains, "migrations", "*", "migration.sql"))
	create := regexp.MustCompile(`CREATE INDEX "config_grantId_createdAt_idx"\s+ON "network"\."config"\("grantId", "createdAt"\)`)
	for _, path := range sqls {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		if create.Match(body) {
			return
		}
	}
	t.Errorf("no migration creates config_grantId_createdAt_idx on network.config(grantId, createdAt)")
}
