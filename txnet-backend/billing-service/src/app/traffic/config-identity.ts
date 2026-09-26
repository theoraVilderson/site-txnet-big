/**
 * Which config a pasted line is (F-307-p), with its name left out.
 *
 * A line's name changes under the buyer — their own label (F-307-g), the
 * reseller's template (F-307-j), the ` 2` numbering (ADR-0089) — so a copy
 * made last week carries a name no stored line does. What does not change is
 * the client: the uuid a vless/vmess/trojan line carries is `config.uuid`
 * (network `contract.drivers.md`: trojan's password is the uuid). Any other
 * line is compared as captured, without its `#name` (`nameLine` in
 * `line-names.ts` is the other half of this).
 */

export type ConfigIdentity = { uuid: string } | { line: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VMESS = 'vmess://';
/** The schemes whose user part is the client's uuid. */
const USER_IS_UUID = /^(?:vless|trojan):\/\/([^@#?/]+)@/i;

/** A pasted line's identity, or `null` for a blank one. */
export function configIdentityOf(pasted: string): ConfigIdentity | null {
  const line = pasted.trim();
  if (line === '') return null;
  const uuid = uuidOf(line);
  return uuid ? { uuid: uuid.toLowerCase() } : { line: storedLineIdentity(line) };
}

/** A captured line as a pasted one is compared with it: its `#name` left out. */
export function storedLineIdentity(line: string): string {
  const hash = line.indexOf('#');
  return hash < 0 ? line : line.slice(0, hash);
}

function uuidOf(line: string): string | null {
  if (line.slice(0, VMESS.length).toLowerCase() === VMESS) return vmessId(line.slice(VMESS.length));
  const user = USER_IS_UUID.exec(line)?.[1];
  if (!user) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(user);
  } catch {
    return null;
  }
  return UUID.test(decoded) ? decoded : null;
}

/** `id` of a vmess base64 JSON payload, when it is a uuid. */
function vmessId(payload: string): string | null {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(payload)) return null;
  try {
    const obj: unknown = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    const id = obj !== null && typeof obj === 'object' ? (obj as { id?: unknown }).id : undefined;
    return typeof id === 'string' && UUID.test(id) ? id : null;
  } catch {
    return null;
  }
}
