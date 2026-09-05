//go:build integration

// Integration coverage for the hand-written RESP client, run against a real
// Redis rather than the scripted server in redis_test.go. The unit tests prove
// the parser handles every reply shape; this proves the shapes we assume are
// the ones Redis actually sends — and that a pooled connection stays usable
// across commands, which no fake can settle.
//
//	docker run --rm -d -p 6399:6379 --name txnet-cache-it docker.arvancloud.ir/redis:8.8-alpine
//	REDIS_TEST_URL=redis://127.0.0.1:6399 go test -tags integration ./internal/cache/
//
// Skipped unless REDIS_TEST_URL is set, so `go test ./...` stays hermetic.
package cache

import (
	"bufio"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

const keyPrefix = "txnet:auth:test:"

func integrationURL(t *testing.T) string {
	t.Helper()
	redisURL := os.Getenv("REDIS_TEST_URL")
	if redisURL == "" {
		t.Skip("REDIS_TEST_URL not set; skipping the real-Redis integration tests")
	}
	return redisURL
}

// seed talks to Redis over its own connection so the client under test is never
// the thing that wrote the fixture.
func seed(t *testing.T, redisURL string, args ...string) string {
	t.Helper()
	u, err := url.Parse(redisURL)
	if err != nil {
		t.Fatalf("parse REDIS_TEST_URL: %v", err)
	}
	conn, err := net.DialTimeout("tcp", u.Host, 2*time.Second)
	if err != nil {
		t.Fatalf("dial redis: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))

	if u.User != nil {
		if password, ok := u.User.Password(); ok && password != "" {
			if _, err := writeCommand(conn, "AUTH", password); err != nil {
				t.Fatalf("auth: %v", err)
			}
		}
	}
	reply, err := writeCommand(conn, args...)
	if err != nil {
		t.Fatalf("%v: %v", args, err)
	}
	return reply
}

func writeCommand(conn net.Conn, args ...string) (string, error) {
	var b strings.Builder
	fmt.Fprintf(&b, "*%d\r\n", len(args))
	for _, arg := range args {
		fmt.Fprintf(&b, "$%d\r\n%s\r\n", len(arg), arg)
	}
	if _, err := conn.Write([]byte(b.String())); err != nil {
		return "", err
	}
	return readReply(bufio.NewReader(conn))
}

func newTestClientFor(t *testing.T, redisURL string) *Client {
	t.Helper()
	c, err := New(redisURL, 4, 2*time.Second, 2*time.Second)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(c.Close)
	return c
}

func TestIntegrationSessionActive(t *testing.T) {
	redisURL := integrationURL(t)
	c := newTestClientFor(t, redisURL)

	key := keyPrefix + "session:live"
	seed(t, redisURL, "SET", key, `{"userId":"u1","revoked":false}`, "EX", "60")
	t.Cleanup(func() { seed(t, redisURL, "DEL", key) })

	alive, err := c.SessionActive(key)
	if err != nil {
		t.Fatalf("SessionActive: %v", err)
	}
	if !alive {
		t.Error("a session written by auth-service reads as inactive")
	}
}

func TestIntegrationMissingKeyIsNotAnError(t *testing.T) {
	redisURL := integrationURL(t)
	c := newTestClientFor(t, redisURL)

	// A revoked session is a deleted key. Redis answers $-1, and the gateway
	// must read that as "not active", not as "Redis is broken" — the two lead
	// to different HTTP statuses.
	alive, err := c.SessionActive(keyPrefix + "session:definitely-absent")
	if err != nil {
		t.Fatalf("SessionActive on a missing key returned an error: %v", err)
	}
	if alive {
		t.Error("a missing key reads as an active session")
	}
}

func TestIntegrationSessionExpiresOnItsOwn(t *testing.T) {
	redisURL := integrationURL(t)
	c := newTestClientFor(t, redisURL)

	key := keyPrefix + "session:expiring"
	seed(t, redisURL, "SET", key, "x", "PX", "150")

	if alive, err := c.SessionActive(key); err != nil || !alive {
		t.Fatalf("before expiry: alive=%v err=%v", alive, err)
	}

	time.Sleep(300 * time.Millisecond)

	alive, err := c.SessionActive(key)
	if err != nil {
		t.Fatalf("after expiry: %v", err)
	}
	if alive {
		t.Error("an expired session still reads as active")
	}
}

func TestIntegrationLargePayloadCrossesTheBufferBoundary(t *testing.T) {
	redisURL := integrationURL(t)
	c := newTestClientFor(t, redisURL)

	// bufio's default buffer is 4096 bytes; a bulk reply larger than that is
	// the case where a parser that forgets io.ReadFull silently truncates.
	key := keyPrefix + "session:large"
	seed(t, redisURL, "SET", key, strings.Repeat("a", 10_000))
	t.Cleanup(func() { seed(t, redisURL, "DEL", key) })

	alive, err := c.SessionActive(key)
	if err != nil {
		t.Fatalf("SessionActive: %v", err)
	}
	if !alive {
		t.Error("a large session payload read as inactive")
	}
}

func TestIntegrationPooledConnectionSurvivesManyCommands(t *testing.T) {
	redisURL := integrationURL(t)
	c := newTestClientFor(t, redisURL)

	present := keyPrefix + "session:pooled"
	seed(t, redisURL, "SET", present, "x")
	t.Cleanup(func() { seed(t, redisURL, "DEL", present) })
	absent := keyPrefix + "session:pooled-absent"

	// Alternating hit/miss on a reused connection: if readReply ever left a
	// stray "\r\n" in the stream, the next reply would be misparsed.
	for i := 0; i < 25; i++ {
		alive, err := c.SessionActive(present)
		if err != nil || !alive {
			t.Fatalf("iteration %d (present): alive=%v err=%v", i, alive, err)
		}
		alive, err = c.SessionActive(absent)
		if err != nil || alive {
			t.Fatalf("iteration %d (absent): alive=%v err=%v", i, alive, err)
		}
	}
}

func TestIntegrationConcurrentLookups(t *testing.T) {
	redisURL := integrationURL(t)
	c := newTestClientFor(t, redisURL)

	key := keyPrefix + "session:concurrent"
	seed(t, redisURL, "SET", key, "x")
	t.Cleanup(func() { seed(t, redisURL, "DEL", key) })

	// Every ForwardAuth request goes through this client; the pool has to hold
	// up when more callers arrive at once than it has connections.
	errs := make(chan error, 50)
	done := make(chan struct{})
	for i := 0; i < 50; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			alive, err := c.SessionActive(key)
			if err != nil {
				errs <- err
			} else if !alive {
				errs <- fmt.Errorf("session reported inactive")
			}
		}()
	}
	for i := 0; i < 50; i++ {
		<-done
	}
	close(errs)
	for err := range errs {
		t.Errorf("concurrent lookup: %v", err)
	}
}

func TestIntegrationWrongTypeIsReportedAsAnError(t *testing.T) {
	redisURL := integrationURL(t)
	c := newTestClientFor(t, redisURL)

	// GET against a SET key: a real error reply, which must not be mistaken
	// for "no session" — that would fail open into a 401 storm rather than a
	// logged fault.
	key := keyPrefix + "session:wrongtype"
	seed(t, redisURL, "DEL", key)
	seed(t, redisURL, "SADD", key, "member")
	t.Cleanup(func() { seed(t, redisURL, "DEL", key) })

	if _, err := c.SessionActive(key); err == nil {
		t.Fatal("expected an error for a WRONGTYPE reply")
	} else if !strings.Contains(err.Error(), "WRONGTYPE") {
		t.Errorf("error = %q, want it to carry WRONGTYPE", err)
	}
}

func TestIntegrationAuthFailureIsSurfaced(t *testing.T) {
	redisURL := integrationURL(t)
	u, err := url.Parse(redisURL)
	if err != nil {
		t.Fatalf("parse REDIS_TEST_URL: %v", err)
	}

	c, err := New("redis://:definitely-not-the-password@"+u.Host, 1, 2*time.Second, 2*time.Second)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer c.Close()

	// On a Redis with no password this is ERR ("without any password
	// configured"); on one with a password it is WRONGPASS. Either way the
	// client must refuse the connection instead of proceeding unauthenticated.
	if _, err := c.SessionActive(keyPrefix + "session:whatever"); err == nil {
		t.Fatal("expected AUTH with a bogus password to fail")
	}
}
