/**
 * The Markdown a guide's text block holds (F-414-g), read into plain data the
 * renderer turns into elements (F-414-e). A reseller writes it and every user
 * of their panel reads it, so it is never HTML: there is no raw-HTML path, a
 * tag stays text, and a link is made only of `http(s)://` or this site's own
 * `/path` — `javascript:`, `data:` and `//other.host` stay text.
 *
 * The subset is what a help text needs: `#`–`###` headings, `-`/`*` and `1.`
 * lists, `**strong**`, `*em*`/`_em_`, `` `code` `` and `[text](href)`.
 * Paragraphs keep their line breaks.
 */

export type GuideInline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: GuideInline[] }
  | { t: "em"; c: GuideInline[] }
  | { t: "link"; href: string; c: GuideInline[] };

export type GuideMarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3; inlines: GuideInline[] }
  | { kind: "paragraph"; lines: GuideInline[][] }
  | { kind: "list"; ordered: boolean; items: GuideInline[][] };

const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/;

export function parseGuideMarkdown(source: string): GuideMarkdownBlock[] {
  const out: GuideMarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flush = () => {
    if (paragraph.length) out.push({ kind: "paragraph", lines: paragraph.map(parseInline) });
    if (list) out.push({ kind: "list", ordered: list.ordered, items: list.items.map(parseInline) });
    paragraph = [];
    list = null;
  };

  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      out.push({ kind: "heading", level: heading[1].length as 1 | 2 | 3, inlines: parseInline(heading[2]) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      const ordered = numbered !== null;
      if (paragraph.length || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push(item[1]);
      continue;
    }
    if (list) flush();
    paragraph.push(line);
  }
  flush();
  return out;
}

/** A link target worth following: an absolute http(s) URL, or a path on this site (never `//host`). */
export function safeHref(href: string): string | null {
  const h = href.trim();
  if (/^https?:\/\/[^\s]+$/i.test(h)) return h;
  if (/^\/(?!\/)[^\s]*$/.test(h)) return h;
  return null;
}

const TOKEN = /`([^`\n]+)`|\*\*(.+?)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)|(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])/;

export function parseInline(text: string): GuideInline[] {
  const out: GuideInline[] = [];
  let rest = text;
  const push = (v: string) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last?.t === "text") last.v += v;
    else out.push({ t: "text", v });
  };
  while (rest) {
    const m = TOKEN.exec(rest);
    if (!m) {
      push(rest);
      break;
    }
    push(rest.slice(0, m.index));
    const [whole, code, strong, label, href, em1, em2] = m;
    if (code !== undefined) out.push({ t: "code", v: code });
    else if (strong !== undefined) out.push({ t: "strong", c: parseInline(strong) });
    else if (label !== undefined) {
      const safe = safeHref(href);
      if (safe) out.push({ t: "link", href: safe, c: parseInline(label) });
      else push(whole);
    } else out.push({ t: "em", c: parseInline(em1 ?? em2) });
    rest = rest.slice(m.index + whole.length);
  }
  return out;
}
