import * as cheerio from 'cheerio';

export function normalizeDomain(urlOrHost: string): string {
  const trimmed = (urlOrHost || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return trimmed.toLowerCase().replace(/^www\./, '').split('/')[0] ?? '';
  }
}

export function isSameWebsiteDomain(hostA: string, hostB: string): boolean {
  const a = normalizeDomain(hostA);
  const b = normalizeDomain(hostB);
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export function isPaginationText(rawText: string): boolean {
  const text = rawText.replace(/\s+/g, ' ').trim();
  if (!text || text.length > 90) return false;

  // e.g. "Pages: 1 2 3", "Pages: 1, 2, 3 Next ›", "Strony: 1 2 3", "Stránky: 1 2 3"
  if (
    /^(?:pages?|stránky|stranky|strany|strony|seiten|p[áa]ginas?|sidor|oldalak)\s*:?\s*(?:(?:\d+|prev(?:ious)?|next|další|pokračovat|następna|poprzednia|weiter|suivant|‹|›|«|»|←|→|[|·•,/–—-])+\s*)+$/i.test(
      text
    )
  ) {
    return true;
  }

  // e.g. "Page 1 of 3", "Strana 2 z 4"
  if (/^(?:page|strana|stránka|strona|seite|p[áa]gina)\s+\d+\s+(?:of|z|ze|von|de)\s+\d+$/i.test(text)) {
    return true;
  }

  // e.g. "← Previous 1 2 3 Next →" or "Next page →"
  if (
    /^(?:(?:previous|prev|next|next\s+page|prev\s+page|další|další\s+strana|pokračovat|předchozí|następna|poprzednia|weiter|zurück|suivant|précédent|←|→|«|»|‹|›)\s*[|·•,/–—-]?\s*)+(?:\d+\s*[|·•,/–—-]?\s*)*$/i.test(
      text
    )
  ) {
    return true;
  }

  // e.g. "1 2 3" or "1 2 3 Next ›"
  if (
    /^(?:\d{1,2}\s*[|·•,/–—-]?\s+){1,15}\d{1,2}(?:\s*[|·•,/–—-]?\s*(?:next|prev|previous|další|pokračovat|następna|poprzednia|←|→|«|»|‹|›))?$/i.test(
      text
    )
  ) {
    return true;
  }

  return false;
}

export function isSourceAttributionText(rawText: string): boolean {
  const text = rawText.replace(/\s+/g, ' ').trim();
  if (!text) return false;
  return /^(?:source|zdroj|źródło|zrodlo|quelle|fuente)\s*:\s*(?:https?:\/\/|www\.)\S*$/i.test(text);
}

export function stripSourceUrlsFromText(
  text: string,
  sourceUrl?: string,
  destinationSiteUrl?: string
): string {
  if (!text) return text;
  const sourceDomain = sourceUrl ? normalizeDomain(sourceUrl) : '';
  const destDomain = destinationSiteUrl ? normalizeDomain(destinationSiteUrl) : '';

  let cleaned = text.replace(/(?:^|\n)\s*(?:source|zdroj|źródło|zrodlo|quelle|fuente)\s*:\s*(?:https?:\/\/|www\.)\S+/gi, '');

  if (sourceDomain && !(destDomain && isSameWebsiteDomain(sourceDomain, destDomain))) {
    cleaned = cleaned.replace(/(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi, (match) => {
      const candidateDomain = normalizeDomain(match);
      if (candidateDomain && isSameWebsiteDomain(candidateDomain, sourceDomain)) {
        return '';
      }
      return match;
    });
  }

  cleaned = cleaned
    .replace(/\b(?:source|zdroj|źródło|zrodlo|quelle|fuente)\s*:\s*(?:$|\n)/gim, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();

  return cleaned;
}

export function stripSourceLinksInCheerio(
  $: cheerio.CheerioAPI,
  $root: ReturnType<cheerio.CheerioAPI>,
  sourceUrl: string,
  destinationSiteUrl?: string
): void {
  const sourceDomain = normalizeDomain(sourceUrl);
  const destDomain = destinationSiteUrl ? normalizeDomain(destinationSiteUrl) : '';

  $root.find('a').each((_, el) => {
    const $a = $(el);
    const rawHref = ($a.attr('href') || '').trim();
    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('mailto:') || rawHref.startsWith('tel:') || rawHref.startsWith('javascript:')) {
      return;
    }

    let resolved: URL | null = null;
    try {
      resolved = new URL(rawHref, sourceUrl);
    } catch {
      resolved = null;
    }

    if (!resolved || (resolved.protocol !== 'http:' && resolved.protocol !== 'https:')) {
      return;
    }

    const linkDomain = normalizeDomain(resolved.hostname);
    if (destDomain && isSameWebsiteDomain(linkDomain, destDomain)) {
      return;
    }

    if (sourceDomain && isSameWebsiteDomain(linkDomain, sourceDomain)) {
      if ($a.find('img, figure, picture').length > 0) {
        $a.replaceWith($a.contents());
        return;
      }
      const linkText = $a.text().replace(/\s+/g, ' ').trim();
      const lowerText = linkText.toLowerCase();
      if (
        !linkText ||
        /^(?:https?:\/\/|www\.)/i.test(linkText) ||
        lowerText.includes(sourceDomain) ||
        isPaginationText(linkText)
      ) {
        $a.remove();
      } else {
        $a.replaceWith(linkText);
      }
    }
  });
}

export const PAGINATION_CONTAINER_SELECTOR = [
  '.page-links',
  '.post-nav-links',
  '.post-pages',
  '.page-numbers',
  '.pagination',
  '.nav-links',
  '.pager',
  '.wp-pagenavi',
  '.post-pagination',
  '.entry-pagination',
  '[class*="page-links"]',
  '[class*="post-nav-links"]',
  'nav[aria-label*="page" i]',
  'nav[aria-label*="pagination" i]',
].join(', ');

export function cleanPublishedPageHtml(
  html: string,
  sourceUrl: string,
  destinationSiteUrl: string
): string {
  if (!html || !html.trim()) return '';

  const $ = cheerio.load(`<div id="__s7_root">${html}</div>`, null, false);
  const $root = $('#__s7_root');

  $root.find(`.s7-source-attribution, ${PAGINATION_CONTAINER_SELECTOR}`).remove();

  if (sourceUrl) {
    stripSourceLinksInCheerio($, $root, sourceUrl, destinationSiteUrl);
  }

  // Strip bare source URLs from text nodes outside figures/code
  const sourceDomain = sourceUrl ? normalizeDomain(sourceUrl) : '';
  const destDomain = destinationSiteUrl ? normalizeDomain(destinationSiteUrl) : '';

  const cleanTextNodes = (node: unknown) => {
    const n = node as { type?: string; data?: string; tagName?: string; children?: unknown[] };
    if (!n) return;
    if (n.type === 'text' && typeof n.data === 'string') {
      let val = n.data;
      if (sourceDomain && !(destDomain && isSameWebsiteDomain(sourceDomain, destDomain))) {
        val = val.replace(/(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi, (match) => {
          const cand = normalizeDomain(match);
          return cand && isSameWebsiteDomain(cand, sourceDomain) ? '' : match;
        });
      }
      val = val.replace(/\b(?:source|zdroj|źródło|zrodlo|quelle|fuente)\s*:\s*$/i, '');
      n.data = val;
      return;
    }
    if (n.type === 'tag') {
      const tag = (n.tagName ?? '').toLowerCase();
      if (tag === 'figure' || tag === 'img' || tag === 'code' || tag === 'pre') return;
      if (Array.isArray(n.children)) {
        for (const child of n.children) {
          cleanTextNodes(child);
        }
      }
    }
  };

  $root.contents().each((_, child) => cleanTextNodes(child));

  // Remove blocks that are pagination text, source attribution, or became empty
  $root.find('p, div, span, small, li, ul, ol, nav').each((_, el) => {
    const $el = $(el);
    if ($el.find('img, figure').length > 0 || $el.closest('figure').length > 0) {
      return;
    }
    const text = $el.text().replace(/\s+/g, ' ').trim();
    if (!text) {
      if ($el.is('p, div, small, li, ul, ol, nav')) {
        $el.remove();
      }
      return;
    }
    if (isPaginationText(text) || isSourceAttributionText(text) || /^(?:source|zdroj|źródło|zrodlo|quelle|fuente)\s*:?$/i.test(text)) {
      $el.remove();
    }
  });

  // Clean empty list containers left behind
  $root.find('ul, ol').each((_, el) => {
    const $el = $(el);
    if ($el.find('li').length === 0 && !$el.text().trim()) {
      $el.remove();
    }
  });

  return ($root.html() ?? '').trim();
}
