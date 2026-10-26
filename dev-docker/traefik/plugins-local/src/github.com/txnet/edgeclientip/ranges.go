package edgeclientip

import (
	"encoding/json"
	"net"
	"os"
	"sync"
	"time"
)

// rangeRecheck: how often a request may stat the range copies. edge_ranges.py
// rewrites them once a day (hosting O8), so a minute is prompt and costs one
// stat per file per minute.
const rangeRecheck = time.Minute

// edgeRanges are the domestic edges' published ranges, read from the last good
// copies edge_ranges.py keeps for the firewall (`/var/lib/txnet/edge-ranges/
// <edge>.json`), so the gateway and the firewall admit the same list
// (NIN-1-b4). A copy is re-read when its mtime moves; one that is missing or
// broken keeps what was last read from it, as the firewall keeps its last good
// copy (O8).
type edgeRanges struct {
	files []string
	now   func() time.Time

	mu      sync.Mutex
	checked time.Time
	mtimes  map[string]time.Time
	nets    map[string][]*net.IPNet
}

func newEdgeRanges(files []string) *edgeRanges {
	return &edgeRanges{files: files, now: time.Now, mtimes: map[string]time.Time{}, nets: map[string][]*net.IPNet{}}
}

// contains: the address (`ip:port` or a bare IP) is inside one of the ranges.
func (r *edgeRanges) contains(addr string) bool {
	host := addr
	if h, _, err := net.SplitHostPort(addr); err == nil {
		host = h
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.checked.IsZero() || r.now().Sub(r.checked) >= rangeRecheck {
		r.checked = r.now()
		for _, f := range r.files {
			r.reload(f)
		}
	}
	for _, nets := range r.nets {
		for _, n := range nets {
			if n.Contains(ip) {
				return true
			}
		}
	}
	return false
}

func (r *edgeRanges) reload(file string) {
	info, err := os.Stat(file)
	if err != nil || info.ModTime().Equal(r.mtimes[file]) {
		return
	}
	body, err := os.ReadFile(file)
	if err != nil {
		return
	}
	var listed struct {
		IPv4 []string `json:"ipv4"`
		IPv6 []string `json:"ipv6"`
	}
	if json.Unmarshal(body, &listed) != nil {
		return
	}
	var nets []*net.IPNet
	for _, cidr := range append(listed.IPv4, listed.IPv6...) {
		_, n, err := net.ParseCIDR(cidr)
		if err != nil {
			return
		}
		nets = append(nets, n)
	}
	r.mtimes[file], r.nets[file] = info.ModTime(), nets
}
