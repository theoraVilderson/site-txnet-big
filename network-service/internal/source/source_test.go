package source_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"network-service/internal/driver"
	"network-service/internal/driver/fake"
	"network-service/internal/egress"
	"network-service/internal/source"
)

func panelWith(remoteIDs ...string) *fake.Panel {
	p := fake.New(fake.Config{Transport: driver.TransportPull, CounterSemantics: driver.CounterCumulative})
	for _, id := range remoteIDs {
		p.Given(id)
	}
	return p
}

func TestSnapshotJoinsEachClientToItsUsage(t *testing.T) {
	p := panelWith("ali", "reza")
	p.Serve("ali", 100, 900)

	snap, err := source.Snapshot(context.Background(), p, source.Limits{})
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if len(snap.Clients) != 2 {
		t.Fatalf("clients = %d, want 2", len(snap.Clients))
	}
	for _, c := range snap.Clients {
		if c.RemoteID == "ali" && (c.UpBytes != 100 || c.DownBytes != 900) {
			t.Errorf("ali used %d/%d, want 100/900", c.UpBytes, c.DownBytes)
		}
	}
}

// withSubscriptions is a source whose family lists every client's address in bulk.
type withSubscriptions struct {
	*fake.Panel
	urls map[string]string
}

func (w withSubscriptions) SubscriptionURLs(context.Context) (map[string]string, error) {
	return w.urls, nil
}

// F-203-a: the old link is captured from the bulk read, so the commit — which
// can no longer read the source — still knows the path each user holds.
func TestSnapshotCarriesEachClientsSubscriptionURL(t *testing.T) {
	r := withSubscriptions{Panel: panelWith("ali", "reza"), urls: map[string]string{"ali": "https://sub.old.example/sub/tok-ali"}}

	snap, err := source.Snapshot(context.Background(), r, source.Limits{})
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	got := map[string]string{}
	for _, c := range snap.Clients {
		got[c.RemoteID] = c.SubscriptionURL
	}
	if got["ali"] != "https://sub.old.example/sub/tok-ali" || got["reza"] != "" {
		t.Fatalf("subscription urls = %v, want ali's alone", got)
	}
}

// D-63: a source past the cap is refused whole, never imported in part.
func TestSnapshotRefusesASourcePastTheClientCap(t *testing.T) {
	_, err := source.Snapshot(context.Background(), panelWith("a", "b", "c"), source.Limits{MaxClients: 2})
	if !errors.Is(err, source.ErrTooManyClients) {
		t.Fatalf("err = %v, want ErrTooManyClients", err)
	}
}

func TestLinksRefusesABatchPastItsCap(t *testing.T) {
	batch := make([]source.LinkRequest, source.MaxLinkBatch+1)
	for i := range batch {
		batch[i] = source.LinkRequest{RemoteID: fmt.Sprint(i)}
	}
	if _, err := source.Links(context.Background(), panelWith(), batch); !errors.Is(err, source.ErrBatchTooLarge) {
		t.Fatalf("err = %v, want ErrBatchTooLarge", err)
	}
}

func TestUserinfoReadsTheFourFigures(t *testing.T) {
	got := source.ParseUserinfo("upload=1024; download=2048;total=10737418240; expire=1767225600")
	want := source.Userinfo{UploadBytes: 1024, DownloadBytes: 2048, TotalBytes: 10737418240, ExpiresAt: 1767225600}
	if got != want {
		t.Fatalf("ParseUserinfo = %+v, want %+v", got, want)
	}
}

// The tests dial httptest on loopback, which the bare guard refuses.
func loopbackClient() *http.Client {
	return source.HTTPClient(egress.Guard{Allow: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}})
}

func TestFetchLinkReadsTheHeaderAndTheLines(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Subscription-Userinfo", "upload=1; download=2; total=30; expire=0")
		fmt.Fprint(w, "vless://a@h:443#one\ntrojan://b@h:443#two\n")
	}))
	defer srv.Close()

	got, err := source.FetchLink(context.Background(), loopbackClient(), srv.URL+"/sub/token")
	if err != nil {
		t.Fatalf("FetchLink: %v", err)
	}
	if got.Userinfo.TotalBytes != 30 || len(got.Lines) != 2 {
		t.Fatalf("FetchLink = %+v, want total 30 and two lines", got)
	}
}

// A source is adversarial input (catalog §16): a redirect is not followed at
// all, not even to a public address.
func TestFetchLinkFollowsNoRedirect(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/elsewhere") {
			t.Error("the redirect was followed")
		}
		http.Redirect(w, r, "/elsewhere", http.StatusFound)
	}))
	defer srv.Close()

	if _, err := source.FetchLink(context.Background(), loopbackClient(), srv.URL+"/sub/token"); err == nil {
		t.Fatal("a redirect answered as a subscription")
	}
}
