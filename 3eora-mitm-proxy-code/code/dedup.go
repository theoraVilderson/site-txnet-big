package main

import (
	"context"
	"sync"
)

type call struct {
	done chan struct{}
	err  error
}

type Dedup struct {
	mu sync.Mutex
	m  map[string]*call
}

func NewDedup() *Dedup {
	return &Dedup{m: make(map[string]*call)}
}

func (d *Dedup) Start(key string) (*call, bool) {
	d.mu.Lock()
	if c, ok := d.m[key]; ok {
		d.mu.Unlock()
		return c, false
	}
	c := &call{done: make(chan struct{})}
	d.m[key] = c
	d.mu.Unlock()
	return c, true
}

func (d *Dedup) Finish(key string, err error) {
	d.mu.Lock()
	if c, ok := d.m[key]; ok {
		delete(d.m, key)
		d.mu.Unlock()
		c.err = err
		close(c.done)
	} else {
		d.mu.Unlock()
	}
}

func (c *call) Wait(ctx context.Context) error {
	select {
	case <-c.done:
		return c.err
	case <-ctx.Done():
		return ctx.Err()
	}
}