// Package writeq is the per-panel write queue.
//
//   - Coalescing: keyed by replica; a newer desired state replaces the queued
//     one (5 limit changes in 30 s = 1 HTTP request).
//   - Priority: close < regrant < topup < rebalance < maintain.
//   - Serialised per replica: at most one in-flight write per replica, so
//     writes can never land out of order.
//   - Aging: an item waiting longer than AgeBoost is promoted one level, so
//     maintenance work cannot starve forever behind top-ups.
package writeq

import (
	"container/heap"
	"sync"
	"time"
)

type item struct {
	id      int64
	prio    int
	enq     time.Time
	seq     uint64
	payload any
	index   int
}

type itemHeap []*item

func (h itemHeap) Len() int { return len(h) }
func (h itemHeap) Less(i, j int) bool {
	if h[i].prio != h[j].prio {
		return h[i].prio < h[j].prio
	}
	return h[i].seq < h[j].seq
}
func (h itemHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i]; h[i].index = i; h[j].index = j }
func (h *itemHeap) Push(x any)   { it := x.(*item); it.index = len(*h); *h = append(*h, it) }
func (h *itemHeap) Pop() any {
	old := *h
	it := old[len(old)-1]
	*h = old[:len(old)-1]
	it.index = -1
	return it
}

type Queue struct {
	mu       sync.Mutex
	byID     map[int64]*item
	h        itemHeap
	seq      uint64
	inflight map[int64]bool
	AgeBoost time.Duration
}

func New() *Queue {
	return &Queue{byID: map[int64]*item{}, inflight: map[int64]bool{}, AgeBoost: 2 * time.Minute}
}

// Put enqueues or replaces the desired state for a replica.
func (q *Queue) Put(id int64, prio int, payload any, now time.Time) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if it, ok := q.byID[id]; ok {
		it.payload = payload
		if prio < it.prio {
			it.prio = prio
			heap.Fix(&q.h, it.index)
		}
		return
	}
	q.seq++
	it := &item{id: id, prio: prio, enq: now, seq: q.seq, payload: payload}
	q.byID[id] = it
	heap.Push(&q.h, it)
}

// Pop returns the most urgent item whose replica has no write in flight and
// marks it in flight. Call Done when the write finished (ok or not).
func (q *Queue) Pop(now time.Time) (id int64, payload any, ok bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.age(now)
	var skipped []*item
	defer func() {
		for _, it := range skipped {
			heap.Push(&q.h, it)
		}
	}()
	for q.h.Len() > 0 {
		it := heap.Pop(&q.h).(*item)
		if q.inflight[it.id] {
			skipped = append(skipped, it)
			continue
		}
		delete(q.byID, it.id)
		q.inflight[it.id] = true
		return it.id, it.payload, true
	}
	return 0, nil, false
}

// Done releases the replica. On failure, re-Put the payload (the planner
// will usually have produced a fresher one anyway).
func (q *Queue) Done(id int64) {
	q.mu.Lock()
	delete(q.inflight, id)
	q.mu.Unlock()
}

func (q *Queue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.h.Len()
}

func (q *Queue) age(now time.Time) {
	if q.AgeBoost <= 0 {
		return
	}
	changed := false
	for _, it := range q.h {
		if it.prio > 1 && now.Sub(it.enq) > q.AgeBoost {
			it.prio--
			it.enq = now
			changed = true
		}
	}
	if changed {
		heap.Init(&q.h)
	}
}
