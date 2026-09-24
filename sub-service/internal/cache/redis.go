// Package cache is this service's Redis: the handful of commands the `/sub`
// render cache needs (F-113-c), spoken as RESP directly, and the key builders
// for the `sub:` family.
//
// It is the shape of `auth-handler/internal/cache`, with the two things that
// client does not do: binary-safe values and array replies (`MGET`, `TIME`).
// No third-party client, so the image keeps pulling nothing but pgx.
package cache

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Client is a connection-pooled Redis client. Every key it is given is
// already prefixed (keys.go).
type Client struct {
	addr        string
	password    string
	db          string
	dialTimeout time.Duration
	timeout     time.Duration
	pool        chan *conn
}

type conn struct {
	net.Conn
	r *bufio.Reader
}

// New builds a client from a URL (`redis://[:password@]host[:port][/db]`). It
// does not connect: the first command does, so a Redis that is down at boot
// costs cache misses, not a refusal to serve.
func New(redisURL string, poolSize int, dialTimeout, timeout time.Duration) (*Client, error) {
	u, err := url.Parse(redisURL)
	if err != nil {
		return nil, fmt.Errorf("cache: invalid redis url: %w", err)
	}
	addr := u.Host
	if addr == "" {
		addr = "127.0.0.1:6379"
	}
	if !strings.Contains(addr, ":") {
		addr += ":6379"
	}
	password := ""
	if u.User != nil {
		password, _ = u.User.Password()
	}
	if poolSize <= 0 {
		poolSize = 10
	}
	return &Client{
		addr:        addr,
		password:    password,
		db:          strings.TrimPrefix(u.Path, "/"),
		dialTimeout: dialTimeout,
		timeout:     timeout,
		pool:        make(chan *conn, poolSize),
	}, nil
}

// Get reads one value; a missing key is ok=false.
func (c *Client) Get(ctx context.Context, key string) ([]byte, bool, error) {
	reply, err := c.do(ctx, "GET", key)
	if err != nil {
		return nil, false, err
	}
	if reply == nil {
		return nil, false, nil
	}
	b, ok := reply.([]byte)
	if !ok {
		return nil, false, fmt.Errorf("cache: GET: unexpected reply %T", reply)
	}
	return b, true, nil
}

// MGet reads several values in one round trip; a missing key reads as "".
func (c *Client) MGet(ctx context.Context, keys ...string) ([]string, error) {
	reply, err := c.do(ctx, append([]string{"MGET"}, keys...)...)
	if err != nil {
		return nil, err
	}
	items, ok := reply.([]any)
	if !ok || len(items) != len(keys) {
		return nil, fmt.Errorf("cache: MGET: unexpected reply %T", reply)
	}
	values := make([]string, len(keys))
	for i, item := range items {
		if b, ok := item.([]byte); ok {
			values[i] = string(b)
		}
	}
	return values, nil
}

// Set writes a value that expires after ttl (whole seconds, at least one).
func (c *Client) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	secs := int64(ttl / time.Second)
	if secs < 1 {
		secs = 1
	}
	_, err := c.do(ctx, "SET", key, string(value), "EX", strconv.FormatInt(secs, 10))
	return err
}

// Now is the Redis server's clock, in microseconds. Every stamp this service
// writes or compares is read from it, so no two replicas' clocks are ever
// compared with each other.
func (c *Client) Now(ctx context.Context) (int64, error) {
	reply, err := c.do(ctx, "TIME")
	if err != nil {
		return 0, err
	}
	items, ok := reply.([]any)
	if !ok || len(items) != 2 {
		return 0, fmt.Errorf("cache: TIME: unexpected reply %T", reply)
	}
	secs, err1 := strconv.ParseInt(string(asBytes(items[0])), 10, 64)
	micros, err2 := strconv.ParseInt(string(asBytes(items[1])), 10, 64)
	if err1 != nil || err2 != nil {
		return 0, fmt.Errorf("cache: TIME: malformed reply")
	}
	return secs*1_000_000 + micros, nil
}

// Close drains and closes the pooled connections.
func (c *Client) Close() {
	close(c.pool)
	for cn := range c.pool {
		_ = cn.Close()
	}
}

// do runs one command. Any error discards the connection: a reply half-read
// would otherwise be handed to the next command.
func (c *Client) do(ctx context.Context, args ...string) (any, error) {
	cn, err := c.acquire()
	if err != nil {
		return nil, err
	}
	reply, err := c.exec(ctx, cn, args...)
	if err != nil {
		var redisErr redisError
		if !errors.As(err, &redisErr) {
			_ = cn.Close()
			return nil, err
		}
	}
	c.release(cn)
	return reply, err
}

func (c *Client) acquire() (*conn, error) {
	select {
	case cn := <-c.pool:
		return cn, nil
	default:
		return c.dial()
	}
}

func (c *Client) release(cn *conn) {
	select {
	case c.pool <- cn:
	default:
		_ = cn.Close()
	}
}

func (c *Client) dial() (*conn, error) {
	nc, err := net.DialTimeout("tcp", c.addr, c.dialTimeout)
	if err != nil {
		return nil, fmt.Errorf("cache: dial: %w", err)
	}
	cn := &conn{Conn: nc, r: bufio.NewReader(nc)}
	if c.password != "" {
		if _, err := c.exec(context.Background(), cn, "AUTH", c.password); err != nil {
			_ = nc.Close()
			return nil, fmt.Errorf("cache: auth: %w", err)
		}
	}
	if c.db != "" && c.db != "0" {
		if _, err := c.exec(context.Background(), cn, "SELECT", c.db); err != nil {
			_ = nc.Close()
			return nil, fmt.Errorf("cache: select: %w", err)
		}
	}
	return cn, nil
}

func (c *Client) exec(ctx context.Context, cn *conn, args ...string) (any, error) {
	deadline := time.Now().Add(c.timeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	if err := cn.SetDeadline(deadline); err != nil {
		return nil, fmt.Errorf("cache: set deadline: %w", err)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "*%d\r\n", len(args))
	for _, arg := range args {
		fmt.Fprintf(&b, "$%d\r\n%s\r\n", len(arg), arg)
	}
	if _, err := cn.Write([]byte(b.String())); err != nil {
		return nil, fmt.Errorf("cache: write: %w", err)
	}
	return readReply(cn.r)
}

// redisError is an error reply: the connection is still in sync after it.
type redisError string

func (e redisError) Error() string { return "redis: " + string(e) }

// readReply parses one RESP2 reply: nil for a null, []byte for a string or a
// number, []any for an array.
func readReply(r *bufio.Reader) (any, error) {
	line, err := r.ReadString('\n')
	if err != nil {
		return nil, fmt.Errorf("cache: read: %w", err)
	}
	line = strings.TrimRight(line, "\r\n")
	if line == "" {
		return nil, fmt.Errorf("cache: empty reply line")
	}
	switch line[0] {
	case '-':
		return nil, redisError(line[1:])
	case '+', ':':
		return []byte(line[1:]), nil
	case '$':
		n, err := strconv.Atoi(line[1:])
		if err != nil {
			return nil, fmt.Errorf("cache: malformed bulk length: %w", err)
		}
		if n < 0 {
			return nil, nil
		}
		data := make([]byte, n+2)
		if _, err := io.ReadFull(r, data); err != nil {
			return nil, fmt.Errorf("cache: read bulk: %w", err)
		}
		return data[:n], nil
	case '*':
		n, err := strconv.Atoi(line[1:])
		if err != nil {
			return nil, fmt.Errorf("cache: malformed array length: %w", err)
		}
		if n < 0 {
			return nil, nil
		}
		items := make([]any, n)
		for i := range items {
			if items[i], err = readReply(r); err != nil {
				return nil, err
			}
		}
		return items, nil
	default:
		return nil, fmt.Errorf("cache: unsupported redis reply: %q", line)
	}
}

func asBytes(v any) []byte {
	b, _ := v.([]byte)
	return b
}
