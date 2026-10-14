package localeclient

import (
	"context"

	"github.com/txnet/i18n-platform/clients/go/localev1"
)

// Runtime writes (F-1533-b, ADR-0050). These go straight to locale-service and
// touch no cache: a published write comes back through Watch like any edit.
// Scope here is the write target ("backend" | "frontend" | "shareds"), not
// Config.Scope. An empty value deletes that key from that state.

// SetEntries writes entries as published (served) or draft (held for review).
func (c *Client) SetEntries(ctx context.Context, scope, lang, namespace string, entries map[string]string, draft bool) (int, error) {
	state := localev1.EntryState_ENTRY_STATE_PUBLISHED
	if draft {
		state = localev1.EntryState_ENTRY_STATE_DRAFT
	}
	resp, err := c.rpc.SetEntries(ctx, &localev1.SetEntriesRequest{
		Scope: scope, Lang: lang, Namespace: namespace, Entries: entries, State: state,
	})
	if err != nil {
		return 0, err
	}
	return int(resp.GetWritten()), nil
}

// ListDrafts returns drafts held for review; every empty filter matches all.
func (c *Client) ListDrafts(ctx context.Context, scope, lang, namespace, keyPrefix string) ([]*localev1.DraftEntry, error) {
	resp, err := c.rpc.ListDrafts(ctx, &localev1.ListDraftsRequest{
		Scope: scope, Lang: lang, Namespace: namespace, KeyPrefix: keyPrefix,
	})
	if err != nil {
		return nil, err
	}
	return resp.GetDrafts(), nil
}

// PublishDrafts moves the named drafts to published, as they are.
func (c *Client) PublishDrafts(ctx context.Context, scope, lang, namespace string, keys []string) (int, error) {
	resp, err := c.rpc.PublishDrafts(ctx, &localev1.PublishDraftsRequest{
		Scope: scope, Lang: lang, Namespace: namespace, Keys: keys,
	})
	if err != nil {
		return 0, err
	}
	return int(resp.GetPublished()), nil
}
