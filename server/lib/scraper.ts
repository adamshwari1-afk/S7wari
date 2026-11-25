import * as cheerio from 'cheerio';
import type { ArticleBlock } from '../types.ts';
import {
  PAGINATION_CONTAINER_SELECTOR,
  isPaginationText,
  isSourceAttributionText,
  stripSourceLinksInCheerio,
  stripSourceUrlsFromText,
} from './sanitize.ts';
import { safeFetch } from './ssrf.ts';

export interface DecodedUrlResult {
  originalUrl: string;
  resolvedUrl: string;
  wasFacebookRedirect: boolean;
}

export interface ScrapedImage {
  url: string;
  alt: string;
  caption?: string;
  isFeatured?: boolean;
  sourceOrigin: 'og' | 'twitter' | 'content';
  estimatedSize: number;
}

export interface ScrapedArticle {
  originalUrl: string;
  resolvedUrl: string;
  wasFacebookRedirect: boolean;
  title: string;
  description: string;
  textContent: string;
  wordCount: number;
  extractionIncomplete: boolean;
  structuredBlocks: ArticleBlock[];
  hasRecipeData: boolean;
  pagesFetched: number;
  images: ScrapedImage[];
}

export function decodeSourceUrl(input: string): DecodedUrlResult {
  const trimmed = input.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Please enter a valid article URL starting with https:// or http://.');
  }

  const host = parsed.hostname.toLowerCase();
  const isFacebookRedirectHost =
    host === 'l.facebook.com' ||
    host === 'lm.facebook.com' ||
    host === 'm.facebook.com' ||
    host === 'www.facebook.com';

  if (isFacebookRedirectHost && (parsed.pathname === '/l.php' || parsed.pathname === '/flx/warn/')) {
    const uParam = parsed.searchParams.get('u');
    if (uParam) {
      let decoded = uParam;
      try {
        if (decoded.includes('%3A%2F%2F') || decoded.includes('%25')) {
          decoded = decodeURIComponent(decoded);
        }
      } catch {
        // keep first decode from searchParams
      }
      try {
        const target = new URL(decoded);
        if (target.protocol === 'http:' || target.protocol === 'https:') {
          return {
            originalUrl: trimmed,
            resolvedUrl: target.toString(),
            wasFacebookRedirect: true,
          };
        }
      } catch {
        throw new Error('The Facebook redirect link did not contain a valid destination URL.');
      }
    }
  }

  return {
    originalUrl: trimmed,
    resolvedUrl: parsed.toString(),
    wasFacebookRedirect: false,
  };
}

const NOISE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  'button',
  'nav',
  'footer',
  'aside',
  'form',
  'body > header',
  'header[role="banner"]',
  '.site-header',
  '#masthead',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="complementary"]',
  '[role="menu"]',
  '[aria-hidden="true"]',
  '.menu',
  '.nav-menu',
  '.ads',
  '.ad',
  '.advertisement',
  '.ad-unit',
  '[class*="ad-unit"]',
  '[id*="ad-slot"]',
  '.sidebar',
  '#sidebar',
  '.widget-area',
  '.comments',
  '#comments',
  '#respond',
  '.comment-list',
  '.comment-respond',
  '.cookie-banner',
  '.cookie-notice',
  '#cookie-banner',
  '#cookie-notice',
  '.cc-window',
  '.newsletter',
  '.newsletter-signup',
  '.related-posts',
  '.related-articles',
  '.jp-relatedposts',
  '.yarpp-related',
  '[class*="related-post"]',
  '[class*="related_post"]',
  '.author-box',
  '.share-buttons',
  '.social-share',
  '.sharedaddy',
  '.addtoany_share_save_container',
  '[class*="share-btn"]',
  '[class*="share-button"]',
  '.wprm-recipe-buttons',
  '.wprm-recipe-servings-adjustable-tooltip',
  '.wprm-recipe-jump',
  '.tasty-recipes-buttons',
  '.mv-create-buttons',
  '.mv-create-social',
  '.jump-to-recipe',
  '[class*="jump-to"]',
  '[class*="print-button"]',
  PAGINATION_CONTAINER_SELECTOR,
].join(', ');

const PROTECTED_ANCESTOR_SELECTOR =
  'article, main, .entry-content, .post-content, [itemprop="articleBody"], .article-content, .article-body, .story-body, .wprm-recipe-container, .wprm-recipe, .tasty-recipes, .tasty-recipe-card, .mv-create-card';

function removeNoiseSafely($: cheerio.CheerioAPI): void {
  $(NOISE_SELECTORS).each((_, el) => {
    const $el = $(el);
    if ($el.is('html, body') || $el.is(PROTECTED_ANCESTOR_SELECTOR)) {
      return;
    }
    if ($el.find(PROTECTED_ANCESTOR_SELECTOR).length > 0) {
      return;
    }
    $el.remove();
  });
}

function upgradeToHighResUrl(rawUrl: string): string {
  return rawUrl.replace(/-\d{2,4}x\d{2,4}(?=\.(?:jpe?g|png|webp|gif|avif)(?:\?|$))/i, '');
}

function hasWpSizeSuffix(rawUrl: string): boolean {
  return /-\d{2,4}x\d{2,4}(?=\.(?:jpe?g|png|webp|gif|avif)(?:\?|$))/i.test(rawUrl);
}

function isLikelyUsefulImage(imgUrl: string, alt: string, className = ''): boolean {
  const lower = imgUrl.toLowerCase();
  const lowerAlt = alt.toLowerCase();
  const lowerClass = className.toLowerCase();
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) return false;
  if (lower.endsWith('.svg') || lower.includes('.svg?') || lower.startsWith('data:')) return false;

  const blockedPatterns = [
    '1x1',
    'pixel',
    'spacer',
    'blank.',
    'avatar',
    'gravatar',
    'emoji',
    'smiley',
    'icon',
    'favicon',
    'logo',
    'site-logo',
    'brand',
    'badge',
    'spinner',
    'loader',
    'doubleclick',
    'googlesyndication',
    'facebook.com/tr',
    '/ads/',
    'adserver',
  ];
  if (blockedPatterns.some((pat) => lower.includes(pat))) return false;
  if (
    lowerAlt.includes('avatar') ||
    lowerAlt.includes('logo') ||
    lowerAlt.includes('icon') ||
    lowerClass.includes('avatar') ||
    lowerClass.includes('logo') ||
    lowerClass.includes('icon')
  ) {
    return false;
  }
  return true;
}

function pickBestSrcsetUrl(srcset: string | undefined): { url: string; maxWidth: number } | null {
  if (!srcset) return null;
  const candidates = srcset
    .split(',')
    .map((entry) => entry.trim().split(/\s+/))
    .filter((parts) => Boolean(parts[0]))
    .map((parts) => {
      const descriptor = (parts[1] ?? '').toLowerCase();
      let weight = 0;
      if (descriptor.endsWith('w')) {
        weight = parseInt(descriptor, 10) || 0;
      } else if (descriptor.endsWith('x')) {
        weight = Math.round((parseFloat(descriptor) || 1) * 1000);
      }
      return { url: parts[0], weight };
    })
    .sort((a, b) => b.weight - a.weight);

  if (!candidates[0]) return null;
  return { url: candidates[0].url, maxWidth: candidates[0].weight };
}

function extractSpacedText($: cheerio.CheerioAPI, $root: ReturnType<cheerio.CheerioAPI>): string {
  const parts: string[] = [];

  const visit = (node: unknown) => {
    const n = node as { type?: string; data?: string; tagName?: string; children?: unknown[] };
    if (!n) return;
    if (n.type === 'text') {
      const txt = (n.data ?? '').replace(/\s+/g, ' ');
      if (txt.trim()) {
        parts.push(txt.trim());
      }
      return;
    }
    if (n.type === 'tag') {
      const tag = (n.tagName ?? '').toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'svg' || tag === 'button' || tag === 'input') {
        return;
      }
      if (Array.isArray(n.children)) {
        for (const child of n.children) {
          visit(child);
        }
      }
    }
  };

  $root.contents().each((_, child) => {
    visit(child);
  });

  return parts
    .join(' ')
    .replace(/\s+([,.;:!?)\]])/g, '$1')
    .replace(/([(\[])\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatIsoDuration(iso: string | undefined): string {
  if (!iso || typeof iso !== 'string') return '';
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return iso;
  const h = match[1] ? `${match[1]} h` : '';
  const m = match[2] ? `${match[2]} min` : '';
  const s = match[3] ? `${match[3]} s` : '';
  return [h, m, s].filter(Boolean).join(' ') || iso;
}

function extractInstructionTexts(instructions: unknown): string[] {
  if (!instructions) return [];
  if (typeof instructions === 'string') {
    return instructions
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(instructions)) {
    const out: string[] = [];
    for (const item of instructions) {
      if (typeof item === 'string') {
        if (item.trim()) out.push(item.trim());
      } else if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        if (typeof obj.text === 'string' && obj.text.trim()) {
          out.push(obj.text.trim());
        } else if (Array.isArray(obj.itemListElement)) {
          out.push(...extractInstructionTexts(obj.itemListElement));
        }
      }
    }
    return out;
  }
  return [];
}

function findRecipeInJsonLd(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecipeInJsonLd(item);
      if (found) return found;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  const rawType = obj['@type'];
  const types = Array.isArray(rawType) ? rawType : [rawType];
  if (types.some((t) => typeof t === 'string' && t.toLowerCase() === 'recipe')) {
    return obj;
  }
  if (obj['@graph']) {
    return findRecipeInJsonLd(obj['@graph']);
  }
  return null;
}

interface ParsedJsonLdRecipe {
  textSummary: string;
  blocks: ArticleBlock[];
}

function extractStructuredRecipe($: cheerio.CheerioAPI): ParsedJsonLdRecipe | null {
  const scripts = $('script[type="application/ld+json"]').toArray();
  for (const script of scripts) {
    const raw = $(script).html()?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const recipe = findRecipeInJsonLd(parsed);
      if (!recipe) continue;

      const lines: string[] = ['[STRUCTURED RECIPE DATA FROM SOURCE]'];
      const blocks: ArticleBlock[] = [];
      const metaParts: string[] = [];

      if (typeof recipe.name === 'string' && recipe.name.trim()) {
        lines.push(`Recipe Name: ${recipe.name.trim()}`);
        blocks.push({ type: 'h2', text: recipe.name.trim(), keepTogether: true });
      }
      if (recipe.prepTime) {
        const val = formatIsoDuration(String(recipe.prepTime));
        lines.push(`Prep Time: ${val}`);
        metaParts.push(`Prep: ${val}`);
      }
      if (recipe.cookTime) {
        const val = formatIsoDuration(String(recipe.cookTime));
        lines.push(`Cook Time: ${val}`);
        metaParts.push(`Cook: ${val}`);
      }
      if (recipe.totalTime) {
        const val = formatIsoDuration(String(recipe.totalTime));
        lines.push(`Total Time: ${val}`);
        metaParts.push(`Total: ${val}`);
      }
      if (recipe.recipeYield) {
        const y = Array.isArray(recipe.recipeYield) ? recipe.recipeYield[0] : recipe.recipeYield;
        lines.push(`Servings / Yield: ${String(y)}`);
        metaParts.push(`Servings: ${String(y)}`);
      }
      if (metaParts.length > 0) {
        blocks.push({ type: 'p', text: metaParts.join(' · '), keepTogether: true });
      }

      if (Array.isArray(recipe.recipeIngredient) && recipe.recipeIngredient.length > 0) {
        const ingItems = recipe.recipeIngredient.map((i) => String(i).trim()).filter(Boolean);
        if (ingItems.length > 0) {
          lines.push('Ingredients:');
          ingItems.forEach((ing) => lines.push(`- ${ing}`));
          blocks.push({ type: 'h3', text: 'Ingredients', keepTogether: true });
          blocks.push({ type: 'ul', items: ingItems, keepTogether: true });
        }
      }

      const steps = extractInstructionTexts(recipe.recipeInstructions);
      if (steps.length > 0) {
        lines.push('Instructions:');
        steps.forEach((step, idx) => lines.push(`${idx + 1}. ${step}`));
        blocks.push({ type: 'h3', text: 'Instructions', keepTogether: true });
        blocks.push({ type: 'ol', items: steps, keepTogether: true });
      }

      if (lines.length > 2) {
        return { textSummary: lines.join('\n'), blocks };
      }
    } catch {
      // ignore invalid JSON-LD
    }
  }
  return null;
}

function resolveContentImage(
  $: cheerio.CheerioAPI,
  $img: ReturnType<cheerio.CheerioAPI>,
  pageUrl: string,
  fallbackTitle: string
): { url: string; alt: string; estimatedSize: number } | null {
  const widthAttr = parseInt($img.attr('width') ?? '', 10);
  const heightAttr = parseInt($img.attr('height') ?? '', 10);
  const className = $img.attr('class') ?? '';

  const srcsetBest = pickBestSrcsetUrl($img.attr('data-srcset') || $img.attr('srcset'));
  const lazyOrSrc =
    $img.attr('data-original') ||
    $img.attr('data-lazy-src') ||
    $img.attr('data-src') ||
    $img.attr('src');

  const chosenRaw =
    srcsetBest && srcsetBest.maxWidth >= 400
      ? srcsetBest.url
      : lazyOrSrc || srcsetBest?.url;

  if (!chosenRaw) return null;

  const upgradeableWp = hasWpSizeSuffix(chosenRaw);
  const srcsetHasLarge = Boolean(srcsetBest && srcsetBest.maxWidth >= 150);
  if (!srcsetHasLarge && !upgradeableWp) {
    // Reject tiny icons/badges (< 120px) while keeping all genuine article & recipe step photos
    if ((widthAttr > 0 && widthAttr < 120) || (heightAttr > 0 && heightAttr < 120)) {
      return null;
    }
  }
  if (srcsetBest && srcsetBest.maxWidth > 0 && srcsetBest.maxWidth < 120 && !upgradeableWp) {
    return null;
  }

  try {
    const resolved = new URL(chosenRaw.trim(), pageUrl).toString();
    const upgraded = upgradeToHighResUrl(resolved);
    const alt = ($img.attr('alt') || $img.attr('title') || fallbackTitle).trim() || fallbackTitle;
    if (!isLikelyUsefulImage(upgraded, alt, className)) {
      return null;
    }

    let estimatedSize = 0;
    if (widthAttr > 0 && heightAttr > 0) {
      estimatedSize = widthAttr * heightAttr;
    } else if (widthAttr > 0) {
      estimatedSize = widthAttr * widthAttr;
    } else if (srcsetBest && srcsetBest.maxWidth > 0) {
      estimatedSize = srcsetBest.maxWidth * srcsetBest.maxWidth;
    }

    return { url: upgraded, alt, estimatedSize };
  } catch {
    return null;
  }
}

function isRecipeHeadingText(text: string): 'ingredients' | 'instructions' | null {
  const lower = text.toLowerCase();
  if (/(ingredient|surovin|ingredienc|přísad|prisad|zutaten|ingrédient|co budete potřebovat)/i.test(lower)) {
    return 'ingredients';
  }
  if (/(instruction|method|direction|postup|příprav|priprav|jak na to|zubereitung|préparation)/i.test(lower)) {
    return 'instructions';
  }
  return null;
}

function markRecipeKeepTogether(blocks: ArticleBlock[]): boolean {
  let ingredientsStart = -1;
  let instructionsHeading = -1;
  let instructionsEnd = -1;

  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (b.keepTogether) {
      return true;
    }
    if (b.type === 'h2' || b.type === 'h3') {
      const kind = isRecipeHeadingText(b.text ?? '');
      if (kind === 'ingredients' && ingredientsStart === -1) {
        ingredientsStart = i;
      } else if (kind === 'instructions' && ingredientsStart !== -1 && instructionsHeading === -1) {
        instructionsHeading = i;
        let j = i + 1;
        while (j < blocks.length && blocks[j].type !== 'h2') {
          j += 1;
        }
        instructionsEnd = j;
        break;
      }
    }
  }

  if (ingredientsStart !== -1 && instructionsEnd > ingredientsStart) {
    for (let i = ingredientsStart; i < instructionsEnd; i += 1) {
      blocks[i] = { ...blocks[i], keepTogether: true };
    }
    return true;
  }
  return false;
}

const RECIPE_PLUGIN_CARD_SELECTOR =
  '.wprm-recipe-container, .wprm-recipe, .tasty-recipes, .tasty-recipe-card, .mv-create-card';

function extractRecipePluginBlocks(
  $: cheerio.CheerioAPI,
  $card: ReturnType<cheerio.CheerioAPI>,
  pageUrl: string,
  fallbackTitle: string,
  onImage: (resolved: { url: string; alt: string; estimatedSize: number }, caption?: string) => void
): ArticleBlock[] {
  const blocks: ArticleBlock[] = [];

  const titleEl = $card.find('.wprm-recipe-name, .tasty-recipes-title, .mv-create-title, h2, h3').first();
  const recipeTitle = titleEl.text().replace(/\s+/g, ' ').trim();
  if (recipeTitle) {
    blocks.push({ type: 'h2', text: recipeTitle, keepTogether: true });
  }

  const cardImg = $card
    .find('.wprm-recipe-image img, .tasty-recipes-image img, .mv-create-image img, .mv-create-pin-button img')
    .first();
  if (cardImg.length) {
    const resolved = resolveContentImage($, cardImg, pageUrl, recipeTitle || fallbackTitle);
    if (resolved) {
      onImage(resolved);
      blocks.push({
        type: 'img',
        imageUrl: resolved.url,
        alt: resolved.alt,
      });
    }
  }

  const summaryText = $card
    .find('.wprm-recipe-summary, .tasty-recipes-description, .mv-create-description')
    .first()
    .text()
    .replace(/\s+/g, ' ')
    .trim();
  if (summaryText) {
    blocks.push({ type: 'p', text: summaryText, keepTogether: true });
  }

  // Times & servings summary line
  const detailsParts: string[] = [];
  $card
    .find(
      '.wprm-recipe-time-container, .wprm-recipe-servings-container, .tasty-recipes-details li, .mv-create-time-item'
    )
    .each((_, el) => {
      const txt = extractSpacedText($, $(el));
      if (txt && txt.length <= 80 && !detailsParts.includes(txt)) {
        detailsParts.push(txt);
      }
    });
  if (detailsParts.length > 0) {
    blocks.push({ type: 'p', text: detailsParts.join(' · '), keepTogether: true });
  }

  // Ingredients (WPRM / Tasty / Mediavine Create)
  const $ingContainer = $card
    .find('.wprm-recipe-ingredients-container, .tasty-recipes-ingredients, .tasty-recipe-ingredients, .mv-create-ingredients')
    .first();

  if ($ingContainer.length) {
    const ingHeading =
      $ingContainer.find('.wprm-recipe-ingredients-header, h2, h3').first().text().replace(/\s+/g, ' ').trim() ||
      'Ingredients';
    blocks.push({ type: 'h3', text: ingHeading, keepTogether: true });

    const $groups = $ingContainer.find('.wprm-recipe-ingredient-group, .mv-create-ingredients-group');
    if ($groups.length > 0) {
      $groups.each((_, grp) => {
        const $grp = $(grp);
        const grpTitle = $grp.find('.wprm-recipe-group-name, h4').first().text().replace(/\s+/g, ' ').trim();
        if (grpTitle) {
          blocks.push({ type: 'h3', text: grpTitle, keepTogether: true });
        }
        const items: string[] = [];
        $grp.find('li').each((__, li) => {
          const itemTxt = extractSpacedText($, $(li));
          if (itemTxt) items.push(itemTxt);
        });
        if (items.length > 0) {
          blocks.push({ type: 'ul', items, keepTogether: true });
        }
      });
    } else {
      const items: string[] = [];
      $ingContainer.find('li').each((_, li) => {
        const itemTxt = extractSpacedText($, $(li));
        if (itemTxt) items.push(itemTxt);
      });
      if (items.length === 0) {
        $ingContainer.find('p').each((_, pEl) => {
          const itemTxt = extractSpacedText($, $(pEl));
          if (itemTxt) items.push(itemTxt);
        });
      }
      if (items.length > 0) {
        blocks.push({ type: 'ul', items, keepTogether: true });
      }
    }
  }

  // Instructions (WPRM / Tasty / Mediavine Create)
  const $instContainer = $card
    .find(
      '.wprm-recipe-instructions-container, .tasty-recipes-instructions, .tasty-recipe-instructions, .mv-create-instructions'
    )
    .first();

  if ($instContainer.length) {
    const instHeading =
      $instContainer.find('.wprm-recipe-instructions-header, h2, h3').first().text().replace(/\s+/g, ' ').trim() ||
      'Instructions';
    blocks.push({ type: 'h3', text: instHeading, keepTogether: true });

    const $groups = $instContainer.find('.wprm-recipe-instruction-group, .mv-create-instructions-group');
    const processInstructionScope = ($scope: ReturnType<cheerio.CheerioAPI>) => {
      const items: string[] = [];
      const stepImgs: Array<{ url: string; alt: string; estimatedSize: number }> = [];
      $scope.find('li').each((_, li) => {
        const $li = $(li);
        $li.find('img').each((__, imgEl) => {
          const resolved = resolveContentImage($, $(imgEl), pageUrl, recipeTitle || fallbackTitle);
          if (resolved) stepImgs.push(resolved);
        });
        const $textEl = $li.find('.wprm-recipe-instruction-text').first();
        const stepTxt = extractSpacedText($, $textEl.length ? $textEl : $li);
        if (stepTxt) items.push(stepTxt);
      });
      if (items.length === 0) {
        $scope.find('p').each((_, pEl) => {
          const stepTxt = extractSpacedText($, $(pEl));
          if (stepTxt) items.push(stepTxt);
        });
      }
      if (items.length > 0) {
        blocks.push({ type: 'ol', items, keepTogether: true });
      }
      for (const img of stepImgs) {
        onImage(img);
        blocks.push({ type: 'img', imageUrl: img.url, alt: img.alt });
      }
    };

    if ($groups.length > 0) {
      $groups.each((_, grp) => {
        const $grp = $(grp);
        const grpTitle = $grp.find('.wprm-recipe-group-name, h4').first().text().replace(/\s+/g, ' ').trim();
        if (grpTitle) {
          blocks.push({ type: 'h3', text: grpTitle, keepTogether: true });
        }
        processInstructionScope($grp);
      });
    } else {
      processInstructionScope($instContainer);
    }
  }

  // Notes (optional)
  const $notes = $card.find('.wprm-recipe-notes-container, .tasty-recipes-notes, .mv-create-notes').first();
  if ($notes.length) {
    const notesHeading = $notes.find('h2, h3, h4').first().text().replace(/\s+/g, ' ').trim();
    const notesBody = $notes.find('.wprm-recipe-notes, p').map((_, p) => $(p).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean);
    if (notesBody.length > 0) {
      if (notesHeading) blocks.push({ type: 'h3', text: notesHeading });
      for (const line of notesBody) {
        blocks.push({ type: 'p', text: line });
      }
    }
  }

  return blocks;
}

function getCurrentPageNumber(parsed: URL, fallbackPageNum: number): number {
  const qPage = parsed.searchParams.get('page') || parsed.searchParams.get('paged');
  if (qPage && /^\d+$/.test(qPage)) {
    return parseInt(qPage, 10);
  }
  const pathMatch = parsed.pathname.match(/\/(\d+)\/?$/);
  if (pathMatch) {
    return parseInt(pathMatch[1], 10);
  }
  return fallbackPageNum;
}

function normalizeBasePath(pathname: string): string {
  return pathname.replace(/\/\d+\/?$/, '').replace(/\/+$/, '');
}

function findNextPageUrl(
  $: cheerio.CheerioAPI,
  pageUrl: string,
  currentPageNum: number
): string | null {
  let currentParsed: URL;
  try {
    currentParsed = new URL(pageUrl);
  } catch {
    return null;
  }
  const origin = currentParsed.origin;
  const nextNum = currentPageNum + 1;
  const basePath = normalizeBasePath(currentParsed.pathname);

  const isValidNextCandidate = (href: string | undefined): string | null => {
    if (!href) return null;
    const trimmed = href.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('javascript:')) return null;
    try {
      const candidate = new URL(trimmed, pageUrl);
      if (candidate.origin !== origin) return null;
      candidate.hash = '';
      if (candidate.toString() === currentParsed.toString()) return null;
      return candidate.toString();
    } catch {
      return null;
    }
  };

  // 1. Standard rel="next"
  const relNext = isValidNextCandidate(
    $('link[rel="next"]').attr('href') || $('a[rel="next"]').attr('href')
  );
  if (relNext) return relNext;

  // 2. Explicit next-page links inside pagination containers or next classes
  const paginationLinks = $(
    '.page-links a, .post-nav-links a, .pagination a, .nav-links a, .pager a, .page-numbers a, nav[aria-label*="page" i] a, a.next, a.next-page, a[class*="next"]'
  ).toArray();

  for (const el of paginationLinks) {
    const $el = $(el);
    const candidate = isValidNextCandidate($el.attr('href'));
    if (!candidate) continue;

    const rawText = $el.text().replace(/\s+/g, ' ').trim().toLowerCase();
    const cleanText = rawText.replace(/[›»→>]+/g, '').trim();
    const aria = ($el.attr('aria-label') || $el.attr('title') || '').toLowerCase();
    const cls = ($el.attr('class') || '').toLowerCase();

    const matchesNextLabel =
      cleanText === 'next' ||
      cleanText === 'next page' ||
      cleanText === 'další' ||
      cleanText === 'další strana' ||
      cleanText === 'pokračovat' ||
      cleanText === 'weiter' ||
      cleanText === 'suivant' ||
      cleanText === 'siguiente' ||
      rawText === '→' ||
      rawText === '»' ||
      rawText === '›' ||
      rawText === String(nextNum) ||
      cleanText === `page ${nextNum}` ||
      cleanText === `strana ${nextNum}` ||
      /\bnext\b|next-page|next_page/.test(cls) ||
      /\b(next|další|weiter|suivant|siguiente)\b/.test(aria);

    if (matchesNextLabel) {
      return candidate;
    }
  }

  // 3. URL pattern match (?page=N+1, ?paged=N+1, or /base-slug/N+1/) anywhere in main/article/pagination
  const allAnchors = $('article a, main a, .entry-content a, .post-content a, .page-links a, .pagination a').toArray();
  for (const el of allAnchors) {
    const href = $(el).attr('href');
    const candidate = isValidNextCandidate(href);
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      const qPage = parsed.searchParams.get('page') || parsed.searchParams.get('paged');
      if (qPage === String(nextNum) && normalizeBasePath(parsed.pathname) === basePath) {
        return candidate;
      }
      const candBase = normalizeBasePath(parsed.pathname);
      const candMatch = parsed.pathname.match(/\/(\d+)\/?$/);
      if (candMatch && candMatch[1] === String(nextNum) && candBase === basePath) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function selectMainContentContainer($: cheerio.CheerioAPI): ReturnType<cheerio.CheerioAPI> {
  const candidateSelectors = [
    '[itemprop="articleBody"]',
    '.entry-content',
    '.post-content',
    '.article-content',
    '.article-body',
    '.story-body',
    'article',
    'main article',
    'main',
  ];

  let bestEl: ReturnType<cheerio.CheerioAPI> | null = null;
  let bestScore = -1;

  for (const sel of candidateSelectors) {
    const $matched = $(sel).first();
    if (!$matched.length) continue;

    const textLen = $matched.text().replace(/\s+/g, ' ').trim().length;
    if (textLen === 0) continue;

    // Give slight preference to dedicated article body containers over broad <main>,
    // unless <article>/<main> captures significantly more content (e.g., recipe card outside .entry-content).
    const blockCount = $matched.find('p, h2, h3, ul, ol').length;
    const isSpecific = sel !== 'main' && sel !== 'article';
    const score = textLen + blockCount * 35 + (isSpecific ? 150 : 0);

    if (score > bestScore) {
      bestScore = score;
      bestEl = $matched;
    }
  }

  if (bestEl && bestEl.text().replace(/\s+/g, ' ').trim().length > 40) {
    return bestEl;
  }
  return $('body').first();
}

function extractPageData(html: string, pageUrl: string, currentPageNum: number): {
  title: string;
  description: string;
  paragraphs: string[];
  structuredBlocks: ArticleBlock[];
  hasRecipeData: boolean;
  images: ScrapedImage[];
  nextPageUrl: string | null;
} {
  const $ = cheerio.load(html);

  const ogTitle = $('meta[property="og:title"]').attr('content')?.trim() ?? '';
  const h1Title = $('h1').first().text().trim();
  const docTitle = $('title').text().trim();
  const title = ogTitle || h1Title || docTitle || 'Untitled Article';

  const rawDescription =
    $('meta[property="og:description"]').attr('content')?.trim() ||
    $('meta[name="description"]').attr('content')?.trim() ||
    '';
  const cleanedDescription = stripSourceUrlsFromText(rawDescription, pageUrl);
  const description =
    isPaginationText(cleanedDescription) || isSourceAttributionText(cleanedDescription)
      ? ''
      : cleanedDescription;

  const structuredRecipe = extractStructuredRecipe($);

  const images: ScrapedImage[] = [];
  const imageIndexByUrl = new Map<string, number>();

  const pushImage = (
    rawUrl: string | undefined | null,
    alt: string,
    sourceOrigin: ScrapedImage['sourceOrigin'],
    estimatedSize = 0,
    caption?: string
  ) => {
    if (!rawUrl) return;
    try {
      const resolved = new URL(rawUrl.trim(), pageUrl).toString();
      const upgraded = upgradeToHighResUrl(resolved);
      if (!isLikelyUsefulImage(upgraded, alt)) return;

      const existingIdx = imageIndexByUrl.get(upgraded);
      if (existingIdx !== undefined) {
        const prev = images[existingIdx];
        if (estimatedSize > prev.estimatedSize) {
          prev.estimatedSize = estimatedSize;
        }
        if (!prev.caption && caption) {
          prev.caption = caption;
        }
        return;
      }

      imageIndexByUrl.set(upgraded, images.length);
      images.push({
        url: upgraded,
        alt: alt.trim() || title,
        caption,
        sourceOrigin,
        estimatedSize,
        isFeatured: images.length === 0,
      });
    } catch {
      // ignore invalid URLs
    }
  };

  // Priority 1: og:image meta tags
  pushImage($('meta[property="og:image:secure_url"]').attr('content'), title, 'og', 0);
  pushImage($('meta[property="og:image"]').attr('content'), title, 'og', 0);

  // Priority 2: twitter:image meta tags
  pushImage($('meta[name="twitter:image"]').attr('content'), title, 'twitter', 0);
  pushImage($('meta[property="twitter:image"]').attr('content'), title, 'twitter', 0);
  pushImage($('meta[name="twitter:image:src"]').attr('content'), title, 'twitter', 0);

  // Detect next page URL before removing navigation elements
  const nextPageUrl = findNextPageUrl($, pageUrl, currentPageNum);

  removeNoiseSafely($);

  const container = selectMainContentContainer($);
  container.find(PAGINATION_CONTAINER_SELECTOR).remove();
  stripSourceLinksInCheerio($, container, pageUrl);

  const structuredBlocks: ArticleBlock[] = [];
  const seenInlineImages = new Set<string>();
  const extractedRecipeNodes = new Set<unknown>();
  let lastBlockSignature = '';
  let extractedPluginRecipe = false;

  const pushUniqueBlock = (block: ArticleBlock) => {
    let normalizedBlock = block;
    if (block.type === 'source') {
      return;
    }
    if (block.type === 'ul' || block.type === 'ol') {
      const cleanedItems = (block.items ?? [])
        .map((item) => stripSourceUrlsFromText(item, pageUrl))
        .filter((item) => item.length > 0 && !isPaginationText(item) && !isSourceAttributionText(item));
      if (cleanedItems.length === 0) return;
      normalizedBlock = { ...block, items: cleanedItems };
    } else if (block.type !== 'img' && block.text) {
      const cleanedText = stripSourceUrlsFromText(block.text, pageUrl);
      if (!cleanedText || isPaginationText(cleanedText) || isSourceAttributionText(cleanedText)) {
        return;
      }
      normalizedBlock = { ...block, text: cleanedText };
    }

    const sig =
      normalizedBlock.type === 'ul' || normalizedBlock.type === 'ol'
        ? `${normalizedBlock.type}:${(normalizedBlock.items ?? []).join('|')}`
        : normalizedBlock.type === 'img'
        ? `img:${normalizedBlock.imageUrl ?? ''}`
        : `${normalizedBlock.type}:${normalizedBlock.text ?? ''}`;

    if (sig === lastBlockSignature) return;
    lastBlockSignature = sig;
    structuredBlocks.push(normalizedBlock);
  };

  const pushInlineImageBlock = (
    resolved: { url: string; alt: string; estimatedSize: number },
    caption?: string,
    skipBlockEmit = false
  ) => {
    pushImage(resolved.url, resolved.alt, 'content', resolved.estimatedSize, caption);
    if (!skipBlockEmit && !seenInlineImages.has(resolved.url)) {
      seenInlineImages.add(resolved.url);
      pushUniqueBlock({
        type: 'img',
        imageUrl: resolved.url,
        alt: resolved.alt,
        caption,
      });
    }
  };

  const walkElement = ($el: ReturnType<cheerio.CheerioAPI>) => {
    const rawNode = $el.get(0);
    if (!rawNode) return;
    const tag = String($el.prop('tagName') ?? '').toLowerCase();
    if (!tag) return;

    if (
      tag === 'script' ||
      tag === 'style' ||
      tag === 'noscript' ||
      tag === 'iframe' ||
      tag === 'svg' ||
      tag === 'button' ||
      tag === 'nav' ||
      tag === 'footer' ||
      tag === 'aside' ||
      tag === 'form'
    ) {
      return;
    }

    // Dedicated recipe plugin card extraction (WPRM, Tasty, Mediavine Create)
    if ($el.is(RECIPE_PLUGIN_CARD_SELECTOR)) {
      if (extractedRecipeNodes.has(rawNode)) return;
      extractedRecipeNodes.add(rawNode);
      const recipeBlocks = extractRecipePluginBlocks($, $el, pageUrl, title, (resolved, cap) => {
        pushImage(resolved.url, resolved.alt, 'content', resolved.estimatedSize, cap);
        seenInlineImages.add(resolved.url);
      });
      if (recipeBlocks.length > 0) {
        extractedPluginRecipe = true;
        for (const rb of recipeBlocks) {
          pushUniqueBlock(rb);
        }
        return;
      }
    }

    if (tag === 'h1') {
      const text = $el.text().replace(/\s+/g, ' ').trim();
      if (!text || text.length < 2) return;
      if (text.toLowerCase() === title.trim().toLowerCase()) return;
      pushUniqueBlock({ type: 'h2', text });
      return;
    }

    if (tag === 'h2') {
      const text = $el.text().replace(/\s+/g, ' ').trim();
      if (text.length >= 2) {
        pushUniqueBlock({ type: 'h2', text });
      }
      return;
    }

    if (tag === 'h3' || tag === 'h4') {
      const text = $el.text().replace(/\s+/g, ' ').trim();
      if (text.length >= 2) {
        pushUniqueBlock({ type: 'h3', text });
      }
      return;
    }

    if (tag === 'ul' || tag === 'ol') {
      const listType = tag;
      const directLis = $el.children('li').toArray();
      const liNodes = directLis.length > 0 ? directLis : $el.find('li').toArray();
      const items: string[] = [];
      const stepImages: Array<{ url: string; alt: string; estimatedSize: number }> = [];

      for (const li of liNodes) {
        const $li = $(li);
        $li.find('img').each((_, imgEl) => {
          const resolved = resolveContentImage($, $(imgEl), pageUrl, title);
          if (resolved) stepImages.push(resolved);
        });
        const itemText = extractSpacedText($, $li);
        if (itemText) items.push(itemText);
      }

      if (items.length > 0) {
        pushUniqueBlock({ type: listType, items });
      }
      for (const img of stepImages) {
        pushInlineImageBlock(img);
      }
      return;
    }

    if (tag === 'figure') {
      const caption = $el.find('figcaption').first().text().replace(/\s+/g, ' ').trim() || undefined;
      $el.find('img').each((_, imgEl) => {
        const resolved = resolveContentImage($, $(imgEl), pageUrl, title);
        if (resolved) {
          pushInlineImageBlock(resolved, caption);
        }
      });
      return;
    }

    if (tag === 'img') {
      const resolved = resolveContentImage($, $el, pageUrl, title);
      if (resolved) {
        pushInlineImageBlock(resolved);
      }
      return;
    }

    if (tag === 'p' || tag === 'blockquote') {
      $el.find('img').each((_, imgEl) => {
        const resolved = resolveContentImage($, $(imgEl), pageUrl, title);
        if (resolved) {
          pushInlineImageBlock(resolved);
        }
      });
      const text = $el.text().replace(/\s+/g, ' ').trim();
      if (text.length >= 2) {
        pushUniqueBlock({ type: 'p', text });
      }
      return;
    }

    const hasBlockChildren =
      $el.find('h1, h2, h3, h4, p, ul, ol, figure, img, blockquote, div, section, article').length > 0;

    if (hasBlockChildren) {
      $el.children().each((_, child) => {
        walkElement($(child));
      });
      return;
    }

    const text = $el.text().replace(/\s+/g, ' ').trim();
    if (text.length >= 12) {
      pushUniqueBlock({ type: 'p', text });
    }
  };

  container.children().each((_, child) => {
    walkElement($(child));
  });

  // Also check if a recipe plugin card exists outside the selected container (e.g. rendered after .entry-content)
  $(RECIPE_PLUGIN_CARD_SELECTOR).each((_, cardEl) => {
    if (extractedRecipeNodes.has(cardEl)) return;
    // Skip nested .wprm-recipe inside .wprm-recipe-container
    const $card = $(cardEl);
    if ($card.parents(RECIPE_PLUGIN_CARD_SELECTOR).toArray().some((p) => extractedRecipeNodes.has(p))) {
      return;
    }
    extractedRecipeNodes.add(cardEl);
    const recipeBlocks = extractRecipePluginBlocks($, $card, pageUrl, title, (resolved, cap) => {
      pushImage(resolved.url, resolved.alt, 'content', resolved.estimatedSize, cap);
      seenInlineImages.add(resolved.url);
    });
    if (recipeBlocks.length > 0) {
      extractedPluginRecipe = true;
      for (const rb of recipeBlocks) {
        pushUniqueBlock(rb);
      }
    }
  });

  // Also scan any remaining useful content images not captured by child walk
  container.find('img').each((_, el) => {
    const resolved = resolveContentImage($, $(el), pageUrl, title);
    if (resolved) {
      pushImage(resolved.url, resolved.alt, 'content', resolved.estimatedSize);
    }
  });

  const paragraphs: string[] = [];
  if (structuredRecipe) {
    paragraphs.push(structuredRecipe.textSummary);
  }
  const seenParagraphs = new Set<string>();

  container.find('h1, h2, h3, h4, p, li, blockquote').each((_, el) => {
    const $el = $(el);
    if ($el.closest(PAGINATION_CONTAINER_SELECTOR).length > 0) return;
    const tag = el.tagName?.toLowerCase() ?? 'p';
    const rawText = $el.text().replace(/\s+/g, ' ').trim();
    const text = stripSourceUrlsFromText(rawText, pageUrl);
    if (text.length < 10 && !tag.startsWith('h') && tag !== 'li') return;
    if (text.length < 3) return;
    if (isPaginationText(text) || isSourceAttributionText(text)) return;
    if (!seenParagraphs.has(text)) {
      seenParagraphs.add(text);
      paragraphs.push(tag.startsWith('h') ? `[${tag.toUpperCase()}] ${text}` : text);
    }
  });

  if (paragraphs.length === 0) {
    const fallbackText = stripSourceUrlsFromText(container.text().replace(/\s+/g, ' ').trim(), pageUrl);
    if (fallbackText.length > 20 && !isPaginationText(fallbackText) && !isSourceAttributionText(fallbackText)) {
      paragraphs.push(fallbackText);
    }
  }

  if (structuredBlocks.filter((b) => b.type !== 'img').length === 0 && paragraphs.length > 0) {
    for (const p of paragraphs) {
      if (p.startsWith('[STRUCTURED RECIPE DATA')) continue;
      if (p.startsWith('[H2] ')) {
        structuredBlocks.push({ type: 'h2', text: p.slice(5).trim() });
      } else if (p.startsWith('[H3] ') || p.startsWith('[H4] ')) {
        structuredBlocks.push({ type: 'h3', text: p.slice(5).trim() });
      } else if (!p.startsWith('[H1] ')) {
        structuredBlocks.push({ type: 'p', text: p });
      }
    }
  }

  const detectedHtmlRecipe = markRecipeKeepTogether(structuredBlocks);

  // Fallback: if JSON-LD recipe exists on page 1 and no HTML recipe card was extracted, append JSON-LD recipe blocks
  if (!extractedPluginRecipe && !detectedHtmlRecipe && structuredRecipe && structuredRecipe.blocks.length > 0) {
    for (const rb of structuredRecipe.blocks) {
      structuredBlocks.push(rb);
    }
  }

  const hasRecipeData = Boolean(structuredRecipe) || extractedPluginRecipe || detectedHtmlRecipe;

  return {
    title,
    description,
    paragraphs,
    structuredBlocks,
    hasRecipeData,
    images,
    nextPageUrl,
  };
}

function countWordsInBlocks(blocks: ArticleBlock[]): number {
  let words = 0;
  for (const b of blocks) {
    if (b.type === 'img' || b.type === 'source') continue;
    const text = b.type === 'ul' || b.type === 'ol' ? (b.items ?? []).join(' ') : b.text ?? '';
    const trimmed = text.trim();
    if (trimmed) {
      words += trimmed.split(/\s+/).filter(Boolean).length;
    }
  }
  return words;
}

export async function scrapeArticle(inputUrl: string): Promise<ScrapedArticle> {
  const decoded = decodeSourceUrl(inputUrl);
  const visited = new Set<string>();
  const allParagraphs: string[] = [];
  const allStructuredBlocks: ArticleBlock[] = [];
  const allImages: ScrapedImage[] = [];
  const imageIndexByUrl = new Map<string, number>();

  let currentUrl: string | null = decoded.resolvedUrl;
  let mainTitle = '';
  let mainDescription = '';
  let hasRecipeData = false;
  let pagesFetched = 0;

  while (currentUrl && pagesFetched < 15 && !visited.has(currentUrl)) {
    visited.add(currentUrl);
    const { response, finalUrl } = await safeFetch(currentUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,cs;q=0.8',
      },
      timeoutMs: 20000,
    });

    if (!response.ok) {
      if (pagesFetched === 0) {
        throw new Error(`Could not fetch the article (website returned HTTP ${response.status}).`);
      }
      break;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      if (pagesFetched === 0) {
        throw new Error('The URL did not return a readable HTML article page.');
      }
      break;
    }

    const html = await response.text();
    let currentPageNum = pagesFetched + 1;
    try {
      currentPageNum = getCurrentPageNumber(new URL(finalUrl), pagesFetched + 1);
    } catch {
      // keep sequential fallback
    }

    const extracted = extractPageData(html, finalUrl, currentPageNum);

    if (pagesFetched === 0) {
      mainTitle = extracted.title;
      mainDescription = extracted.description;
    }

    if (extracted.hasRecipeData) {
      hasRecipeData = true;
    }

    for (const p of extracted.paragraphs) {
      if (!allParagraphs.includes(p)) {
        allParagraphs.push(p);
      }
    }

    for (const block of extracted.structuredBlocks) {
      allStructuredBlocks.push(block);
    }

    for (const img of extracted.images) {
      const existingIdx = imageIndexByUrl.get(img.url);
      if (existingIdx !== undefined) {
        const existing = allImages[existingIdx];
        if (img.estimatedSize > existing.estimatedSize) {
          existing.estimatedSize = img.estimatedSize;
        }
        if (img.sourceOrigin === 'og') {
          existing.sourceOrigin = 'og';
        }
        continue;
      }
      if (allImages.length < 50) {
        imageIndexByUrl.set(img.url, allImages.length);
        allImages.push({ ...img, isFeatured: false });
      }
    }

    pagesFetched += 1;
    currentUrl = extracted.nextPageUrl && !visited.has(extracted.nextPageUrl)
      ? extracted.nextPageUrl
      : null;
  }

  // Pick featured image: og:image first, otherwise the biggest image by estimatedSize (or first available)
  if (allImages.length > 0) {
    let featuredIdx = allImages.findIndex((img) => img.sourceOrigin === 'og');
    if (featuredIdx === -1) {
      let maxScore = -1;
      allImages.forEach((img, idx) => {
        if (img.estimatedSize > maxScore) {
          maxScore = img.estimatedSize;
          featuredIdx = idx;
        }
      });
      if (featuredIdx === -1) featuredIdx = 0;
    }
    allImages.forEach((img, idx) => {
      img.isFeatured = idx === featuredIdx;
    });
  }

  const textContent = allParagraphs.join('\n\n').trim();
  const blockWords = countWordsInBlocks(allStructuredBlocks);
  const textWords = textContent ? textContent.split(/\s+/).filter(Boolean).length : 0;
  const wordCount = blockWords > 0 ? blockWords : textWords;

  if (textContent.length < 20 && wordCount === 0) {
    throw new Error(
      'Unable to extract readable article text from that URL. The site may block automated reading or require JavaScript rendering.'
    );
  }

  return {
    originalUrl: decoded.originalUrl,
    resolvedUrl: decoded.resolvedUrl,
    wasFacebookRedirect: decoded.wasFacebookRedirect,
    title: mainTitle,
    description: mainDescription,
    textContent: textContent.slice(0, 28000),
    wordCount,
    extractionIncomplete: wordCount < 200,
    structuredBlocks: allStructuredBlocks,
    hasRecipeData,
    pagesFetched,
    images: allImages,
  };
}
