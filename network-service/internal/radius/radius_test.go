package radius

import (
	"context"
	"crypto/md5" //nolint:gosec // RFC 2866's authenticator is MD5; the test builds what a NAS sends.
	"encoding/binary"
	"errors"
	"io"
	"log/slog"
	"net/netip"
	"testing"
	"time"

	"network-service/internal/collect"
	"network-service/internal/db"
)

// What F-027-af turns on, in the order a packet meets it: the allowlist before
// any crypto, the authenticator before any byte is believed, the 64-bit
// reconstruction, the hold past 4 GB without Gigawords, the high water mark,
// and the ack only once the bytes are somewhere durable (invariant 18 on the
// push side — the NAS is the retry queue).

var secret = []byte("s3cret-per-nas")

const gb4 = int64(1) << 32

// request builds an Accounting-Request the way a NAS does (RFC 2866 §3).
func request(t *testing.T, key []byte, attrs ...Attribute) []byte {
	t.Helper()
	raw := encode(CodeAccountingRequest, 7, [16]byte{}, attrs)
	h := md5.New() //nolint:gosec
	h.Write(raw)
	h.Write(key)
	copy(raw[4:20], h.Sum(nil))
	return raw
}

func u32(typ byte, v uint32) Attribute {
	b := make([]byte, 4)
	binary.BigEndian.PutUint32(b, v)
	return Attribute{Type: typ, Value: b}
}

func str(typ byte, v string) Attribute { return Attribute{Type: typ, Value: []byte(v)} }

func interim(session, user string, in, out uint32, extra ...Attribute) []Attribute {
	return append([]Attribute{
		u32(AttrAcctStatusType, uint32(StatusInterimUpdate)),
		str(AttrAcctSessionID, session), str(AttrUserName, user), str(AttrNASIdentifier, "nas-1"),
		u32(AttrAcctInputOctets, in), u32(AttrAcctOutputOctets, out),
	}, extra...)
}

func withStatus(attrs []Attribute, s StatusType) []Attribute {
	attrs[0] = u32(AttrAcctStatusType, uint32(s))
	return attrs
}

// ---------------------------------------------------------------- the wire

func TestAParsedRequestIsOnlyBelievedUnderItsOwnSecret(t *testing.T) {
	raw := request(t, secret, interim("s1", "alice", 10, 20)...)
	if _, err := Parse(raw, secret); err != nil {
		t.Fatalf("a well-signed request was refused: %v", err)
	}
	if _, err := Parse(raw, []byte("another-nas-secret")); !errors.Is(err, ErrBadAuthenticator) {
		t.Fatalf("another NAS's secret verified the request: %v", err)
	}
	tampered := append([]byte(nil), raw...)
	tampered[len(tampered)-1]++ // one octet of a counter
	if _, err := Parse(tampered, secret); !errors.Is(err, ErrBadAuthenticator) {
		t.Fatalf("a rewritten counter verified: %v", err)
	}
}

func TestAMalformedPacketIsRefusedNotRead(t *testing.T) {
	raw := request(t, secret, interim("s1", "alice", 10, 20)...)
	zeroLen := append(append([]byte(nil), raw...), 1, 0)
	binary.BigEndian.PutUint16(zeroLen[2:4], uint16(len(zeroLen)))
	for name, b := range map[string][]byte{
		"short header":        raw[:12],
		"length past the end": append(append(append([]byte(nil), raw[:2]...), 0xff, 0xff), raw[4:]...),
		"zero-length attr":    zeroLen,
	} {
		if _, err := Parse(b, secret); err == nil {
			t.Errorf("%s: parsed", name)
		}
	}
}

func TestTheResponseIsSignedOverTheRequestAuthenticator(t *testing.T) {
	raw := request(t, secret, interim("s1", "alice", 10, 20)...)
	req, _ := Parse(raw, secret)
	resp := Response(req, secret)
	if resp[0] != CodeAccountingResponse || resp[1] != req.Identifier || len(resp) != 20 {
		t.Fatalf("response header %v", resp[:4])
	}
	want := append([]byte(nil), resp[:4]...)
	want = append(want, req.Authenticator[:]...)
	h := md5.New() //nolint:gosec
	h.Write(want)
	h.Write(secret)
	if string(h.Sum(nil)) != string(resp[4:20]) {
		t.Fatal("the response authenticator is not RFC 2866's")
	}
}

// ---------------------------------------------------------------- the arithmetic

func open(t *testing.T) Session {
	t.Helper()
	return Session{Known: true, StartedAt: t0, LastSeenAt: t0}
}

var t0 = time.Date(2026, 9, 24, 10, 0, 0, 0, time.UTC)

func rec(in, out uint32) Record {
	return Record{Status: StatusInterimUpdate, SessionID: "s1", UserName: "alice", InOctets: in, OutOctets: out}
}

func TestGigawordsAreTheHighBitsOfOneSixtyFourBitFigure(t *testing.T) {
	r := rec(100, 5)
	r.HasGigawords, r.InGigawords = true, 2
	next, out := Account(open(t), r, t0.Add(time.Minute), Limit{})
	if want := 2*gb4 + 100; next.HighInBytes != want || out.UpBytes != want {
		t.Fatalf("reconstructed %d, published %d; want %d", next.HighInBytes, out.UpBytes, want)
	}
	if !next.GigawordsSeen || out.HeldUp != 0 {
		t.Fatalf("a NAS that sends Gigawords was held: %+v", out)
	}
}

func TestPastTheFirstWrapWithoutGigawordsTheBytesAreHeldNotGuessed(t *testing.T) {
	cur := open(t)
	cur, out := Account(cur, rec(uint32(gb4-1000), 0), t0.Add(time.Minute), Limit{})
	if out.UpBytes != gb4-1000 || out.HeldUp != 0 {
		t.Fatalf("below 4 GB is measured and billed: %+v", out)
	}
	// The counter wrapped: 1000 bytes to the top, 500 past it.
	cur, out = Account(cur, rec(500, 0), t0.Add(2*time.Minute), Limit{})
	if out.UpBytes != 1000 || out.HeldUp != 500 {
		t.Fatalf("the rise across the wrap: billed %d held %d; want 1000 and 500", out.UpBytes, out.HeldUp)
	}
	if cur.HighInBytes != gb4+500 || cur.PublishedInBytes != cur.HighInBytes {
		t.Fatalf("the mark after the wrap: %+v", cur)
	}
	// Every later rise in this session is held too.
	_, out = Account(cur, rec(900, 0), t0.Add(3*time.Minute), Limit{})
	if out.UpBytes != 0 || out.HeldUp != 400 {
		t.Fatalf("after the wrap: billed %d held %d", out.UpBytes, out.HeldUp)
	}
}

func TestALowerReadingIsARestartNeverNegativeUsage(t *testing.T) {
	r := rec(5000, 5000)
	r.HasGigawords = true
	cur, _ := Account(open(t), r, t0.Add(time.Minute), Limit{})
	r.InOctets, r.OutOctets = 10, 10
	next, out := Account(cur, r, t0.Add(2*time.Minute), Limit{})
	if out.UpBytes != 0 || out.DownBytes != 0 || next.HighInBytes != 5000 {
		t.Fatalf("a lower reading published %+v, mark %d", out, next.HighInBytes)
	}
}

func TestARetransmittedFigureIsWorthNothing(t *testing.T) {
	cur, _ := Account(open(t), rec(700, 300), t0.Add(time.Minute), Limit{})
	_, out := Account(cur, rec(700, 300), t0.Add(time.Minute+time.Second), Limit{})
	if out.UpBytes != 0 || out.DownBytes != 0 {
		t.Fatalf("the same figure twice published %+v", out)
	}
}

func TestAFigurePastTheLineRateIsQuarantined(t *testing.T) {
	lim := Limit{MaxLineRateBps: 8_000, MinWindow: time.Second} // 1000 bytes a second
	_, out := Account(open(t), rec(100_000, 0), t0.Add(10*time.Second), lim)
	if out.UpBytes != 0 || out.Quarantine != collect.ReasonImplausibleVolume || out.QuarantinedUp != 100_000 {
		t.Fatalf("100 kB in 10 s at 1 kB/s: %+v", out)
	}
}

func TestAStopClosesWithTheNASsOwnReason(t *testing.T) {
	r := rec(10, 10)
	r.Status = StatusStop
	next, _ := Account(open(t), r, t0.Add(time.Minute), Limit{})
	if next.CloseReason != CloseAcctStop || !next.ClosedAt.Equal(t0.Add(time.Minute)) {
		t.Fatalf("a Stop closed as %q at %v", next.CloseReason, next.ClosedAt)
	}
}

func TestAnUnseenSessionStartsWhenTheNASSaysItDid(t *testing.T) {
	r := rec(10, 10)
	r.HasSessionTime, r.SessionTime = true, 90*time.Second
	next, out := Account(Session{}, r, t0, Limit{})
	if !next.StartedAt.Equal(t0.Add(-90*time.Second)) || out.UpBytes != 10 {
		t.Fatalf("started %v, published %+v", next.StartedAt, out)
	}
}

// ---------------------------------------------------------------- the receiver

type dir map[netip.Addr]NAS

func (d dir) NAS(a netip.Addr) (NAS, bool) { n, ok := d[a]; return n, ok }

type memStore struct {
	rows   map[Key]Session
	holds  []Hold
	closed []string
	place  map[string]Placement
}

func (m *memStore) Account(_ context.Context, k Key, remote string, fn Apply) error {
	cur := m.rows[k]
	next, hold, err := fn(cur, m.place[remote])
	if err != nil {
		return err
	}
	m.rows[k] = next
	if hold != nil {
		m.holds = append(m.holds, *hold)
	}
	return nil
}

func (m *memStore) CloseNAS(_ context.Context, panelID, nasID string, _ time.Time) (int, error) {
	m.closed = append(m.closed, panelID+"/"+nasID)
	return 1, nil
}

func (m *memStore) CloseStale(context.Context, time.Time) (int, error) { return 0, nil }

type sink struct {
	got []collect.Result
	err error
}

func (s *sink) Publish(_ context.Context, r collect.Result) error {
	if s.err != nil {
		return s.err
	}
	s.got = append(s.got, r)
	return nil
}

var nasAddr = netip.MustParseAddr("203.0.113.9")

func receiver(s *sink, st *memStore) *Receiver {
	return &Receiver{
		Directory: dir{nasAddr: {PanelID: "panel-1", Secret: secret, OwnershipType: "platform"}},
		Store:     st, Sink: s, Now: func() time.Time { return t0 },
	}
}

func newStore() *memStore {
	return &memStore{rows: map[Key]Session{}, place: map[string]Placement{
		"alice": {ConfigID: "cfg-1", Protocol: "pppoe"},
	}}
}

func TestASourceOffTheAllowlistIsDroppedBeforeAnyCrypto(t *testing.T) {
	s, st := &sink{}, newStore()
	reply, err := receiver(s, st).Handle(context.Background(), netip.MustParseAddr("198.51.100.1"),
		request(t, secret, interim("s1", "alice", 10, 10)...))
	if !errors.Is(err, ErrNotAllowed) || reply != nil || len(s.got) != 0 {
		t.Fatalf("an unlisted source got %v / %v", reply, err)
	}
}

func TestAnAcceptedInterimIsPublishedThenAcked(t *testing.T) {
	s, st := &sink{}, newStore()
	reply, err := receiver(s, st).Handle(context.Background(), nasAddr,
		request(t, secret, interim("s1", "alice", 1000, 3000)...))
	if err != nil || len(reply) != 20 || reply[0] != CodeAccountingResponse {
		t.Fatalf("reply %v, err %v", reply, err)
	}
	if len(s.got) != 1 || len(s.got[0].Deltas) != 1 {
		t.Fatalf("published %+v", s.got)
	}
	d := s.got[0].Deltas[0]
	if d.ConfigID != "cfg-1" || d.UpBytes != 1000 || d.DownBytes != 3000 || d.SessionID != "s1" || d.Protocol != "pppoe" {
		t.Fatalf("delta %+v", d)
	}
	if row := st.rows[Key{PanelID: "panel-1", NASID: "nas-1", SessionID: "s1"}]; row.PublishedOutBytes != 3000 {
		t.Fatalf("the session did not advance: %+v", row)
	}
}

func TestAPublishThatFailedIsNeitherAdvancedNorAcked(t *testing.T) {
	s, st := &sink{err: errors.New("broker down")}, newStore()
	reply, err := receiver(s, st).Handle(context.Background(), nasAddr,
		request(t, secret, interim("s1", "alice", 1000, 3000)...))
	if err == nil || reply != nil {
		t.Fatalf("a failed publish was acked: %v", reply)
	}
	if _, advanced := st.rows[Key{PanelID: "panel-1", NASID: "nas-1", SessionID: "s1"}]; advanced {
		t.Fatal("the session advanced over bytes nobody received")
	}
}

func TestAnUnplacedSessionIsUnattributedNotDropped(t *testing.T) {
	s, st := &sink{}, newStore()
	_, err := receiver(s, st).Handle(context.Background(), nasAddr,
		request(t, secret, interim("s9", "mallory", 40, 60)...))
	if err != nil || len(s.got) != 1 || len(s.got[0].Unattributed) != 1 || s.got[0].Unattributed[0].DownBytes != 60 {
		t.Fatalf("err %v, published %+v", err, s.got)
	}
}

func TestBytesPastTheWrapBecomeAGigawordsHold(t *testing.T) {
	s, st := &sink{}, newStore()
	k := Key{PanelID: "panel-1", NASID: "nas-1", SessionID: "s1"}
	st.rows[k] = Session{Known: true, StartedAt: t0.Add(-time.Hour), LastSeenAt: t0.Add(-time.Minute),
		HighInBytes: gb4 - 10, PublishedInBytes: gb4 - 10}
	if _, err := receiver(s, st).Handle(context.Background(), nasAddr,
		request(t, secret, interim("s1", "alice", 90, 0)...)); err != nil {
		t.Fatal(err)
	}
	if len(st.holds) != 1 || st.holds[0].UpBytes != 90 || st.holds[0].ConfigID != "cfg-1" {
		t.Fatalf("holds %+v", st.holds)
	}
	if d := s.got[0].Deltas; len(d) != 1 || d[0].UpBytes != 10 {
		t.Fatalf("the 10 bytes below the wrap: %+v", d)
	}
}

func TestAccountingOnClosesTheNASsOpenSessions(t *testing.T) {
	s, st := &sink{}, newStore()
	on := []Attribute{u32(AttrAcctStatusType, uint32(StatusAccountingOn)), str(AttrNASIdentifier, "nas-1")}
	reply, err := receiver(s, st).Handle(context.Background(), nasAddr, request(t, secret, on...))
	if err != nil || reply == nil || len(st.closed) != 1 || st.closed[0] != "panel-1/nas-1" {
		t.Fatalf("reply %v err %v closed %v", reply, err, st.closed)
	}
}

func TestAnInterimWithoutASessionIDIsRefused(t *testing.T) {
	s, st := &sink{}, newStore()
	attrs := withStatus([]Attribute{{}, str(AttrUserName, "alice"), u32(AttrAcctInputOctets, 1)}, StatusInterimUpdate)
	if reply, err := receiver(s, st).Handle(context.Background(), nasAddr, request(t, secret, attrs...)); err == nil || reply != nil {
		t.Fatalf("acked a session nobody can name: %v", reply)
	}
}

// nasRows is the allowlist query's answer: id, ipAddress, ownershipType,
// tenantId, maxLineRateBps.
type nasRows struct {
	rows [][]any
	i    int
}

func (r *nasRows) Next() bool { r.i++; return r.i <= len(r.rows) }
func (r *nasRows) Scan(dest ...any) error {
	for k, v := range r.rows[r.i-1] {
		switch d := dest[k].(type) {
		case *string:
			*d = v.(string)
		case *int64:
			*d = v.(int64)
		}
	}
	return nil
}
func (r *nasRows) Err() error { return nil }
func (r *nasRows) Close()     {}

type nasQuerier struct{ rows [][]any }

func (q nasQuerier) Query(context.Context, string, ...any) (db.Rows, error) {
	return &nasRows{rows: q.rows}, nil
}

// secrets is the vault as the allowlist sees it: the RADIUS secret by panel,
// and nothing else it could be asked for.
type secrets map[string]string

func (s secrets) PanelRadiusSecret(_ context.Context, panelID string) (string, error) {
	v, ok := s[panelID]
	if !ok {
		return "", errors.New("vault refused the login read (http 404): credential_unavailable")
	}
	return v, nil
}

// F-027-az: a NAS is on the allowlist under its RADIUS secret, which is its
// own vault reference, never the panel's REST login. A push panel with no
// secret stored is left off and logged; a packet from it is dropped as from
// an unknown source, not verified under some other value.
func TestTheAllowlistHoldsEachNASUnderItsRadiusSecretOnly(t *testing.T) {
	d := &PanelDirectory{
		DB: nasQuerier{rows: [][]any{
			{"panel-1", "198.51.100.7", "platform", "", int64(0)},
			{"panel-2", "198.51.100.8", "platform", "", int64(0)},
		}},
		Secrets: secrets{"panel-1": "nas-one"},
		Log:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	if err := d.Refresh(context.Background()); err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	nas, ok := d.NAS(netip.MustParseAddr("198.51.100.7"))
	if !ok || string(nas.Secret) != "nas-one" {
		t.Fatalf("panel-1 = %+v, %v; want it listed under its RADIUS secret", nas, ok)
	}
	if _, ok := d.NAS(netip.MustParseAddr("198.51.100.8")); ok {
		t.Error("a push panel with no RADIUS secret is on the allowlist")
	}
}
