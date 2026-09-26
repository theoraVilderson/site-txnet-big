package converge

import (
	"crypto/sha256"
	"strconv"

	"network-service/internal/driver"
)

// One purchase is one account on a panel (F-114-n, contract.provisioning.md
// "One purchase, one account"). Every config of a Grant's placement carries
// one `credentialGroupId`; its clients on a panel share a subscription key and
// are named `<key>-1`, `<key>-2`, each with its own uuid (invariant 1).

// SubscriptionKey is the key a credential group's clients share: 16 of
// [a-z0-9], the shape x-ui gives a subId of its own. It is derived, never
// stored, so a pick added later joins the same account; hashed, so the
// group's id is not readable off the panel. No group gives no key.
func SubscriptionKey(credentialGroupID string) string {
	if credentialGroupID == "" {
		return ""
	}
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	sum := sha256.Sum256([]byte("txnet-subscription:" + credentialGroupID))
	out := make([]byte, 16)
	for i := range out {
		out[i] = alphabet[int(sum[i])%len(alphabet)]
	}
	return string(out)
}

// accountNames hands out client names over the one ListClients a pass read.
// A name is never one the panel already holds, ours or not, nor one handed
// out earlier in the pass.
type accountNames struct {
	taken map[string]bool
}

func newAccountNames(clients []driver.RemoteClient) *accountNames {
	taken := make(map[string]bool, len(clients))
	for _, c := range clients {
		taken[c.RemoteID] = true
	}
	return &accountNames{taken: taken}
}

// For is what a create of this row asks for. A row of no group asks nothing:
// the family names it and gives it a key of its own. A recreate keeps the
// name it had while the panel does not hold it; otherwise the lowest free n.
func (a *accountNames) For(row DesiredConfig) (key, name string) {
	key = SubscriptionKey(row.CredentialGroupID)
	if key == "" {
		return "", ""
	}
	name = row.RemoteID
	for n := 1; name == "" || a.taken[name]; n++ {
		name = key + "-" + strconv.Itoa(n)
	}
	a.taken[name] = true
	return key, name
}
