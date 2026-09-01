// Package watcher reloads the store when files under locales/ change, with a
// short debounce so a burst of writes triggers a single reload.
package watcher

import (
	"log"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"

	"github.com/txnet/i18n-platform/services/locale-service/internal/store"
)

const debounce = 300 * time.Millisecond

// Watch does one immediate reload, then keeps reloading on change until stop()
// is called. onChange runs after every successful reload (including the first).
func Watch(s *store.Store, onChange func()) (stop func(), err error) {
	if err := s.Reload(); err != nil {
		return nil, err
	}
	onChange()

	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	for _, dir := range s.WatchDirs() {
		if err := w.Add(dir); err != nil {
			log.Printf("[watcher] cannot watch %s: %v", dir, err)
		}
	}

	done := make(chan struct{})
	go func() {
		var mu sync.Mutex
		var timer *time.Timer
		for {
			select {
			case <-done:
				if timer != nil {
					timer.Stop()
				}
				return
			case ev, ok := <-w.Events:
				if !ok {
					return
				}
				if ev.Op&(fsnotify.Write|fsnotify.Create|fsnotify.Remove|fsnotify.Rename) == 0 {
					continue
				}
				// A new language directory may need its own watch.
				if ev.Op&fsnotify.Create != 0 {
					for _, dir := range s.WatchDirs() {
						_ = w.Add(dir)
					}
				}
				mu.Lock()
				if timer != nil {
					timer.Stop()
				}
				timer = time.AfterFunc(debounce, func() {
					if err := s.Reload(); err != nil {
						log.Printf("[watcher] reload failed, keeping old data: %v", err)
						return
					}
					onChange()
				})
				mu.Unlock()
			case err, ok := <-w.Errors:
				if !ok {
					return
				}
				log.Printf("[watcher] error: %v", err)
			}
		}
	}()

	return func() {
		close(done)
		_ = w.Close()
	}, nil
}
