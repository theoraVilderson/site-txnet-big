package localeclient

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	"github.com/txnet/i18n-platform/clients/go/localev1"
)

// allScopesFile names a cached file for the empty scope ("every scope"); the
// Node client (disk-cache.ts) uses the same word, as both share one volume.
const allScopesFile = "all"

const cacheFileMode = 0o644

// snapshotDisk is one scope's snapshots on disk, `<scope>.<lang>.json` under
// dir (hosting H17). A save is a temp file renamed over the old one, so the
// next boot never reads half a file. Neither direction fails the caller: a
// cache that cannot be written or read is a warning, never a reason to stop.
type snapshotDisk struct {
	dir    string
	prefix string
	log    *slog.Logger
}

func newSnapshotDisk(dir, scope string, log *slog.Logger) *snapshotDisk {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Warn("locale cache dir cannot be created", "dir", dir, "err", err)
	}
	if scope == "" {
		scope = allScopesFile
	}
	return &snapshotDisk{dir: dir, prefix: scope + ".", log: log}
}

func (d *snapshotDisk) save(snap *localev1.SnapshotResponse) {
	raw, err := protojson.Marshal(snap)
	if err == nil {
		err = writeAtomically(filepath.Join(d.dir, d.prefix+snap.GetLang()+".json"), raw)
	}
	if err != nil {
		d.log.Warn("locale snapshot not cached", "lang", snap.GetLang(), "err", err)
	}
}

func writeAtomically(path string, raw []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	// 0644 as the Node client writes them: CreateTemp's 0600 would hide the
	// file from a service that runs as another user on the shared volume.
	err = tmp.Chmod(cacheFileMode)
	if err == nil {
		_, err = tmp.Write(raw)
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), path)
	}
	if err != nil {
		_ = os.Remove(tmp.Name())
	}
	return err
}

// load returns every readable snapshot of the scope, in file-name order, and
// the age of the oldest one. No snapshot read means an empty slice.
func (d *snapshotDisk) load() ([]*localev1.SnapshotResponse, time.Duration) {
	names, err := filepath.Glob(filepath.Join(d.dir, d.prefix+"*.json"))
	if err != nil {
		d.log.Warn("locale cache dir cannot be read", "dir", d.dir, "err", err)
		return nil, 0
	}
	sort.Strings(names)
	var snaps []*localev1.SnapshotResponse
	oldest := time.Now()
	for _, name := range names {
		snap, modified, err := readSnapshot(name)
		if err != nil {
			d.log.Warn("cached locale snapshot skipped", "file", name, "err", err)
			continue
		}
		snaps = append(snaps, snap)
		if modified.Before(oldest) {
			oldest = modified
		}
	}
	return snaps, time.Since(oldest)
}

func readSnapshot(path string) (*localev1.SnapshotResponse, time.Time, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, time.Time{}, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, time.Time{}, err
	}
	snap := &localev1.SnapshotResponse{}
	// DiscardUnknown: a file written by a newer client may carry a field this one lacks.
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(raw, snap); err != nil {
		return nil, time.Time{}, err
	}
	if snap.GetLang() == "" {
		return nil, time.Time{}, errors.New("not a snapshot: no lang")
	}
	return snap, info.ModTime(), nil
}

// bootFromDisk serves the saved snapshots after a failed boot; false when none loaded.
func (c *Client) bootFromDisk() bool {
	if c.disk == nil {
		return false
	}
	snaps, age := c.disk.load()
	if len(snaps) == 0 {
		return false
	}
	c.mu.Lock()
	for _, snap := range snaps {
		c.byLang[snap.GetLang()] = snap
	}
	c.mu.Unlock()
	if c.cfg.DefaultLang == "" {
		c.cfg.DefaultLang = snaps[0].GetLang()
	}
	c.log.Warn("locale-service unreachable, booted from cache", "age", age.Round(time.Minute).String())
	return true
}

// refreshUntilAnswered runs after a boot from disk: it asks until
// locale-service answers once, so the saved text is replaced as soon as it can
// be — Watch alone refetches only after a stream it had open breaks.
func (c *Client) refreshUntilAnswered(ctx context.Context) {
	backoff := time.Second
	for {
		if err := c.refetchAll(ctx); err == nil {
			c.log.Info("locale-service answered; the cached snapshots are replaced")
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff *= 2; backoff > c.cfg.MaxBackoff {
			backoff = c.cfg.MaxBackoff
		}
	}
}
