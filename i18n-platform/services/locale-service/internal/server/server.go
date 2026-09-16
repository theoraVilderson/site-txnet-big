// Package server implements the LocaleService gRPC contract on top of store.Store.
package server

import (
	"context"
	"errors"
	"log"
	"sync"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/txnet/i18n-platform/services/locale-service/internal/localev1"
	"github.com/txnet/i18n-platform/services/locale-service/internal/store"
)

// scopesToTrack is the set of scopes the Watch broadcaster keeps version state
// for ("" = every scope merged).
var scopesToTrack = []string{"", store.ScopeBackend, store.ScopeFrontend}

type subscriber struct {
	langs map[string]bool // nil => all languages
	scope string
	ch    chan *localev1.UpdateEvent
}

// Server is a LocaleService implementation backed by a live store.
type Server struct {
	localev1.UnimplementedLocaleServiceServer

	store *store.Store

	mu          sync.RWMutex
	subscribers map[*subscriber]struct{}
	versions    map[string]string // "<scope>\x00<lang>" -> last broadcast version
}

// New builds a Server. Call OnStoreChange from the watcher callback.
func New(s *store.Store) *Server {
	return &Server{
		store:       s,
		subscribers: map[*subscriber]struct{}{},
		versions:    map[string]string{},
	}
}

// GetSnapshot returns a full snapshot for one (lang, scope).
func (s *Server) GetSnapshot(_ context.Context, req *localev1.SnapshotRequest) (*localev1.SnapshotResponse, error) {
	if req.GetLang() == "" {
		return nil, status.Error(codes.InvalidArgument, "lang is required")
	}
	snap, ok := s.buildSnapshot(req.GetLang(), req.GetScope())
	if !ok {
		return nil, status.Errorf(codes.NotFound, "unknown lang: %s", req.GetLang())
	}
	return snap, nil
}

// GetAvailableLocales lists configured languages and their metadata.
func (s *Server) GetAvailableLocales(_ context.Context, _ *localev1.Empty) (*localev1.AvailableLocalesResponse, error) {
	metas := s.store.AvailableLocales()
	out := &localev1.AvailableLocalesResponse{Locales: make([]*localev1.LocaleMeta, 0, len(metas))}
	for _, m := range metas {
		out.Locales = append(out.Locales, &localev1.LocaleMeta{
			Code:       m.Code,
			Name:       m.Name,
			ShortName:  m.ShortName,
			NativeName: m.NativeName,
			Dir:        m.Dir,
			Locale:     m.Locale,
		})
	}
	return out, nil
}

// Watch streams an UpdateEvent whenever a matching (lang, scope) changes.
func (s *Server) Watch(req *localev1.WatchRequest, stream localev1.LocaleService_WatchServer) error {
	var langs map[string]bool
	if len(req.GetLangs()) > 0 {
		langs = map[string]bool{}
		for _, l := range req.GetLangs() {
			if l != "" {
				langs[l] = true
			}
		}
	}

	sub := &subscriber{langs: langs, scope: req.GetScope(), ch: make(chan *localev1.UpdateEvent, 16)}
	s.mu.Lock()
	s.subscribers[sub] = struct{}{}
	total := len(s.subscribers)
	s.mu.Unlock()
	log.Printf("[grpc] watch subscriber connected (scope=%q), total=%d", req.GetScope(), total)

	defer func() {
		s.mu.Lock()
		delete(s.subscribers, sub)
		total := len(s.subscribers)
		s.mu.Unlock()
		log.Printf("[grpc] watch subscriber disconnected, total=%d", total)
	}()

	for {
		select {
		case <-stream.Context().Done():
			return stream.Context().Err()
		case ev := <-sub.ch:
			if err := stream.Send(ev); err != nil {
				return err
			}
		}
	}
}

// OnStoreChange recomputes versions and pushes snapshots to matching
// subscribers. Safe to call from the watcher goroutine.
func (s *Server) OnStoreChange() {
	langs := s.store.Languages()

	type pending struct {
		scope, lang string
		snap        *localev1.SnapshotResponse
	}
	var changed []pending

	s.mu.Lock()
	for _, scope := range scopesToTrack {
		for _, lang := range langs {
			snap, ok := s.buildSnapshotLocked(lang, scope)
			if !ok {
				continue
			}
			key := scope + "\x00" + lang
			if s.versions[key] == snap.Version {
				continue
			}
			s.versions[key] = snap.Version
			changed = append(changed, pending{scope: scope, lang: lang, snap: snap})
		}
	}
	subs := make([]*subscriber, 0, len(s.subscribers))
	for sub := range s.subscribers {
		subs = append(subs, sub)
	}
	s.mu.Unlock()

	for _, c := range changed {
		log.Printf("[grpc] %s/%s -> %s", c.scope, c.lang, c.snap.Version)
		ev := &localev1.UpdateEvent{
			Lang:         c.lang,
			Scope:        c.scope,
			NewVersion:   c.snap.Version,
			FullSnapshot: c.snap,
		}
		for _, sub := range subs {
			if sub.scope != c.scope {
				continue
			}
			if sub.langs != nil && !sub.langs[c.lang] {
				continue
			}
			select {
			case sub.ch <- ev:
			default: // slow consumer: drop; it will re-sync on reconnect
			}
		}
	}
}

func (s *Server) buildSnapshot(lang, scope string) (*localev1.SnapshotResponse, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.buildSnapshotLocked(lang, scope)
}

func (s *Server) buildSnapshotLocked(lang, scope string) (*localev1.SnapshotResponse, bool) {
	namespaces, version, ok := s.store.Snapshot(lang, scope)
	if !ok {
		return nil, false
	}
	out := &localev1.SnapshotResponse{
		Lang:       lang,
		Scope:      scope,
		Version:    version,
		Namespaces: make(map[string]*localev1.NamespaceData, len(namespaces)),
	}
	for ns, data := range namespaces {
		out.Namespaces[ns] = &localev1.NamespaceData{Entries: data.Entries}
	}
	return out, true
}

// SetEntries writes runtime entries (F-1533-b) and, when anything served may
// have changed, pushes the new snapshots to Watch subscribers.
func (s *Server) SetEntries(_ context.Context, req *localev1.SetEntriesRequest) (*localev1.SetEntriesResponse, error) {
	var state store.EntryState
	switch req.GetState() {
	case localev1.EntryState_ENTRY_STATE_PUBLISHED:
		state = store.Published
	case localev1.EntryState_ENTRY_STATE_DRAFT:
		state = store.Draft
	}
	n, err := s.store.SetEntries(req.GetScope(), req.GetLang(), req.GetNamespace(), req.GetEntries(), state)
	if err != nil {
		return nil, writeError(err)
	}
	if state == store.Published {
		s.OnStoreChange()
	}
	return &localev1.SetEntriesResponse{Written: int32(n)}, nil
}

// ListDrafts returns the drafts held for review.
func (s *Server) ListDrafts(_ context.Context, req *localev1.ListDraftsRequest) (*localev1.ListDraftsResponse, error) {
	drafts := s.store.Drafts(req.GetScope(), req.GetLang(), req.GetNamespace(), req.GetKeyPrefix())
	out := &localev1.ListDraftsResponse{Drafts: make([]*localev1.DraftEntry, 0, len(drafts))}
	for _, d := range drafts {
		out.Drafts = append(out.Drafts, &localev1.DraftEntry{
			Scope: d.Scope, Lang: d.Lang, Namespace: d.Namespace, Key: d.Key, Text: d.Text,
		})
	}
	return out, nil
}

// PublishDrafts moves drafts to published and pushes the new snapshots.
func (s *Server) PublishDrafts(_ context.Context, req *localev1.PublishDraftsRequest) (*localev1.PublishDraftsResponse, error) {
	n, err := s.store.PublishDrafts(req.GetScope(), req.GetLang(), req.GetNamespace(), req.GetKeys())
	if err != nil {
		return nil, writeError(err)
	}
	if n > 0 {
		s.OnStoreChange()
	}
	return &localev1.PublishDraftsResponse{Published: int32(n)}, nil
}

func writeError(err error) error {
	switch {
	case errors.Is(err, store.ErrReadOnly):
		return status.Error(codes.FailedPrecondition, err.Error())
	case errors.Is(err, store.ErrUnknownLang):
		return status.Error(codes.NotFound, err.Error())
	case errors.Is(err, store.ErrInvalid):
		return status.Error(codes.InvalidArgument, err.Error())
	default:
		log.Printf("[grpc] runtime write failed: %v", err)
		return status.Error(codes.Internal, "runtime write failed")
	}
}
