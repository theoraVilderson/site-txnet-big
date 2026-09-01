// Package cache provides a minimal Redis client for session liveness checks.
// It implements connection pooling and supports only GET and AUTH commands.
package cache

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Client is a connection-pooled Redis client that speaks RESP directly.
type Client struct {
	addr        string
	password    string
	dialTimeout time.Duration
	readTimeout time.Duration
	pool        chan net.Conn
}

// New creates a new Redis client from a URL (e.g., redis://user:pass@host:port/0).
// It returns an error if the URL is invalid or connection cannot be established.
func New(redisURL string, poolSize int, dialTimeout, readTimeout time.Duration) (*Client, error) {
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
		dialTimeout: dialTimeout,
		readTimeout: readTimeout,
		pool:        make(chan net.Conn, poolSize),
	}, nil
}

// SessionActive checks whether the given Redis key exists.
// It returns true if the key has a non-empty value (session active).
func (c *Client) SessionActive(key string) (bool, error) {
	conn, err := c.acquire()
	if err != nil {
		return false, err
	}

	value, err := c.exec(conn, "GET", key)
	if err != nil {
		_ = conn.Close() // Don't reuse a broken connection.
		return false, err
	}

	c.release(conn)
	return value != "", nil
}

// Close drains and closes all pooled connections.
func (c *Client) Close() {
	close(c.pool)
	for conn := range c.pool {
		_ = conn.Close()
	}
}

// acquire returns a connection from the pool or creates a new one if pool is empty.
func (c *Client) acquire() (net.Conn, error) {
	select {
	case conn := <-c.pool:
		return conn, nil
	default:
		return c.dial()
	}
}

// release returns the connection to the pool or closes it if pool is full.
func (c *Client) release(conn net.Conn) {
	select {
	case c.pool <- conn:
	default:
		_ = conn.Close()
	}
}

// dial establishes a new TCP connection to Redis and authenticates if password is set.
func (c *Client) dial() (net.Conn, error) {
	conn, err := net.DialTimeout("tcp", c.addr, c.dialTimeout)
	if err != nil {
		return nil, fmt.Errorf("cache: dial: %w", err)
	}
	if c.password != "" {
		if _, err := c.exec(conn, "AUTH", c.password); err != nil {
			_ = conn.Close()
			return nil, fmt.Errorf("cache: auth: %w", err)
		}
	}
	return conn, nil
}

// exec sends a command to Redis and returns the raw reply as a string.
func (c *Client) exec(conn net.Conn, args ...string) (string, error) {
	if err := conn.SetDeadline(time.Now().Add(c.readTimeout)); err != nil {
		return "", fmt.Errorf("cache: set deadline: %w", err)
	}

	var b strings.Builder
	fmt.Fprintf(&b, "*%d\r\n", len(args))
	for _, arg := range args {
		fmt.Fprintf(&b, "$%d\r\n%s\r\n", len(arg), arg)
	}
	if _, err := conn.Write([]byte(b.String())); err != nil {
		return "", fmt.Errorf("cache: write: %w", err)
	}

	return readReply(bufio.NewReader(conn))
}

// readReply parses the RESP reply from Redis.
func readReply(reader *bufio.Reader) (string, error) {
	line, err := reader.ReadString('\n')
	if err != nil {
		return "", fmt.Errorf("cache: read: %w", err)
	}
	line = strings.TrimSpace(line)

	switch {
	case strings.HasPrefix(line, "-"):
		return "", fmt.Errorf("redis: %s", strings.TrimPrefix(line, "-"))
	case line == "$-1", line == "*-1":
		return "", nil
	case strings.HasPrefix(line, ":"):
		return strings.TrimPrefix(line, ":"), nil
	case strings.HasPrefix(line, "+"):
		return strings.TrimPrefix(line, "+"), nil
	case strings.HasPrefix(line, "$"):
		n, err := strconv.Atoi(strings.TrimPrefix(line, "$"))
		if err != nil {
			return "", fmt.Errorf("cache: malformed bulk length: %w", err)
		}
		if n < 0 {
			return "", nil
		}
		data := make([]byte, n+2)
		if _, err := io.ReadFull(reader, data); err != nil {
			return "", fmt.Errorf("cache: read bulk: %w", err)
		}
		return string(data[:n]), nil
	default:
		return "", fmt.Errorf("cache: unsupported redis reply: %q", line)
	}
}
