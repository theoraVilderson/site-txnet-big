// Package radius is the push half of collection (F-027-af, ADR-0071/0074): a
// UDP receiver for RADIUS accounting, and the per-session arithmetic that
// turns a NAS's packets into the same delta stream a pull pass produces.
//
// It is the new attack surface ADR-0071 names — UDP from the internet under a
// shared secret — so the order a packet meets this package in is the defence:
//
//  1. The source address is looked up first. A NAS is an accepted push panel,
//     and its `ipAddress` is the allowlist entry; anything else is dropped
//     before a byte of it is hashed.
//  2. The Request Authenticator is verified under **that NAS's** secret (the
//     panel's vault login). A packet signed with another NAS's secret is not
//     that NAS's packet.
//  3. Only then is a counter believed, and only once the bytes are published
//     and the session row advanced is the NAS acked. An unacked NAS
//     retransmits: the NAS is this side's retry queue, which is invariant 18
//     on the push side.
//
// The wire is RFC 2865 §3 / RFC 2866 §3, hand-parsed: accounting needs a dozen
// attributes and one MD5, and a library is a supply chain (ADR-0071) for less
// code than its adapter would be.
package radius

import (
	"crypto/md5" //nolint:gosec // RFC 2866 defines the authenticator over MD5; there is no other choice on this wire.
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"fmt"
)

// Packet codes this receiver speaks (RFC 2866 §3).
const (
	CodeAccountingRequest  byte = 4
	CodeAccountingResponse byte = 5
)

// Attribute types this receiver reads. Everything else is carried and ignored.
const (
	AttrUserName            byte = 1
	AttrNASIPAddress        byte = 4
	AttrNASIdentifier       byte = 32
	AttrAcctStatusType      byte = 40
	AttrAcctInputOctets     byte = 42
	AttrAcctOutputOctets    byte = 43
	AttrAcctSessionID       byte = 44
	AttrAcctSessionTime     byte = 46
	AttrAcctInputGigawords  byte = 52
	AttrAcctOutputGigawords byte = 53
)

// StatusType is Acct-Status-Type.
type StatusType uint32

const (
	StatusStart         StatusType = 1
	StatusStop          StatusType = 2
	StatusInterimUpdate StatusType = 3
	StatusAccountingOn  StatusType = 7
	StatusAccountingOff StatusType = 8
)

// headerLen is code, identifier, length and the 16-octet authenticator.
const headerLen = 20

// MaxPacketLen is RFC 2865's ceiling. A datagram past it is not RADIUS.
const MaxPacketLen = 4096

var (
	// ErrMalformed is a packet whose own framing contradicts itself.
	ErrMalformed = errors.New("radius: malformed packet")
	// ErrBadAuthenticator is a packet not signed under this NAS's secret —
	// forged, corrupted, or from a NAS configured with another's secret.
	ErrBadAuthenticator = errors.New("radius: request authenticator does not verify")
)

// Attribute is one type-length-value.
type Attribute struct {
	Type  byte
	Value []byte
}

// Packet is a verified request.
type Packet struct {
	Code          byte
	Identifier    byte
	Authenticator [16]byte
	Attributes    []Attribute
}

// Parse frames b and verifies its Request Authenticator under secret:
// MD5(Code+Identifier+Length+16 zero octets+Attributes+Secret). Nothing in a
// packet that fails either is returned.
func Parse(b []byte, secret []byte) (Packet, error) {
	if len(b) < headerLen || len(b) > MaxPacketLen {
		return Packet{}, fmt.Errorf("%w: %d octets", ErrMalformed, len(b))
	}
	length := int(binary.BigEndian.Uint16(b[2:4]))
	if length < headerLen || length > len(b) {
		return Packet{}, fmt.Errorf("%w: length field %d over %d octets", ErrMalformed, length, len(b))
	}
	// Octets past Length are padding (RFC 2865 §3) and are not signed.
	b = b[:length]

	p := Packet{Code: b[0], Identifier: b[1]}
	copy(p.Authenticator[:], b[4:20])
	for rest := b[headerLen:]; len(rest) > 0; {
		if len(rest) < 2 || rest[1] < 2 || int(rest[1]) > len(rest) {
			return Packet{}, fmt.Errorf("%w: attribute framing", ErrMalformed)
		}
		p.Attributes = append(p.Attributes, Attribute{Type: rest[0], Value: rest[2:rest[1]]})
		rest = rest[rest[1]:]
	}

	h := md5.New() //nolint:gosec // see the import comment.
	h.Write(b[:4])
	h.Write(make([]byte, 16))
	h.Write(b[headerLen:])
	h.Write(secret)
	if subtle.ConstantTimeCompare(h.Sum(nil), p.Authenticator[:]) != 1 {
		return Packet{}, ErrBadAuthenticator
	}
	return p, nil
}

// Response is the Accounting-Response acknowledging req, with no attributes:
// its authenticator is MD5(Code+Identifier+Length+RequestAuth+Secret).
func Response(req Packet, secret []byte) []byte {
	raw := encode(CodeAccountingResponse, req.Identifier, req.Authenticator, nil)
	h := md5.New() //nolint:gosec // see the import comment.
	h.Write(raw)
	h.Write(secret)
	copy(raw[4:20], h.Sum(nil))
	return raw
}

// encode lays a packet out with auth in the authenticator field.
func encode(code, id byte, auth [16]byte, attrs []Attribute) []byte {
	raw := make([]byte, headerLen, headerLen+64)
	raw[0], raw[1] = code, id
	copy(raw[4:20], auth[:])
	for _, a := range attrs {
		raw = append(raw, a.Type, byte(len(a.Value)+2))
		raw = append(raw, a.Value...)
	}
	binary.BigEndian.PutUint16(raw[2:4], uint16(len(raw)))
	return raw
}
