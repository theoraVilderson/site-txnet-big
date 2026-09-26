/**
 * A config's link lines (F-307-a) as the service page shows them (F-307-c):
 * a name for each, and — for a `wireguard://` line only — the `.conf` file a
 * WireGuard app imports. Everything here runs in the browser: a line carries
 * its config's private key, so it never leaves for a converter.
 */

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function scheme(line: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(line);
  return m ? m[1].toLowerCase() : null;
}

/**
 * What a user calls a line: its `#name`, else a vmess line's `ps`, else its
 * protocol. The panel names its lines, so the fallback is rare.
 */
export function lineLabel(line: string): string {
  const hash = line.indexOf("#");
  if (hash >= 0 && hash < line.length - 1) return decode(line.slice(hash + 1));
  const proto = scheme(line);
  if (proto === "vmess") {
    try {
      const ps = (JSON.parse(atob(line.slice("vmess://".length))) as { ps?: unknown }).ps;
      if (typeof ps === "string" && ps) return ps;
    } catch {
      // Not the base64 JSON form: named by its protocol.
    }
  }
  return proto ?? line.slice(0, 24);
}

/**
 * The query, read by hand: `URLSearchParams` turns a `+` into a space, and a
 * base64 key sent unencoded is full of them.
 */
function params(query: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of query.replace(/^\?/, "").split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = decode(eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
    if (!out.has(key)) out.set(key, eq < 0 ? "" : decode(pair.slice(eq + 1)));
  }
  return out;
}

function first(p: Map<string, string>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = p.get(k)?.trim();
    if (v) return v;
  }
  return null;
}

const list = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(", ");

/**
 * A `wireguard://<private key>@<host>:<port>?publickey=…&address=…` line as a
 * WireGuard `.conf`, or `null` when the line cannot make one that connects —
 * no private key, no endpoint port, no peer key or no address. A half file
 * imports cleanly and then never connects, so it is not offered at all.
 * Routes everything through the peer unless the line names `allowedips`.
 */
export function wireguardConf(line: string): string | null {
  if (scheme(line) !== "wireguard" && scheme(line) !== "wg") return null;
  // Split by hand, not with `URL`: a base64 key sent unencoded may hold a `/`,
  // which a URL parser reads as the end of the authority.
  let rest = line.slice(line.indexOf("://") + 3);
  const hash = rest.indexOf("#");
  if (hash >= 0) rest = rest.slice(0, hash);
  const q = rest.indexOf("?");
  const p = params(q >= 0 ? rest.slice(q + 1) : "");
  const authority = (q >= 0 ? rest.slice(0, q) : rest).replace(/\/+$/, "");
  const at = authority.lastIndexOf("@");
  if (at <= 0) return null;
  const privateKey = decode(authority.slice(0, at)).trim();
  const endpoint = /^(\[[0-9a-f:.]+\]|[^:\s]+):(\d{1,5})$/i.exec(authority.slice(at + 1));
  const publicKey = first(p, "publickey", "public_key", "peer_public_key");
  const address = first(p, "address", "ip");
  if (!privateKey || !endpoint || !publicKey || !address) return null;
  const dns = first(p, "dns");
  const mtu = first(p, "mtu");
  const psk = first(p, "presharedkey", "pre_shared_key", "psk");
  const allowed = first(p, "allowedips", "allowed_ips");
  const keepalive = first(p, "keepalive", "persistentkeepalive");

  const out = ["[Interface]", `PrivateKey = ${privateKey}`, `Address = ${list(address)}`];
  if (dns) out.push(`DNS = ${list(dns)}`);
  if (mtu) out.push(`MTU = ${mtu}`);
  out.push("", "[Peer]", `PublicKey = ${publicKey}`);
  if (psk) out.push(`PresharedKey = ${psk}`);
  out.push(`AllowedIPs = ${allowed ? list(allowed) : "0.0.0.0/0, ::/0"}`, `Endpoint = ${endpoint[1]}:${endpoint[2]}`);
  if (keepalive) out.push(`PersistentKeepalive = ${keepalive}`);
  out.push("");
  return out.join("\n");
}

/** A file name from the line's name, with what a file system refuses replaced. */
export function confFileName(line: string): string {
  const name = lineLabel(line)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .trim();
  return `${name || "wireguard"}.conf`;
}
