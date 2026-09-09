package middlewares

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"auth-handler/internal/locale"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func ok(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }

// Chain's order is the whole reason Recoverer can catch a panic thrown by the
// handler and RequestLogger can see the status Recoverer wrote. Reversing it
// would leave panics uncaught, which is not visible until one happens.
func TestChainAppliesMiddlewaresOutermostFirst(t *testing.T) {
	var order []string
	mw := func(name string) func(http.Handler) http.Handler {
		return func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				order = append(order, "enter:"+name)
				next.ServeHTTP(w, r)
				order = append(order, "exit:"+name)
			})
		}
	}

	h := Chain(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		order = append(order, "handler")
	}), mw("A"), mw("B"))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))

	want := []string{"enter:A", "enter:B", "handler", "exit:B", "exit:A"}
	if strings.Join(order, ",") != strings.Join(want, ",") {
		t.Errorf("order = %v, want %v", order, want)
	}
}

func TestChainWithNoMiddlewaresIsTheHandler(t *testing.T) {
	called := false
	h := Chain(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
	if !called {
		t.Error("Chain with no middlewares did not call the handler")
	}
}

// A panic anywhere in the gateway must become a 500, not a dropped connection
// that Traefik reports as a backend failure.
func TestRecovererTurnsPanicInto500(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))

	h := Recoverer(logger)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	}))

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/validate", nil))

	if w.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", w.Code)
	}
	// The panic value is for the log, never for the client.
	if strings.Contains(w.Body.String(), "boom") {
		t.Errorf("body %q leaks the panic value", w.Body.String())
	}
	if !strings.Contains(logs.String(), "panic recovered") {
		t.Errorf("panic was swallowed without a log line: %q", logs.String())
	}
	if !strings.Contains(logs.String(), "/validate") {
		t.Errorf("log line does not say which path panicked: %q", logs.String())
	}
}

func TestRecovererPassesNormalRequestsThrough(t *testing.T) {
	h := Recoverer(discardLogger())(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte("fine"))
	}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/", nil))

	if w.Code != http.StatusTeapot || w.Body.String() != "fine" {
		t.Errorf("got %d %q, want 418 \"fine\"", w.Code, w.Body.String())
	}
}

// RequestLogger reports the status the handler actually wrote, which only
// works because statusWriter intercepts WriteHeader.
func TestRequestLoggerRecordsTheWrittenStatus(t *testing.T) {
	var logs bytes.Buffer
	h := RequestLogger(slog.New(slog.NewTextHandler(&logs, nil)))(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusForbidden)
		}))

	r := httptest.NewRequest(http.MethodPost, "/validate", nil)
	r.RemoteAddr = "10.0.0.9:1234"
	h.ServeHTTP(httptest.NewRecorder(), r)

	line := logs.String()
	for _, want := range []string{"status=403", "method=POST", "path=/validate", "remote_addr=10.0.0.9:1234", "duration_ms="} {
		if !strings.Contains(line, want) {
			t.Errorf("log line %q is missing %q", line, want)
		}
	}
}

// A handler that only writes a body never calls WriteHeader, and the log must
// still say 200 rather than 0.
func TestRequestLoggerDefaultsToOKWhenHeaderNeverWritten(t *testing.T) {
	var logs bytes.Buffer
	h := RequestLogger(slog.New(slog.NewTextHandler(&logs, nil)))(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("implicit 200"))
		}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))

	if !strings.Contains(logs.String(), "status=200") {
		t.Errorf("log line %q, want status=200", logs.String())
	}
}

func TestTimeoutCutsOffASlowHandler(t *testing.T) {
	release := make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })

	h := Timeout(20 * time.Millisecond)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
		w.WriteHeader(http.StatusOK)
	}))

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/validate", nil))

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503 from TimeoutHandler", w.Code)
	}
	// The same envelope every other answer has: a caller that showed `msg` to
	// a person must not need a second shape for the one answer no handler wrote.
	var body struct {
		OK  bool   `json:"ok"`
		Msg string `json:"msg"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("body = %q, want the standard JSON envelope: %v", w.Body.String(), err)
	}
	if body.OK || body.Msg == "" {
		t.Errorf("body = %+v, want ok:false and a message", body)
	}
}

// A panic must reach the client as the envelope too, and never as the panic
// value: that is a stack detail, and it goes to the log alone.
func TestRecovererAnswersWithTheEnvelopeAndHidesThePanic(t *testing.T) {
	var logs bytes.Buffer
	h := Recoverer(slog.New(slog.NewTextHandler(&logs, nil)))(
		http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			panic("secret internal detail")
		}))

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/validate", nil))

	if w.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", w.Code)
	}
	if strings.Contains(w.Body.String(), "secret internal detail") {
		t.Errorf("body = %q, want the panic value absent", w.Body.String())
	}
	var body struct {
		OK  bool   `json:"ok"`
		Msg string `json:"msg"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("body = %q, want the standard JSON envelope: %v", w.Body.String(), err)
	}
	if body.OK || body.Msg == "" {
		t.Errorf("body = %+v, want ok:false and a message", body)
	}
	if !strings.Contains(logs.String(), "secret internal detail") {
		t.Errorf("log = %q, want the panic value recorded there", logs.String())
	}
}

func TestTimeoutLetsAFastHandlerFinish(t *testing.T) {
	h := Timeout(time.Second)(http.HandlerFunc(ok))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/", nil))
	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
}

// --- language -----------------------------------------------------------

// A store that was never Load()ed is the state the gateway is in when
// locale-service is unreachable: every lookup falls back rather than failing,
// so a translation outage cannot take authentication down with it.
func unloadedStore(defaultLang string) *locale.Store {
	return locale.NewStore("", "backend", defaultLang, discardLogger())
}

func TestLanguageMiddlewarePutsLanguageAndStoreInContext(t *testing.T) {
	store := unloadedStore("fa")
	var translated string

	h := LanguageMiddleware(store)(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		translated = Translate(r, ErrorsNamespace, "auth.sessionRevoked")
	}))
	r := httptest.NewRequest(http.MethodGet, "/validate", nil)
	r.Header.Set("Accept-Language", "en-US,en;q=0.9")
	h.ServeHTTP(httptest.NewRecorder(), r)

	// With no live client the store echoes the key, which proves the lookup
	// reached the store rather than the "no store in context" branch.
	if translated != "auth.sessionRevoked" {
		t.Errorf("Translate() = %q, want the key echoed back", translated)
	}
}

// Translate outside the middleware must return the key, not panic and not an
// empty string: an untranslated key on the wire is readable, a blank msg is not.
func TestTranslateWithoutTheMiddlewareReturnsTheKey(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/validate", nil)
	if got := Translate(r, ErrorsNamespace, "permissions.forbidden"); got != "permissions.forbidden" {
		t.Errorf("Translate() = %q, want %q", got, "permissions.forbidden")
	}
}

// The context keys are a private named type, so a caller cannot collide with
// them by putting a plain string of the same name into the context.
func TestTranslateIgnoresAStringKeyedImposter(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/validate", nil)
	ctx := withStringKey(r.Context(), "localeStore", unloadedStore("fa"))
	if got := Translate(r.WithContext(ctx), ErrorsNamespace, "auth.invalidToken"); got != "auth.invalidToken" {
		t.Errorf("Translate() = %q, want the key; a string-keyed value must not be picked up", got)
	}
}

func TestLanguageMiddlewareCallsTheNextHandler(t *testing.T) {
	called := false
	h := LanguageMiddleware(unloadedStore("fa"))(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
	if !called {
		t.Error("LanguageMiddleware did not call next")
	}
}

// withStringKey puts a value under a plain string key, which is exactly what
// the private contextKey type exists to keep out of Translate's lookup.
func withStringKey(ctx context.Context, key string, value any) context.Context {
	//nolint:staticcheck // SA1029 is the point of the test
	return context.WithValue(ctx, key, value)
}
