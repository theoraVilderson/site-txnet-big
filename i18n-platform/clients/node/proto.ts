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

message Empty {}
`;
