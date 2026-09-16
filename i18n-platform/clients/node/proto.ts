// The locale.proto contract as an inline string so the client works under any
// bundler (webpack/turbopack) with no asset-copy config. Keep in sync with
// i18n-platform/proto/locale/v1/locale.proto — it is byte-for-byte the service
// contract, only the transport-agnostic parts matter to proto-loader.

export const LOCALE_PROTO = `syntax = "proto3";

package locale.v1;

service LocaleService {
  rpc GetSnapshot(SnapshotRequest) returns (SnapshotResponse);
  rpc GetAvailableLocales(Empty) returns (AvailableLocalesResponse);
  rpc Watch(WatchRequest) returns (stream UpdateEvent);
  rpc SetEntries(SetEntriesRequest) returns (SetEntriesResponse);
  rpc ListDrafts(ListDraftsRequest) returns (ListDraftsResponse);
  rpc PublishDrafts(PublishDraftsRequest) returns (PublishDraftsResponse);
}

message SnapshotRequest {
  string lang = 1;
  string scope = 2;
}

message SnapshotResponse {
  string lang = 1;
  string scope = 2;
  string version = 3;
  map<string, NamespaceData> namespaces = 4;
}

message NamespaceData {
  map<string, string> entries = 1;
}

message WatchRequest {
  repeated string langs = 1;
  string scope = 2;
}

message UpdateEvent {
  string lang = 1;
  string scope = 2;
  string new_version = 3;
  SnapshotResponse full_snapshot = 4;
}

message AvailableLocalesResponse {
  repeated LocaleMeta locales = 1;
}

message LocaleMeta {
  string code = 1;
  string name = 2;
  string short_name = 3;
  string native_name = 4;
  string dir = 5;
  string locale = 6;
}

enum EntryState {
  ENTRY_STATE_UNSPECIFIED = 0;
  ENTRY_STATE_PUBLISHED = 1;
  ENTRY_STATE_DRAFT = 2;
}

message SetEntriesRequest {
  string scope = 1;
  string lang = 2;
  string namespace = 3;
  map<string, string> entries = 4;
  EntryState state = 5;
}

message SetEntriesResponse {
  int32 written = 1;
}

message ListDraftsRequest {
  string scope = 1;
  string lang = 2;
  string namespace = 3;
  string key_prefix = 4;
}

message DraftEntry {
  string scope = 1;
  string lang = 2;
  string namespace = 3;
  string key = 4;
  string text = 5;
}

message ListDraftsResponse {
  repeated DraftEntry drafts = 1;
}

message PublishDraftsRequest {
  string scope = 1;
  string lang = 2;
  string namespace = 3;
  repeated string keys = 4;
}

message PublishDraftsResponse {
  int32 published = 1;
}

message Empty {}
`;
