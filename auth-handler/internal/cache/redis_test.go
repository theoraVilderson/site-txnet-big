package cache

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// This package speaks RESP by hand instead of using a driver, so the protocol
// parser is ours to get wrong. Every reply shape Redis can return to GET or
// AUTH is exercised here against a scripted TCP server — that is cheap enough
// to cover the malformed and truncated cases a real server will not produce on
// demand. redis_integration_test.go covers the same client against a real one.

// fakeRedis is a TCP listener that hands each connection a scripted reply and
// records what was written to it.
type fakeRedis struct {
	t        *testing.T
	ln       net.Listener
	mu       sync.Mutex
	requests []string
	// reply is called per accepted connection; it returns the bytes to write
	// back for each command read. Returning ("", false) closes the connection.
	reply func(request string) (string, bool)
	// hang blocks instead of replying, for deadline tests.
	hang bool
	// closed by the test cleanup so a hung handler can unblock and exit.
	shutdown chan struct{}
	wg       sync.WaitGroup
}

func newFakeRedis(t *testing.T, reply func(request string) (string, bool)) *fakeRedis {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	f := &fakeRedis{t: t, ln: ln, reply: reply, shutdown: make(chan struct{})}
	f.wg.Add(1)
	go f.serve()
	t.Cleanup(func() {
		close(f.shutdown)
		_ = ln.Close()
		f.wg.Wait()
	})
	return f
}

func (f *fakeRedis) serve() {
	defer f.wg.Done()
	for {
		conn, err := f.ln.Accept()
		if err != nil {
			return
		}
		f.wg.Add(1)
		go func() {
			defer f.wg.Done()
			defer conn.Close()
			reader := bufio.NewReader(conn)
			for {
				request, err := readCommand(reader)
				if err != nil {
					return
				}
				f.mu.Lock()
				f.requests = append(f.requests, request)
				f.mu.Unlock()
				if f.hang {
					// Hold the connection open without replying; the client's
					// read deadline is what must end the call.
					<-f.shutdown
					return
				}
				out, keepOpen := f.reply(request)
				if out != "" {
					if _, err := conn.Write([]byte(out)); err != nil {
						return
					}
				}
				if !keepOpen {
					return
				}
			}
		}()
	}
}

func (f *fakeRedis) url() string { return "redis://" + f.ln.Addr().String() }

func (f *fakeRedis) seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.requests...)
}

// readCommand parses one RESP array command and returns it space-joined,
// e.g. "GET session:1".
func readCommand(r *bufio.Reader) (string, error) {
	header, err := r.ReadString('\n')
	if err != nil {
		return "", err
	}
	header = strings.TrimSpace(header)
	if !strings.HasPrefix(header, "*") {
		return "", fmt.Errorf("not an array: %q", header)
	}
	var count int
	if _, err := fmt.Sscanf(header, "*%d", &count); err != nil {
		return "", err
	}
	parts := make([]string, 0, count)
	for i := 0; i < count; i++ {
		lenLine, err := r.ReadString('\n')
		if err != nil {
			return "", err
		}
		var n int
		if _, err := fmt.Sscanf(strings.TrimSpace(lenLine), "$%d", &n); err != nil {
			return "", err
		}
		buf := make([]byte, n+2)
		if _, err := io.ReadFull(r, buf); err != nil {
			return "", err
		}
		parts = append(parts, string(buf[:n]))
	}
	return strings.Join(parts, " "), nil
}

func alwaysReply(out string) func(string) (string, bool) {
	return func(string) (string, bool) { return out, true }
}

func newTestClient(t *testing.T, url string) *Client {
	t.Helper()
	c, err := New(url, 2, 500*time.Millisecond, 500*time.Millisecond)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(c.Close)
	return c
}

// --- New: URL parsing ---

func TestNewParsesRedisURL(t *testing.T) {
	tests := []struct {
		name         string
		url          string
		wantAddr     string
		wantPassword string
	}{
		{"host and port", "redis://10.0.0.5:6380", "10.0.0.5:6380", ""},
		{"port defaulted", "redis://redis", "redis:6379", ""},
		{"empty host", "redis://", "127.0.0.1:6379", ""},
		{"password only", "redis://:secret@redis:6379", "redis:6379", "secret"},
		{"user and password", "redis://default:secret@redis:6379", "redis:6379", "secret"},
		{"user without password", "redis://default@redis:6379", "redis:6379", ""},
		{"db suffix ignored", "redis://redis:6379/0", "redis:6379", ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c, err := New(tc.url, 1, time.Second, time.Second)
			if err != nil {
				t.Fatalf("New(%q): %v", tc.url, err)
			}
			if c.addr != tc.wantAddr {
				t.Errorf("addr = %q, want %q", c.addr, tc.wantAddr)
			}
			if c.password != tc.wantPassword {
				t.Errorf("password = %q, want %q", c.password, tc.wantPassword)
			}
		})
	}
}

func TestNewRejectsInvalidURL(t *testing.T) {
	if _, err := New("://not a url", 1, time.Second, time.Second); err == nil {
		t.Fatal("expected an error for a malformed URL")
	}
}

func TestNewDefaultsPoolSize(t *testing.T) {
	// A zero or negative pool size would make `release` close every connection
	// and `acquire` dial on every request.
	for _, size := range []int{0, -1} {
		c, err := New("redis://redis:6379", size, time.Second, time.Second)
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		if got := cap(c.pool); got != 10 {
			t.Errorf("poolSize %d: cap(pool) = %d, want 10", size, got)
		}
	}
}

func TestNewDoesNotDial(t *testing.T) {
	// Construction must not touch the network: the gateway builds its client at
	// startup and must come up even if Redis is briefly down.
	if _, err := New("redis://127.0.0.1:1", 1, time.Millisecond, time.Millisecond); err != nil {
		t.Fatalf("New should not connect: %v", err)
	}
}

// --- readReply: the RESP parser ---

func TestReadReply(t *testing.T) {
	tests := []struct {
		name  string
		wire  string
		want  string
		isErr bool
	}{
		{name: "simple string", wire: "+OK\r\n", want: "OK"},
		{name: "empty simple string", wire: "+\r\n", want: ""},
		{name: "integer", wire: ":1\r\n", want: "1"},
		{name: "negative integer", wire: ":-3\r\n", want: "-3"},
		{name: "bulk string", wire: "$5\r\nhello\r\n", want: "hello"},
		{name: "empty bulk string", wire: "$0\r\n\r\n", want: ""},
		{name: "bulk with embedded CRLF", wire: "$7\r\na\r\nb\r\nc\r\n", want: "a\r\nb\r\nc"},
		{name: "bulk with spaces preserved", wire: "$5\r\n a b \r\n", want: " a b "},
		{name: "null bulk", wire: "$-1\r\n", want: ""},
		{name: "null array", wire: "*-1\r\n", want: ""},
		{name: "error reply", wire: "-ERR unknown command\r\n", isErr: true},
		{name: "wrongtype error", wire: "-WRONGTYPE not a string\r\n", isErr: true},
		{name: "malformed bulk length", wire: "$abc\r\n", isErr: true},
		{name: "truncated bulk body", wire: "$10\r\nshort", isErr: true},
		{name: "unsupported type", wire: "%1\r\n", isErr: true},
		{name: "empty stream", wire: "", isErr: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := readReply(bufio.NewReader(strings.NewReader(tc.wire)))
			if tc.isErr {
				if err == nil {
					t.Fatalf("readReply(%q) = %q, want an error", tc.wire, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("readReply(%q): %v", tc.wire, err)
			}
			if got != tc.want {
				t.Errorf("readReply(%q) = %q, want %q", tc.wire, got, tc.want)
			}
		})
	}
}

func TestReadReplyErrorCarriesRedisMessage(t *testing.T) {
	// The gateway logs this; losing the server's text turns "NOAUTH" into an
	// unexplained 500.
	_, err := readReply(bufio.NewReader(strings.NewReader("-NOAUTH Authentication required.\r\n")))
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "NOAUTH Authentication required.") {
		t.Errorf("error = %q, want it to carry the server message", err)
	}
}

// --- exec: RESP command encoding ---

func TestExecEncodesCommandAsRespArray(t *testing.T) {
	var got string
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		buf := make([]byte, 128)
		n, _ := conn.Read(buf)
		got = string(buf[:n])
		_, _ = conn.Write([]byte("$3\r\nabc\r\n"))
	}()

	c := newTestClient(t, "redis://"+ln.Addr().String())
	if _, err := c.SessionActive("txnet:auth:v1:session:s1"); err != nil {
		t.Fatalf("SessionActive: %v", err)
	}
	<-done

	want := "*2\r\n$3\r\nGET\r\n$24\r\ntxnet:auth:v1:session:s1\r\n"
	if got != want {
		t.Errorf("wire bytes =\n%q\nwant\n%q", got, want)
	}
}

// --- SessionActive ---

func TestSessionActive(t *testing.T) {
	tests := []struct {
		name      string
		reply     string
		wantAlive bool
		wantErr   bool
	}{
		{name: "session payload", reply: "$24\r\n{\"userId\":\"u1\",\"x\":true}\r\n", wantAlive: true},
		{name: "missing key", reply: "$-1\r\n", wantAlive: false},
		{name: "empty value counts as revoked", reply: "$0\r\n\r\n", wantAlive: false},
		{name: "server error", reply: "-ERR something\r\n", wantErr: true},
		{name: "unparseable reply", reply: "%1\r\n", wantErr: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeRedis(t, alwaysReply(tc.reply))
			c := newTestClient(t, f.url())

			alive, err := c.SessionActive("session:1")
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected an error, got alive=%v", alive)
				}
				return
			}
			if err != nil {
				t.Fatalf("SessionActive: %v", err)
			}
			if alive != tc.wantAlive {
				t.Errorf("alive = %v, want %v", alive, tc.wantAlive)
			}
		})
	}
}

func TestSessionActiveSendsTheKeyVerbatim(t *testing.T) {
	// The prefix is assembled by the caller (handlers.Handler); this client
	// must not add, trim or normalise anything.
	f := newFakeRedis(t, alwaysReply("$1\r\nx\r\n"))
	c := newTestClient(t, f.url())

	key := "txnet:auth:v1:session:abc-123"
	if _, err := c.SessionActive(key); err != nil {
		t.Fatalf("SessionActive: %v", err)
	}

	if seen := f.seen(); len(seen) != 1 || seen[0] != "GET "+key {
		t.Errorf("server saw %q, want [\"GET %s\"]", seen, key)
	}
}

// --- pooling ---

func TestPoolReusesConnections(t *testing.T) {
	var conns int
	var mu sync.Mutex
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			conns++
			mu.Unlock()
			go func() {
				defer conn.Close()
				reader := bufio.NewReader(conn)
				for {
					if _, err := readCommand(reader); err != nil {
						return
					}
					if _, err := conn.Write([]byte("$1\r\nx\r\n")); err != nil {
						return
					}
				}
			}()
		}
	}()

	c := newTestClient(t, "redis://"+ln.Addr().String())
	for i := 0; i < 5; i++ {
		if _, err := c.SessionActive("session:1"); err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
	}

	mu.Lock()
	defer mu.Unlock()
	if conns != 1 {
		t.Errorf("dialled %d connections for 5 sequential calls, want 1", conns)
	}
}

func TestPoolDiscardsConnectionAfterError(t *testing.T) {
	// A connection that produced a protocol error may have unread bytes left in
	// it; handing it to the next request would misalign every later reply.
	f := newFakeRedis(t, alwaysReply("-ERR boom\r\n"))
	c := newTestClient(t, f.url())

	if _, err := c.SessionActive("session:1"); err == nil {
		t.Fatal("expected an error")
	}
	if got := len(c.pool); got != 0 {
		t.Errorf("pool holds %d connections after an error, want 0", got)
	}
}

func TestPoolReturnsConnectionAfterSuccess(t *testing.T) {
	f := newFakeRedis(t, alwaysReply("$1\r\nx\r\n"))
	c := newTestClient(t, f.url())

	if _, err := c.SessionActive("session:1"); err != nil {
		t.Fatalf("SessionActive: %v", err)
	}
	if got := len(c.pool); got != 1 {
		t.Errorf("pool holds %d connections after success, want 1", got)
	}
}

func TestPoolCapIsRespected(t *testing.T) {
	f := newFakeRedis(t, alwaysReply("$1\r\nx\r\n"))
	c, err := New(f.url(), 2, time.Second, time.Second)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer c.Close()

	// More concurrent callers than the pool can hold: the extra connections
	// must be closed on release rather than blocking or growing the pool.
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.SessionActive("session:1"); err != nil {
				t.Errorf("SessionActive: %v", err)
			}
		}()
	}
	wg.Wait()

	if got := len(c.pool); got > cap(c.pool) {
		t.Errorf("pool holds %d connections, cap is %d", got, cap(c.pool))
	}
}

func TestConcurrentCallsAllSucceed(t *testing.T) {
	f := newFakeRedis(t, alwaysReply("$2\r\nok\r\n"))
	c := newTestClient(t, f.url())

	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			alive, err := c.SessionActive("session:1")
			if err != nil {
				errs <- err
				return
			}
			if !alive {
				errs <- fmt.Errorf("session reported inactive")
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent call: %v", err)
	}
}

// --- AUTH ---

func TestDialAuthenticatesWhenPasswordIsSet(t *testing.T) {
	f := newFakeRedis(t, func(request string) (string, bool) {
		if strings.HasPrefix(request, "AUTH") {
			return "+OK\r\n", true
		}
		return "$1\r\nx\r\n", true
	})
	c := newTestClient(t, "redis://:s3cret@"+f.ln.Addr().String())

	if _, err := c.SessionActive("session:1"); err != nil {
		t.Fatalf("SessionActive: %v", err)
	}

	seen := f.seen()
	if len(seen) != 2 || seen[0] != "AUTH s3cret" || seen[1] != "GET session:1" {
		t.Errorf("server saw %q, want AUTH then GET", seen)
	}
}

func TestDialSkipsAuthWhenNoPassword(t *testing.T) {
	f := newFakeRedis(t, alwaysReply("$1\r\nx\r\n"))
	c := newTestClient(t, f.url())

	if _, err := c.SessionActive("session:1"); err != nil {
		t.Fatalf("SessionActive: %v", err)
	}

	if seen := f.seen(); len(seen) != 1 || seen[0] != "GET session:1" {
		t.Errorf("server saw %q, want only the GET", seen)
	}
}

func TestDialFailsWhenAuthIsRejected(t *testing.T) {
	f := newFakeRedis(t, alwaysReply("-WRONGPASS invalid password\r\n"))
	c := newTestClient(t, "redis://:wrong@"+f.ln.Addr().String())

	_, err := c.SessionActive("session:1")
	if err == nil {
		t.Fatal("expected an error when AUTH is rejected")
	}
	if !strings.Contains(err.Error(), "auth") {
		t.Errorf("error = %q, want it to name the auth step", err)
	}
	if got := len(c.pool); got != 0 {
		t.Errorf("pool holds %d connections after a failed AUTH, want 0", got)
	}
}

// --- timeouts ---

func TestDialTimeoutIsApplied(t *testing.T) {
	// 203.0.113.0/24 is TEST-NET-3: routable-looking, never answers.
	c, err := New("redis://203.0.113.1:6379", 1, 150*time.Millisecond, time.Second)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer c.Close()

	start := time.Now()
	if _, err := c.SessionActive("session:1"); err == nil {
		t.Fatal("expected a dial error")
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Errorf("dial took %v; the dial timeout was not applied", elapsed)
	}
}

func TestReadTimeoutIsApplied(t *testing.T) {
	// A Redis that accepts the connection and then never answers must not hold
	// a gateway request open: every ForwardAuth call waits on this.
	f := newFakeRedis(t, alwaysReply(""))
	f.hang = true
	c, err := New(f.url(), 1, time.Second, 150*time.Millisecond)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer c.Close()

	start := time.Now()
	_, err = c.SessionActive("session:1")
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected a read timeout error")
	}
	if elapsed > time.Second {
		t.Errorf("call took %v, want it cut off near the 150ms read timeout", elapsed)
	}
}

func TestClosedServerSurfacesAnError(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close() // nothing is listening now

	c := newTestClient(t, "redis://"+addr)
	if _, err := c.SessionActive("session:1"); err == nil {
		t.Fatal("expected a dial error against a closed port")
	}
}

func TestServerHangsUpMidReply(t *testing.T) {
	f := newFakeRedis(t, func(string) (string, bool) {
		return "$10\r\nshort", false // truncated body, then close
	})
	c := newTestClient(t, f.url())

	if _, err := c.SessionActive("session:1"); err == nil {
		t.Fatal("expected an error for a truncated bulk reply")
	}
}
