"use client";

import Link from "next/link";
import { Fragment } from "react";
import { AlertTriangle, Info, Lightbulb, OctagonAlert } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { guideFileUrl, type CalloutTone, type GuideBlock } from "@/lib/guide-api";
import { parseGuideMarkdown, type GuideInline } from "../../_lib/guide-markdown";

const K = FrontendI18nKeys.common.guides;

const TONE: Record<CalloutTone, { icon: typeof Info; box: string }> = {
  info: { icon: Info, box: "border-card-border bg-bg-inner" },
  tip: { icon: Lightbulb, box: "border-primary bg-leaf-bg" },
  warning: { icon: AlertTriangle, box: "border-gold bg-gold-bg" },
  danger: { icon: OctagonAlert, box: "border-error-border bg-error-bg" },
};

/**
 * A guide's blocks as a reader sees them (F-414-e) — on a page's help, the
 * install guide, and the settings page's preview and read-only view, so an
 * admin previews exactly what users get. Text is Markdown, read by
 * `parseGuideMarkdown` into data and built here as elements: a reseller's text
 * never becomes HTML. Files are object keys, served on this Host.
 */
export function GuideBlocks({ blocks, dir }: { blocks: readonly GuideBlock[]; dir?: string }) {
  const { t } = useLocale();
  return (
    <div dir={dir} className="flex flex-col gap-4 text-sm leading-7 text-text-primary">
      {blocks.map((b, i) => {
        switch (b.type) {
          case "text":
            return <GuideMarkdown key={i} text={b.text} />;
          case "image":
            return (
              <figure key={i} className="flex flex-col gap-1">
                {/* eslint-disable-next-line @next/next/no-img-element -- a stored file on this Host, sized by its author */}
                <img src={guideFileUrl(b.file)} alt={b.alt} className="max-h-96 rounded-xl border border-card-border object-contain" />
                {b.caption && <figcaption className="text-xs text-text-secondary">{b.caption}</figcaption>}
              </figure>
            );
          case "video":
            return (
              <figure key={i} className="flex flex-col gap-1">
                <video src={guideFileUrl(b.file)} poster={guideFileUrl(b.poster)} controls playsInline preload="none" className="max-h-96 w-full rounded-xl bg-black" />
                {b.caption && <figcaption className="text-xs text-text-secondary">{b.caption}</figcaption>}
              </figure>
            );
          case "steps":
            return (
              <ol key={i} className="flex list-decimal flex-col gap-3 ps-5">
                {b.items.map((it, j) => (
                  <li key={j} className="flex flex-col gap-2">
                    <GuideMarkdown text={it.text} />
                    {it.image && (
                      // eslint-disable-next-line @next/next/no-img-element -- as above
                      <img src={guideFileUrl(it.image)} alt="" className="max-h-72 rounded-xl border border-card-border object-contain" />
                    )}
                  </li>
                ))}
              </ol>
            );
          case "callout": {
            const { icon: Icon, box } = TONE[b.tone];
            return (
              <aside key={i} className={`flex gap-3 rounded-2xl border p-3 ${box}`}>
                <Icon size={18} className="mt-1 shrink-0" aria-label={t("common", K.tone[b.tone])} />
                <div className="flex min-w-0 flex-col gap-1">
                  {b.title && <strong className="text-sm">{b.title}</strong>}
                  <GuideMarkdown text={b.text} />
                </div>
              </aside>
            );
          }
        }
      })}
    </div>
  );
}

const HEADING_CLASS = { 1: "text-lg font-bold", 2: "text-base font-bold", 3: "text-sm font-bold" } as const;

/** One Markdown text, as elements. */
export function GuideMarkdown({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2 break-words">
      {parseGuideMarkdown(text).map((b, i) => {
        if (b.kind === "heading") {
          const H = `h${b.level + 2}` as "h3" | "h4" | "h5";
          return (
            <H key={i} className={HEADING_CLASS[b.level]}>
              <Inlines nodes={b.inlines} />
            </H>
          );
        }
        if (b.kind === "list") {
          const L = b.ordered ? "ol" : "ul";
          return (
            <L key={i} className={`flex flex-col gap-1 ps-5 ${b.ordered ? "list-decimal" : "list-disc"}`}>
              {b.items.map((item, j) => (
                <li key={j}>
                  <Inlines nodes={item} />
                </li>
              ))}
            </L>
          );
        }
        return (
          <p key={i}>
            {b.lines.map((line, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                <Inlines nodes={line} />
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function Inlines({ nodes }: { nodes: GuideInline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case "text":
            return <Fragment key={i}>{n.v}</Fragment>;
          case "code":
            return (
              <code key={i} dir="ltr" className="rounded bg-bg-inner px-1 font-mono text-[0.9em]">
                {n.v}
              </code>
            );
          case "strong":
            return (
              <strong key={i}>
                <Inlines nodes={n.c} />
              </strong>
            );
          case "em":
            return (
              <em key={i}>
                <Inlines nodes={n.c} />
              </em>
            );
          case "link":
            return n.href.startsWith("/") ? (
              <Link key={i} href={n.href} className="font-bold text-primary underline">
                <Inlines nodes={n.c} />
              </Link>
            ) : (
              <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow" className="font-bold text-primary underline">
                <Inlines nodes={n.c} />
              </a>
            );
        }
      })}
    </>
  );
}
