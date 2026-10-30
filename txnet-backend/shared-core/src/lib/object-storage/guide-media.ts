/**
 * Which guide files the media route hands out, and as what (F-018-m2-b,
 * ADR-0118). The route signs a URL for any key it accepts and reads no row,
 * so this shape is the whole of its safety: only a key the port minted under
 * `guides/` — lower-case uuids, a known extension, never `.tmp`, never `..` —
 * and never branding, a support attachment or a receipt.
 */

/** A guide file's stored type -> the extension its key is minted with (F-414-c, F-414-i). */
export const GUIDE_FILE_EXTENSIONS = {
  'image/png': 'png',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
} as const;
export type GuideFileType = keyof typeof GUIDE_FILE_EXTENSIONS;

/**
 * Who asks: a browser gets videos only (pictures keep the file route, which
 * holds them to the Host's tenant, rule 8); the bot sends pictures and video
 * into the chat, so it gets both (F-414-f).
 */
export type GuideMediaAudience = 'browser' | 'bot';

const VIDEO_TYPES: readonly GuideFileType[] = ['video/mp4', 'video/webm'];

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const GUIDE_FILE_KEY = new RegExp(`^tenants/${UUID}/guides/${UUID}/${UUID}\\.([a-z0-9]+)$`);

const TYPE_OF_EXTENSION = new Map<string, GuideFileType>(
  (Object.entries(GUIDE_FILE_EXTENSIONS) as [GuideFileType, string][]).map(([type, ext]) => [ext, type]),
);

/** The type `key` is served as to `audience`, or `null` when the media route must not serve it. */
export function guideMediaType(key: string, audience: GuideMediaAudience): GuideFileType | null {
  const ext = GUIDE_FILE_KEY.exec(key)?.[1];
  const type = ext === undefined ? undefined : TYPE_OF_EXTENSION.get(ext);
  if (!type) return null;
  return audience === 'bot' || VIDEO_TYPES.includes(type) ? type : null;
}
