import { ImageOff } from 'lucide-react';
import { useMemo, useState } from 'react';

function SafeFigure({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  const [failed, setFailed] = useState(false);

  const isSafeUrl = useMemo(() => {
    if (/^data:image\/(jpeg|jpg|png|webp|gif|avif);base64,/i.test(src)) {
      return true;
    }
    try {
      const parsed = new URL(src);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }, [src]);

  if (!isSafeUrl || failed) {
    return (
      <figure className="my-5 overflow-hidden rounded-xl border border-slate-200/80 bg-slate-50 p-6 text-center dark:border-white/[0.08] dark:bg-white/[0.03]">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-slate-200/70 text-slate-500 dark:bg-white/[0.06] dark:text-slate-400">
          <ImageOff className="h-5 w-5" />
        </div>
        <figcaption className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          {caption || alt || 'Image preview unavailable in browser; will upload directly via server.'}
        </figcaption>
      </figure>
    );
  }

  return (
    <figure className="my-5 overflow-hidden rounded-xl border border-slate-200/80 bg-slate-50 dark:border-white/[0.08] dark:bg-white/[0.02]">
      <img
        src={src}
        alt={alt}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="max-h-72 w-full object-cover"
      />
      {(caption || alt) && (
        <figcaption className="border-t border-slate-200/60 px-3.5 py-2 text-xs text-slate-500 dark:border-white/[0.06] dark:text-slate-400">
          {caption || alt}
        </figcaption>
      )}
    </figure>
  );
}

interface ParsedNode {
  kind: 'h2' | 'h3' | 'p' | 'em-p' | 'ul' | 'ol' | 'figure';
  text?: string;
  items?: string[];
  src?: string;
  alt?: string;
  caption?: string;
}

function parseSafeNodes(html: string): ParsedNode[] {
  if (!html.trim()) return [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nodes: ParsedNode[] = [];

  doc.body.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent?.trim();
      if (text) nodes.push({ kind: 'p', text });
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    const el = child as HTMLElement;
    const tag = el.tagName.toLowerCase();

    if (tag === 'h2') {
      const text = el.textContent?.trim();
      if (text) nodes.push({ kind: 'h2', text });
    } else if (tag === 'h3') {
      const text = el.textContent?.trim();
      if (text) nodes.push({ kind: 'h3', text });
    } else if (tag === 'ul' || tag === 'ol') {
      const items: string[] = [];
      el.querySelectorAll('li').forEach((li) => {
        const t = li.textContent?.trim();
        if (t) items.push(t);
      });
      if (items.length) nodes.push({ kind: tag === 'ol' ? 'ol' : 'ul', items });
    } else if (tag === 'figure') {
      const img = el.querySelector('img');
      const src = img?.getAttribute('src') ?? '';
      const alt = img?.getAttribute('alt') ?? '';
      const caption = el.querySelector('figcaption')?.textContent?.trim();
      if (src) nodes.push({ kind: 'figure', src, alt, caption });
    } else if (tag === 'img') {
      const src = el.getAttribute('src') ?? '';
      const alt = el.getAttribute('alt') ?? '';
      if (src) nodes.push({ kind: 'figure', src, alt });
    } else {
      const text = el.textContent?.trim();
      if (text) {
        if (el.classList.contains('s7-source-attribution')) {
          return;
        }
        const isHook = el.classList.contains('s7-page-hook') || el.querySelector('em') !== null;
        nodes.push({ kind: isHook && el.children.length === 1 ? 'em-p' : 'p', text });
      }
    }
  });

  return nodes;
}

export function SafeArticlePreview({ html }: { html: string }) {
  const nodes = useMemo(() => parseSafeNodes(html), [html]);

  if (nodes.length === 0) {
    return (
      <p className="text-sm italic text-slate-400 dark:text-slate-500">
        This page has no content yet. Switch to Edit mode to add text.
      </p>
    );
  }

  return (
    <div className="space-y-4 text-[15px] leading-relaxed text-slate-700 dark:text-slate-300">
      {nodes.map((node, index) => {
        if (node.kind === 'h2') {
          return (
            <h2
              key={index}
              className="pt-2 text-lg font-semibold tracking-tight text-slate-900 dark:text-white"
            >
              {node.text}
            </h2>
          );
        }
        if (node.kind === 'h3') {
          return (
            <h3
              key={index}
              className="pt-1 text-base font-semibold text-slate-900 dark:text-slate-100"
            >
              {node.text}
            </h3>
          );
        }
        if (node.kind === 'em-p') {
          return (
            <p
              key={index}
              className="rounded-xl bg-blue-50/70 px-4 py-3 text-sm font-medium italic text-blue-950 dark:bg-blue-500/10 dark:text-blue-200"
            >
              {node.text}
            </p>
          );
        }
        if (node.kind === 'ul' && node.items) {
          return (
            <ul key={index} className="list-disc space-y-1.5 pl-5 text-[15px]">
              {node.items.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          );
        }
        if (node.kind === 'ol' && node.items) {
          return (
            <ol key={index} className="list-decimal space-y-2 pl-5 text-[15px]">
              {node.items.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ol>
          );
        }
        if (node.kind === 'figure' && node.src) {
          return <SafeFigure key={index} src={node.src} alt={node.alt ?? ''} caption={node.caption} />;
        }
        return <p key={index}>{node.text}</p>;
      })}
    </div>
  );
}
