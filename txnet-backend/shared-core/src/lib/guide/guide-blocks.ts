import { z } from 'zod';

import { parseObjectKey } from '../object-storage/object-key';

/**
 * F-414-g — **a guide's text is an ordered array of typed blocks**
 * (ADR-0116 point 1), stored as `guide.guide_translation.blocks`.
 *
 * Here because the writer (tenant-service) and both renderers (the panel
 * through the API, bot-service in-process) read one shape. A renderer handles
 * every type in {@link GUIDE_BLOCK_TYPES}; Markdown lives only inside a block.
 *
 * A file is named by its object-storage key (object-storage rule 2: a domain
 * rotates, a key does not) and only under the owner's `guides/` path, so a
 * guide cannot point at a branding logo or a support attachment. That the key
 * is the writer's own tenant's is the writer's check (F-414-c).
 */

export const GUIDE_BLOCK_TYPES = ['text', 'image', 'video', 'steps', 'callout'] as const;
export type GuideBlockType = (typeof GUIDE_BLOCK_TYPES)[number];

export const GUIDE_CALLOUT_TONES = ['info', 'tip', 'warning', 'danger'] as const;
export type GuideCalloutTone = (typeof GUIDE_CALLOUT_TONES)[number];

/** Blocks per text; the database holds the same bound (`guide_translation_blocks`). */
export const GUIDE_BLOCKS_MAX = 100;
/** The serialized array's ceiling, the same figure as the database's CHECK. */
export const GUIDE_BLOCKS_MAX_BYTES = 65_536;

const markdown = (max: number) => z.string().trim().min(1).max(max);

const guideFileKey = z
  .string()
  .refine((key) => parseObjectKey(key)?.path.startsWith('guides/') === true, {
    message: 'a guide file is an object key under guides/',
  });

const textBlock = z.object({ type: z.literal('text'), text: markdown(20_000) }).strict();

const imageBlock = z
  .object({
    type: z.literal('image'),
    file: guideFileKey,
    alt: z.string().trim().min(1).max(200),
    caption: z.string().trim().min(1).max(300).optional(),
  })
  .strict();

/** Served by the store with Range, never through a Nest route (ADR-0116 point 3, F-414-i). */
const videoBlock = z
  .object({
    type: z.literal('video'),
    file: guideFileKey,
    poster: guideFileKey,
    caption: z.string().trim().min(1).max(300).optional(),
  })
  .strict();

const stepsBlock = z
  .object({
    type: z.literal('steps'),
    items: z
      .array(z.object({ text: markdown(2_000), image: guideFileKey.optional() }).strict())
      .min(1)
      .max(30),
  })
  .strict();

const calloutBlock = z
  .object({
    type: z.literal('callout'),
    tone: z.enum(GUIDE_CALLOUT_TONES),
    title: z.string().trim().min(1).max(120).optional(),
    text: markdown(4_000),
  })
  .strict();

export const guideBlockSchema = z.discriminatedUnion('type', [
  textBlock,
  imageBlock,
  videoBlock,
  stepsBlock,
  calloutBlock,
]);
export type GuideBlock = z.infer<typeof guideBlockSchema>;

export const guideBlocksSchema = z
  .array(guideBlockSchema)
  .min(1)
  .max(GUIDE_BLOCKS_MAX)
  .refine((blocks) => Buffer.byteLength(JSON.stringify(blocks)) <= GUIDE_BLOCKS_MAX_BYTES, {
    message: `a guide text is at most ${GUIDE_BLOCKS_MAX_BYTES} bytes`,
  });

// A block type added to the tuple without a schema fails to compile here.
const _exhaustive: Record<GuideBlockType, true> = {
  text: true,
  image: true,
  video: true,
  steps: true,
  callout: true,
} satisfies Record<GuideBlock['type'], true>;
void _exhaustive;

/** Every object key the blocks name, in order, once — what a writer checks and a delete removes. */
export function guideFileKeys(blocks: readonly GuideBlock[]): string[] {
  const keys: string[] = [];
  for (const block of blocks) {
    if (block.type === 'image') keys.push(block.file);
    else if (block.type === 'video') keys.push(block.file, block.poster);
    else if (block.type === 'steps') for (const item of block.items) if (item.image) keys.push(item.image);
  }
  return [...new Set(keys)];
}

/** What a guide file must be: a video block's `file` is played, every other file is shown as a picture. */
export type GuideFileRole = 'video' | 'image';

/**
 * Every file the blocks name, with the kind it must be (F-414-i) — a writer
 * holds each to its stored type, so a `<video>` never names a picture nor a
 * poster a video. A key named as both is refused here: no one file is both.
 */
export function guideFileRoles(blocks: readonly GuideBlock[]): Map<string, GuideFileRole> {
  const roles = new Map<string, GuideFileRole>();
  const name = (key: string, role: GuideFileRole) => {
    if (roles.get(key) && roles.get(key) !== role) throw new Error(`a guide file is named as both a video and an image: ${key}`);
    roles.set(key, role);
  };
  for (const block of blocks) {
    if (block.type === 'image') name(block.file, 'image');
    else if (block.type === 'video') {
      name(block.file, 'video');
      name(block.poster, 'image');
    } else if (block.type === 'steps') for (const item of block.items) if (item.image) name(item.image, 'image');
  }
  return roles;
}
