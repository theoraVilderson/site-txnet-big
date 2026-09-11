package handlers

import (
	"bufio"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"auth-handler/internal/api/middlewares"
	"auth-handler/internal/auth"
	"auth-handler/internal/cache"
	"auth-handler/internal/locale"
)

// Validate is the whole gateway as Traefik sees it: ForwardAuth forwards the
// request upstream only on a 2xx, so the status this handler picks is the
// access decision itself, and the X-User-* headers it sets are the identity
// every downstream service trusts. The engine, the validator and the Redis
// client each have their own tests; what is only testable here is the
// assembly — which failure becomes 401 and which becomes 403, and that the
// headers are set on success and on no other path.

const testSecret = "handler-test-secret"

// --- token minting -----------------------------------------------------

func sign(t *testing.T, claims map[string]any, secret string) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	body, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	payload := base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(header + "." + payload))
	return header + "." + payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// realRoleID is what auth-service actually signs as `roleId`: the database
// foreign key, a UUID that differs on every seed. The policy file is keyed by
// role name, which travels beside it as `roleName` (ADR-0037).
const realRoleID = "6f1c2d4e-8a3b-4c5d-9e7f-0a1b2c3d4e5f"

// validClaims is a token that passes jwt.Validate; individual tests override
// the fields they are about.
func validClaims(overrides map[string]any) map[string]any {
	claims := map[string]any{
		"sub":         "user-1",
		"tenantId":    "tenant-1",
		"roleId":      realRoleID,
		"roleName":    "admin",
		"sessionId":   "sess-1",
		"permissions": []string{"user.read", "user.write"},
		"exp":         time.Now().Add(time.Hour).Unix(),
	}
	for k, v := range overrides {
		if v == nil { // nil drops the claim, so a test can mint an older token
			delete(claims, k)
			continue
		}
		claims[k] = v
	}
	return claims
}

// --- a scripted Redis --------------------------------------------------

// fakeRedis answers GET with a scripted reply so the handler's three session
// outcomes (active, revoked, lookup failed) can each be produced on demand.
type fakeRedis struct {
	ln   net.Listener
	mu   sync.Mutex
	seen []string
	// reply returns the RESP bytes for a command; "" closes the connection,
	// which is how a lookup failure is simulated.
	reply func(cmd string) string
	wg    sync.WaitGroup
}

func newFakeRedis(t *testing.T, reply func(cmd string) string) *fakeRedis {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	f := &fakeRedis{ln: ln, reply: reply}
	f.wg.Add(1)
	go f.serve()
	t.Cleanup(func() {
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
			r := bufio.NewReader(conn)
			for {
				cmd, err := readCommand(r)
				if err != nil {
					return
				}
				f.mu.Lock()
				f.seen = append(f.seen, cmd)
				f.mu.Unlock()
				out := f.reply(cmd)
				if out == "" {
					return
				}
				if _, err := conn.Write([]byte(out)); err != nil {
					return
				}
			}
		}()
	}
}

func (f *fakeRedis) url() string { return "redis://" + f.ln.Addr().String() }

func (f *fakeRedis) commands() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.seen...)
}

// readCommand parses one RESP array and returns it space-joined.
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
		if _, err := r.ReadString('\n'); err != nil { // $<len>
			return "", err
		}
		arg, err := r.ReadString('\n')
		if err != nil {
			return "", err
		}
		parts = append(parts, strings.TrimSpace(arg))
	}
	return strings.Join(parts, " "), nil
}

// respBulk is a RESP bulk string reply; respNil is a missing key.
func respBulk(s string) string { return fmt.Sprintf("$%d\r\n%s\r\n", len(s), s) }

const respNil = "$-1\r\n"

// --- handler under test ------------------------------------------------

// sessionActive answers every GET with a live session.
func sessionActive(string) string { return respBulk("active") }

func newHandler(t *testing.T, redisReply func(string) string, engine *auth.Engine) (*Handler, *fakeRedis) {
	t.Helper()
	f := newFakeRedis(t, redisReply)
	client, err := cache.New(f.url(), 2, time.Second, time.Second)
	if err != nil {
		t.Fatalf("cache.New: %v", err)
	}
	t.Cleanup(client.Close)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return New(client, testSecret, "txnet:", engine, logger), f
}

// testEngine grants admin user.read/user.write and nothing to anyone else.
func testEngine(t *testing.T) *auth.Engine {
	t.Helper()
	path := filepath.Join(t.TempDir(), "permissions.yaml")
	policy := "roles:\n  admin:\n    permissions:\n      - user.read\n      - user.write\n  user:\n    permissions:\n      - self.read\n"
	if err := os.WriteFile(path, []byte(policy), 0o600); err != nil {
		t.Fatalf("write policy: %v", err)
	}
	engine, err := auth.LoadFile(path)
	if err != nil {
		t.Fatalf("auth.LoadFile: %v", err)
	}
	return engine
}

// call runs Validate with an optional bearer token and returns the recorder.
func call(t *testing.T, h *Handler, token string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/validate", nil)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.Validate(w, r)
	return w
}

func decode(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not JSON: %v (%q)", err, w.Body.String())
	}
	return body
}

// --- the access decision ----------------------------------------------

// Every refusal has to carry the status that makes Traefik block the request.
// A refusal answered with 200 would forward an unauthenticated request
// upstream, which is the one failure mode of a ForwardAuth gateway that no
// downstream service can catch.
func TestValidateRefusalStatuses(t *testing.T) {
	expired := sign(t, validClaims(map[string]any{"exp": time.Now().Add(-time.Hour).Unix()}), testSecret)
	wrongSecret := sign(t, validClaims(nil), "not-the-gateway-secret")

	tests := []struct {
		name       string
		token      string
		redis      func(string) string
		engine     bool
		wantStatus int
		wantMsg    string
	}{
		{
			name:       "no Authorization header",
			token:      "",
			redis:      sessionActive,
			wantStatus: http.StatusUnauthorized,
			wantMsg:    keyAuthRequired,
		},
		{
			name:       "token is not a JWT",
			token:      "garbage",
			redis:      sessionActive,
			wantStatus: http.StatusUnauthorized,
			wantMsg:    keyInvalidToken,
		},
		{
			name:       "token signed with another secret",
			token:      wrongSecret,
			redis:      sessionActive,
			wantStatus: http.StatusUnauthorized,
			wantMsg:    keyInvalidToken,
		},
		{
			name:       "token expired",
			token:      expired,
			redis:      sessionActive,
			wantStatus: http.StatusUnauthorized,
			wantMsg:    keyInvalidToken,
		},
		{
			name:       "session revoked",
			token:      sign(t, validClaims(nil), testSecret),
			redis:      func(string) string { return respNil },
			wantStatus: http.StatusUnauthorized,
			wantMsg:    keySessionRevoked,
		},
		{
			// A Redis that is down must not be read as "no session". That
			// would turn an outage into a silent mass logout; 500 says the
			// gateway could not decide, which is the truth.
			name:       "session lookup failed",
			token:      sign(t, validClaims(nil), testSecret),
			redis:      func(string) string { return "" },
			wantStatus: http.StatusInternalServerError,
			wantMsg:    keyUnexpected,
		},
		{
			name:       "claims a permission the role does not have",
			token:      sign(t, validClaims(map[string]any{"roleName": "user", "permissions": []string{"user.write"}}), testSecret),
			redis:      sessionActive,
			engine:     true,
			wantStatus: http.StatusForbidden,
			wantMsg:    keyForbidden,
		},
		{
			// A token minted before roleName existed must not slip past the
			// policy: no name is a role nobody is granted.
			name:       "token without roleName is refused by the policy",
			token:      sign(t, validClaims(map[string]any{"roleName": nil}), testSecret),
			redis:      sessionActive,
			engine:     true,
			wantStatus: http.StatusForbidden,
			wantMsg:    keyForbidden,
		},
		{
			name:       "role is not in the policy at all",
			token:      sign(t, validClaims(map[string]any{"roleName": "ghost", "permissions": []string{"user.read"}}), testSecret),
			redis:      sessionActive,
			engine:     true,
			wantStatus: http.StatusForbidden,
			wantMsg:    keyForbidden,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var engine *auth.Engine
			if tc.engine {
				engine = testEngine(t)
			}
			h, _ := newHandler(t, tc.redis, engine)
			w := call(t, h, tc.token)

			if w.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d (body %q)", w.Code, tc.wantStatus, w.Body.String())
			}
			body := decode(t, w)
			if body["ok"] != false {
				t.Errorf("ok = %v, want false", body["ok"])
			}
			if body["msg"] != tc.wantMsg {
				t.Errorf("msg = %v, want %q", body["msg"], tc.wantMsg)
			}
			// A refused request must not carry identity upstream even if
			// Traefik were misconfigured to forward it.
			for _, header := range []string{"X-User-Id", "X-Tenant-Id", "X-Role-Id", "X-User-Permissions"} {
				if got := w.Header().Get(header); got != "" {
					t.Errorf("%s = %q on a refusal, want it unset", header, got)
				}
			}
		})
	}
}

// The identity headers are the handoff to every service behind the gateway:
// downstream trusts them precisely because it cannot see the token.
//
// It is also the regression for ADR-0037: the token has a UUID `roleId`, as a
// real one does, and the policy engine is on. Looking the policy up by that id
// answered 403 to every real request.
func TestValidateSetsIdentityHeadersOnSuccess(t *testing.T) {
	h, redis := newHandler(t, sessionActive, testEngine(t))
	w := call(t, h, sign(t, validClaims(nil), testSecret))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", w.Code, w.Body.String())
	}
	want := map[string]string{
		"X-User-Id":          "user-1",
		"X-Tenant-Id":        "tenant-1",
		"X-Role-Id":          realRoleID,
		"X-User-Permissions": "user.read,user.write",
	}
	for header, value := range want {
		if got := w.Header().Get(header); got != value {
			t.Errorf("%s = %q, want %q", header, got, value)
		}
	}
	// Not an impersonated token, so the impersonation headers must be absent
	// rather than empty — downstream checks presence.
	if _, ok := w.Header()["X-Impersonated"]; ok {
		t.Errorf("X-Impersonated set on a normal token")
	}
	if _, ok := w.Header()["X-Impersonated-By"]; ok {
		t.Errorf("X-Impersonated-By set on a normal token")
	}

	body := decode(t, w)
	if body["ok"] != true || body["msg"] != msgSuccess {
		t.Errorf("body = %v, want ok/%s", body, msgSuccess)
	}

	// The session key must be the prefix plus "session:" plus the claim, or
	// the gateway reads a keyspace auth-service never writes.
	cmds := redis.commands()
	if len(cmds) != 1 || cmds[0] != "GET txnet:session:sess-1" {
		t.Errorf("redis commands = %v, want one GET of txnet:session:sess-1", cmds)
	}
}

// An impersonated request must be labelled as such all the way down, or an
// audit log downstream records the support agent's actions as the user's.
func TestValidateForwardsImpersonation(t *testing.T) {
	h, _ := newHandler(t, sessionActive, testEngine(t))
	token := sign(t, validClaims(map[string]any{
		"isImpersonated": true,
		"impersonatedBy": "support-7",
	}), testSecret)

	w := call(t, h, token)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if got := w.Header().Get("X-Impersonated"); got != "true" {
		t.Errorf("X-Impersonated = %q, want \"true\"", got)
	}
	if got := w.Header().Get("X-Impersonated-By"); got != "support-7" {
		t.Errorf("X-Impersonated-By = %q, want \"support-7\"", got)
	}
	if got := w.Header().Get("X-User-Id"); got != "user-1" {
		t.Errorf("X-User-Id = %q, want the impersonated user, not the actor", got)
	}
}

// engine == nil means policy enforcement is switched off by config; the token
// still has to be valid and the session still has to be live.
func TestValidateWithoutEngineSkipsPolicyOnly(t *testing.T) {
	h, _ := newHandler(t, sessionActive, nil)
	token := sign(t, validClaims(map[string]any{
		"roleName":    "ghost",
		"permissions": []string{"anything.at.all"},
	}), testSecret)

	w := call(t, h, token)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 with the engine disabled", w.Code)
	}
	if got := w.Header().Get("X-User-Permissions"); got != "anything.at.all" {
		t.Errorf("X-User-Permissions = %q, want the claimed permissions passed through", got)
	}
}

// A token with no permissions is a valid token; the engine has nothing to
// refuse and the header is present but empty.
func TestValidateAllowsEmptyPermissions(t *testing.T) {
	h, _ := newHandler(t, sessionActive, testEngine(t))
	token := sign(t, validClaims(map[string]any{"permissions": []string{}}), testSecret)

	w := call(t, h, token)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", w.Code, w.Body.String())
	}
	if _, ok := w.Header()["X-User-Permissions"]; !ok {
		t.Errorf("X-User-Permissions absent; downstream distinguishes empty from missing")
	}
	if got := w.Header().Get("X-User-Permissions"); got != "" {
		t.Errorf("X-User-Permissions = %q, want empty", got)
	}
}

// The header parse is a TrimPrefix, so anything that is not exactly "Bearer "
// leaves the scheme inside the token and the token then fails validation
// rather than being silently accepted.
func TestValidateBearerPrefixHandling(t *testing.T) {
	good := sign(t, validClaims(nil), testSecret)

	tests := []struct {
		name       string
		header     string
		wantStatus int
	}{
		{"canonical Bearer prefix", "Bearer " + good, http.StatusOK},
		{"lowercase scheme is not stripped", "bearer " + good, http.StatusUnauthorized},
		{"bare token with no scheme", good, http.StatusOK},
		{"scheme with no token", "Bearer ", http.StatusUnauthorized},
		{"empty header", "", http.StatusUnauthorized},
		{"whitespace only", "   ", http.StatusUnauthorized},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h, _ := newHandler(t, sessionActive, testEngine(t))
			r := httptest.NewRequest(http.MethodGet, "/validate", nil)
			if tc.header != "" {
				r.Header.Set("Authorization", tc.header)
			}
			w := httptest.NewRecorder()
			h.Validate(w, r)
			if w.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d (body %q)", w.Code, tc.wantStatus, w.Body.String())
			}
		})
	}
}

// statusForKey is the table Traefik reads. Guarding the default arm matters:
// a new refusal key added to Validate must land on 401, never on 200.
func TestStatusForKey(t *testing.T) {
	tests := []struct {
		ok   bool
		key  string
		want int
	}{
		{true, msgSuccess, http.StatusOK},
		{true, "healthy", http.StatusOK},
		{false, keyForbidden, http.StatusForbidden},
		{false, keyUnexpected, http.StatusInternalServerError},
		{false, keyAuthRequired, http.StatusUnauthorized},
		{false, keyInvalidToken, http.StatusUnauthorized},
		{false, keySessionRevoked, http.StatusUnauthorized},
		{false, "some.key.added.later", http.StatusUnauthorized},
		{false, "", http.StatusUnauthorized},
	}
	for _, tc := range tests {
		if got := statusForKey(tc.ok, tc.key); got != tc.want {
			t.Errorf("statusForKey(%v, %q) = %d, want %d", tc.ok, tc.key, got, tc.want)
		}
	}
}

// The status is chosen from the untranslated key. If translation ran first,
// every localized message would fall through to the 401 default and a
// forbidden request would come back as 401 in Persian but 403 in English.
func TestValidateStatusIsChosenBeforeTranslation(t *testing.T) {
	h, _ := newHandler(t, sessionActive, testEngine(t))
	token := sign(t, validClaims(map[string]any{"roleName": "user", "permissions": []string{"user.write"}}), testSecret)

	// A store with no client translates to the key itself, which is the
	// closest a unit test gets to "translation happened".
	store := locale.NewStore("", "backend", "fa", slog.New(slog.NewTextHandler(io.Discard, nil)))
	handler := middlewares.LanguageMiddleware(store)(http.HandlerFunc(h.Validate))

	r := httptest.NewRequest(http.MethodGet, "/validate", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Accept-Language", "fa")
	got := httptest.NewRecorder()
	handler.ServeHTTP(got, r)

	if got.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403 through the language middleware", got.Code)
	}
}

func TestHealth(t *testing.T) {
	h, _ := newHandler(t, sessionActive, nil)
	w := httptest.NewRecorder()
	h.Health(w, httptest.NewRequest(http.MethodGet, "/health", nil))

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
	body := decode(t, w)
	if body["ok"] != true || body["data"] != "healthy" {
		t.Errorf("body = %v, want ok with data healthy", body)
	}
}

// Every response is JSON with the shared envelope, including the refusals —
// a client that parses the success shape must not hit HTML on a 403.
func TestValidateAlwaysWritesJSONEnvelope(t *testing.T) {
	h, _ := newHandler(t, func(string) string { return respNil }, nil)
	w := call(t, h, sign(t, validClaims(nil), testSecret))

	if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q, want JSON", ct)
	}
	body := decode(t, w)
	for _, key := range []string{"ok", "msg"} {
		if _, ok := body[key]; !ok {
			t.Errorf("envelope is missing %q: %v", key, body)
		}
	}
	// The refusal must not leak internals into the error field.
	if errField, ok := body["error"]; ok {
		t.Errorf("error = %v on a session refusal, want it omitted", errField)
	}
}

// --- the WebSocket upgrade (F-067-h) ------------------------------------

// callWS runs Validate with a `Sec-WebSocket-Protocol` header instead of an
// `Authorization` one — what a browser sends, because `new WebSocket()` takes
// no headers and this is the only one it lets the page choose.
func callWS(t *testing.T, h *Handler, protocol string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/validate", nil)
	if protocol != "" {
		r.Header.Set("Sec-WebSocket-Protocol", protocol)
	}
	w := httptest.NewRecorder()
	h.Validate(w, r)
	return w
}

// The upgrade is authenticated by the same gate as every other request — that
// is the whole reason this platform owns its realtime gateway rather than
// running a second identity model beside it (D-9).
func TestValidateAcceptsTokenFromWebSocketSubprotocol(t *testing.T) {
	h, _ := newHandler(t, sessionActive, testEngine(t))
	token := sign(t, validClaims(nil), testSecret)

	w := callWS(t, h, realtimeSubprotocol+", "+token)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", w.Code, w.Body.String())
	}
	if got := w.Header().Get("X-User-Id"); got != "user-1" {
		t.Errorf("X-User-Id = %q, want the subprotocol token's subject", got)
	}
}

// An `Authorization` header still wins. A request carrying both is not a
// browser, and the header is the form every non-WebSocket caller uses.
func TestValidatePrefersAuthorizationOverSubprotocol(t *testing.T) {
	h, _ := newHandler(t, sessionActive, testEngine(t))
	good := sign(t, validClaims(nil), testSecret)

	r := httptest.NewRequest(http.MethodGet, "/validate", nil)
	r.Header.Set("Authorization", "Bearer "+good)
	r.Header.Set("Sec-WebSocket-Protocol", realtimeSubprotocol+", garbage")
	w := httptest.NewRecorder()
	h.Validate(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", w.Code, w.Body.String())
	}
}

// The subprotocol list is attacker-controlled, so every shape that is not
// exactly `<marker>, <token>` must fail closed rather than be guessed at. A
// header that parsed loosely would let a caller smuggle a token past the
// marker the gateway keys on.
func TestValidateRejectsMalformedSubprotocol(t *testing.T) {
	token := sign(t, validClaims(nil), testSecret)

	tests := []struct {
		name     string
		protocol string
		wantMsg  string
	}{
		{"empty header", "", keyAuthRequired},
		{"marker only, no token", realtimeSubprotocol, keyAuthRequired},
		{"marker with an empty token", realtimeSubprotocol + ", ", keyAuthRequired},
		{"token without the marker", token, keyAuthRequired},
		{"another protocol entirely", "graphql-ws, " + token, keyAuthRequired},
		{"marker not first", "chat, " + realtimeSubprotocol + ", " + token, keyAuthRequired},
		{"marker present, token is not a JWT", realtimeSubprotocol + ", garbage", keyInvalidToken},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h, _ := newHandler(t, sessionActive, testEngine(t))
			w := callWS(t, h, tc.protocol)

			if w.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401 (body %q)", w.Code, w.Body.String())
			}
			if body := decode(t, w); body["msg"] != tc.wantMsg {
				t.Errorf("msg = %v, want %q", body["msg"], tc.wantMsg)
			}
			if got := w.Header().Get("X-User-Id"); got != "" {
				t.Errorf("X-User-Id = %q on a refusal, want it unset", got)
			}
		})
	}
}

// The socket outlives the token that opened it: an access JWT is minted for
// ~15 minutes and a connection is held for hours. `gateway-service` therefore
// has to re-ask whether the session is still live, and it can only ask about a
// session it was told the id of — none of the other identity headers name one.
func TestValidateSetsSessionIdHeader(t *testing.T) {
	h, _ := newHandler(t, sessionActive, testEngine(t))
	w := call(t, h, sign(t, validClaims(nil), testSecret))

	if got := w.Header().Get("X-Session-Id"); got != "sess-1" {
		t.Errorf("X-Session-Id = %q, want %q", got, "sess-1")
	}
}

func TestValidateOmitsSessionIdOnRefusal(t *testing.T) {
	h, _ := newHandler(t, func(string) string { return respNil }, testEngine(t))
	w := call(t, h, sign(t, validClaims(nil), testSecret))

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	if got := w.Header().Get("X-Session-Id"); got != "" {
		t.Errorf("X-Session-Id = %q on a refusal, want it unset", got)
	}
}

// --- the optional gate (ADR-0031) --------------------------------------

// ValidateOptional exists so one router can serve a caller that has a session
// and a caller that does not. The realtime path is the first: a WebSocket is
// this platform's live-data transport and it is opened before anyone signs in,
// so an upgrade with no credential has to reach the gateway rather than be
// refused at the gate.
//
// The property that makes it safe is narrow and it is the only one worth
// pinning: **absent is anonymous, invalid is still 401.** A credential that
// was presented and did not check out must never be downgraded to "nobody",
// because that turns every expired token into a silent privilege drop instead
// of the re-authentication the client is waiting to be told to do.

func callOptional(t *testing.T, h *Handler, token string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/validate-optional", nil)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.ValidateOptional(w, r)
	return w
}

func TestValidateOptionalAdmitsACallerWithNoCredential(t *testing.T) {
	h, _ := newHandler(t, sessionActive, testEngine(t))

	w := callOptional(t, h, "")

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", w.Code, w.Body.String())
	}
	if got := w.Header().Get(HeaderAnonymous); got != "true" {
		t.Errorf("%s = %q, want %q — the marker is how the gateway tells "+
			"'nobody is signed in' from 'the middleware never ran'",
			HeaderAnonymous, got, "true")
	}
	for _, header := range []string{"X-User-Id", "X-Tenant-Id", "X-Session-Id", "X-User-Permissions"} {
		if got := w.Header().Get(header); got != "" {
			t.Errorf("%s = %q, want empty — an anonymous caller has no identity", header, got)
		}
	}
}

func TestValidateOptionalStillIdentifiesACallerWithACredential(t *testing.T) {
	h, _ := newHandler(t, sessionActive, testEngine(t))

	w := callOptional(t, h, sign(t, validClaims(nil), testSecret))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", w.Code, w.Body.String())
	}
	if got := w.Header().Get("X-User-Id"); got != "user-1" {
		t.Errorf("X-User-Id = %q, want user-1", got)
	}
	if got := w.Header().Get("X-Session-Id"); got != "sess-1" {
		t.Errorf("X-Session-Id = %q, want sess-1", got)
	}
	if got := w.Header().Get(HeaderAnonymous); got != "" {
		t.Errorf("%s = %q, want empty — this caller was identified", HeaderAnonymous, got)
	}
}

// The one that matters. A token that was offered and failed is a refusal, not
// an anonymous caller: downgrading it would turn an expired session into a
// page that silently shows nothing instead of one that signs the user back in.
func TestValidateOptionalRefusesAnInvalidCredentialRatherThanDowngrading(t *testing.T) {
	cases := []struct {
		name  string
		token func(t *testing.T) string
		redis func(string) string
	}{
		{
			name:  "bad signature",
			token: func(t *testing.T) string { return sign(t, validClaims(nil), "not-the-secret") },
			redis: sessionActive,
		},
		{
			name: "expired",
			token: func(t *testing.T) string {
				return sign(t, validClaims(map[string]any{
					"exp": time.Now().Add(-time.Hour).Unix(),
				}), testSecret)
			},
			redis: sessionActive,
		},
		{
			name:  "session revoked",
			token: func(t *testing.T) string { return sign(t, validClaims(nil), testSecret) },
			redis: func(string) string { return respNil },
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, _ := newHandler(t, tc.redis, testEngine(t))

			w := callOptional(t, h, tc.token(t))

			if w.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401 (body %q)", w.Code, w.Body.String())
			}
			if got := w.Header().Get(HeaderAnonymous); got != "" {
				t.Errorf("%s = %q, want empty — a presented credential that "+
					"failed must not be downgraded to anonymous", HeaderAnonymous, got)
			}
		})
	}
}

// A WebSocket upgrade carries its token in the subprotocol list, so the
// optional gate has to read it from there too — otherwise every authenticated
// socket on the optional router silently becomes an anonymous one.
func TestValidateOptionalReadsTheSubprotocolToken(t *testing.T) {
	h, _ := newHandler(t, sessionActive, testEngine(t))
	token := sign(t, validClaims(nil), testSecret)

	r := httptest.NewRequest(http.MethodGet, "/validate-optional", nil)
	r.Header.Set("Sec-WebSocket-Protocol", realtimeSubprotocol+", "+token)
	w := httptest.NewRecorder()
	h.ValidateOptional(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", w.Code, w.Body.String())
	}
	if got := w.Header().Get("X-User-Id"); got != "user-1" {
		t.Errorf("X-User-Id = %q, want the subprotocol token's subject", got)
	}
}

// A browser that opens a plain `new WebSocket(url, ['txnet.v1'])` — no token,
// because nobody is signed in — offers the marker alone. That is the ordinary
// anonymous upgrade and it must not read as a malformed credential.
func TestValidateOptionalTreatsTheBareMarkerAsAnonymous(t *testing.T) {
	h, _ := newHandler(t, sessionActive, testEngine(t))

	r := httptest.NewRequest(http.MethodGet, "/validate-optional", nil)
	r.Header.Set("Sec-WebSocket-Protocol", realtimeSubprotocol)
	w := httptest.NewRecorder()
	h.ValidateOptional(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", w.Code, w.Body.String())
	}
	if got := w.Header().Get(HeaderAnonymous); got != "true" {
		t.Errorf("%s = %q, want %q", HeaderAnonymous, got, "true")
	}
}
