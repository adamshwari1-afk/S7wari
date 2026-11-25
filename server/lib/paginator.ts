import type { ArticleBlock, ArticleImage, ArticlePage } from '../types.ts';

export function stripHtml(html: string): string {
  return html
    .replace(/<!--nextpage-->/gi, ' ')
    .replace(/<figure[\s\S]*?<\/figure>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function countWords(text: string): number {
  const clean = stripHtml(text);
  if (!clean) return 0;
  return clean.split(/\s+/).filter(Boolean).length;
}

export function blockWordCount(block: ArticleBlock): number {
  if (block.type === 'img' || block.type === 'source') {
    return 0;
  }
  if (block.type === 'ul' || block.type === 'ol') {
    return countWords((block.items ?? []).join(' '));
  }
  return countWords(block.text ?? '');
}

export function blocksWordCount(blocks: ArticleBlock[]): number {
  return blocks.reduce((sum, b) => sum + blockWordCount(b), 0);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isSafeImageSrc(url: string): boolean {
  if (/^data:image\/(jpeg|jpg|png|webp|gif|avif);base64,/i.test(url)) {
    return true;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function buildFigureHtml(img: ArticleImage, extraClass = ''): string {
  const src = img.wpSourceUrl || img.sourceUrl;
  if (!isSafeImageSrc(src)) return '';
  const cls = ['wp-block-image', extraClass].filter(Boolean).join(' ');
  return `<figure class="${cls}"><img src="${escapeHtml(src)}" alt="${escapeHtml(img.alt)}" />${
    img.caption ? `<figcaption>${escapeHtml(img.caption)}</figcaption>` : ''
  }</figure>`;
}

export function renderBlocksToHtml(
  blocks: ArticleBlock[],
  hook?: string,
  imagesForPage: ArticleImage[] = [],
  isFirstPage = false,
  options?: { preserveInlineOrder?: boolean }
): string {
  const parts: string[] = [];
  const preserveInlineOrder = Boolean(options?.preserveInlineOrder);

  if (hook && hook.trim()) {
    parts.push(`<p class="s7-page-hook"><em>${escapeHtml(hook.trim())}</em></p>`);
  }

  const featuredImg =
    !preserveInlineOrder && isFirstPage
      ? imagesForPage.find((img) => img.isFeatured) ?? imagesForPage[0]
      : undefined;

  if (featuredImg) {
    const figHtml = buildFigureHtml(featuredImg, 's7-featured-image');
    if (figHtml) parts.push(figHtml);
  }

  const remainingImages = preserveInlineOrder
    ? []
    : featuredImg
    ? imagesForPage.filter((img) => img.id !== featuredImg.id)
    : imagesForPage;

  let insertedInlineImage = false;
  blocks.forEach((block, index) => {
    if (block.type === 'img' && block.imageUrl) {
      if (isSafeImageSrc(block.imageUrl)) {
        parts.push(
          `<figure class="wp-block-image"><img src="${escapeHtml(block.imageUrl)}" alt="${escapeHtml(
            block.alt ?? ''
          )}" />${block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : ''}</figure>`
        );
      }
    } else if (block.type === 'source') {
      // Source URLs are internal only and must never be included in published post content
    } else if (block.type === 'h2' && block.text) {
      parts.push(`<h2>${escapeHtml(block.text.trim())}</h2>`);
    } else if (block.type === 'h3' && block.text) {
      parts.push(`<h3>${escapeHtml(block.text.trim())}</h3>`);
    } else if ((block.type === 'ul' || block.type === 'ol') && block.items?.length) {
      const tag = block.type;
      const lis = block.items
        .filter((item) => item.trim().length > 0)
        .map((item) => `<li>${escapeHtml(item.trim())}</li>`)
        .join('');
      if (lis) parts.push(`<${tag}>${lis}</${tag}>`);
    } else if (block.text) {
      parts.push(`<p>${escapeHtml(block.text.trim())}</p>`);
    }

    if (!insertedInlineImage && remainingImages.length > 0 && (index === 1 || index === blocks.length - 1)) {
      const figHtml = buildFigureHtml(remainingImages[0]);
      if (figHtml) parts.push(figHtml);
      insertedInlineImage = true;
    }
  });

  if (remainingImages.length > 1) {
    for (let i = 1; i < remainingImages.length; i += 1) {
      const figHtml = buildFigureHtml(remainingImages[i]);
      if (figHtml) parts.push(figHtml);
    }
  }

  return parts.join('\n\n');
}

function isRecipeHeading(block: ArticleBlock): 'ingredients' | 'instructions' | null {
  if (block.type !== 'h2' && block.type !== 'h3') return null;
  const text = (block.text ?? '').toLowerCase();
  if (/(ingredient|surovin|ingredienc|přísad|prisad|zutaten|ingrédient|co budete potřebovat)/i.test(text)) {
    return 'ingredients';
  }
  if (/(instruction|method|direction|postup|příprav|priprav|jak na to|zubereitung|préparation)/i.test(text)) {
    return 'instructions';
  }
  return null;
}

/**
 * Ensures we never place a page break inside a marked recipe card (keepTogether)
 * or between an Ingredients section and its Instructions section.
 */
function isProtectedRecipeBreak(allBlocks: ArticleBlock[], breakIndex: number): boolean {
  if (breakIndex <= 0 || breakIndex >= allBlocks.length) return false;
  const prev = allBlocks[breakIndex - 1];
  const next = allBlocks[breakIndex];

  if (prev.keepTogether && next.keepTogether) {
    return true;
  }

  // Structural fallback: find if breakIndex falls after an Ingredients heading and before the end of Instructions list
  let ingredientsStart = -1;
  let instructionsEnd = -1;
  for (let i = 0; i < allBlocks.length; i += 1) {
    const kind = isRecipeHeading(allBlocks[i]);
    if (kind === 'ingredients' && ingredientsStart === -1) {
      ingredientsStart = i;
    }
    if (kind === 'instructions' && ingredientsStart !== -1) {
      // Find end of instructions list/paragraphs
      let j = i + 1;
      while (j < allBlocks.length && allBlocks[j].type !== 'h2') {
        j += 1;
      }
      instructionsEnd = j;
      break;
    }
  }

  if (ingredientsStart !== -1 && instructionsEnd !== -1) {
    if (breakIndex > ingredientsStart && breakIndex < instructionsEnd) {
      return true;
    }
  }

  return false;
}

/**
 * Splits blocks into balanced pages (~targetWordsPerPage each):
 * - Breaks strictly at block boundaries (never mid-sentence or mid-paragraph).
 * - Never leaves a heading stranded at the end of a page.
 * - Never splits a recipe card (ingredients + instructions stay complete on a single page).
 * - Prefers breaking immediately BEFORE an H2 heading when one is within +/- 95 words of targetWordsPerPage.
 * - Merges the final page into the previous page if it has fewer than minLastPageWords (150).
 */
export function splitBlocksIntoPages(
  intro: string,
  blocks: ArticleBlock[],
  targetWordsPerPage = 300,
  minLastPageWords = 150
): ArticleBlock[][] {
  const allBlocks: ArticleBlock[] = [];
  if (intro.trim()) {
    allBlocks.push({ type: 'p', text: intro.trim() });
  }
  allBlocks.push(...blocks);

  if (allBlocks.length === 0) return [];

  const total = blocksWordCount(allBlocks);
  if (total <= targetWordsPerPage + minLastPageWords) {
    return [allBlocks];
  }

  const pages: ArticleBlock[][] = [];
  let cursor = 0;

  while (cursor < allBlocks.length) {
    const remainingWords = blocksWordCount(allBlocks.slice(cursor));
    if (remainingWords <= targetWordsPerPage + minLastPageWords) {
      pages.push(allBlocks.slice(cursor));
      break;
    }

    let running = 0;
    let bestBreak = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let i = cursor; i < allBlocks.length - 1; i += 1) {
      const currentBlock = allBlocks[i];
      const nextBlock = allBlocks[i + 1];
      running += blockWordCount(currentBlock);

      if (currentBlock.type === 'h2' || currentBlock.type === 'h3') {
        continue;
      }

      if (isProtectedRecipeBreak(allBlocks, i + 1)) {
        continue;
      }

      if (running < Math.max(100, targetWordsPerPage * 0.4)) {
        continue;
      }

      const distance = Math.abs(running - targetWordsPerPage);
      const h2Bonus = nextBlock.type === 'h2' && distance <= 120 ? -85 : 0;
      const h3Bonus = nextBlock.type === 'h3' && distance <= 70 ? -35 : 0;
      const score = distance + h2Bonus + h3Bonus;

      if (score < bestScore) {
        bestScore = score;
        bestBreak = i + 1;
      }

      if (running > targetWordsPerPage + 220 && bestBreak !== -1) {
        break;
      }
    }

    if (bestBreak === -1 || bestBreak <= cursor) {
      let acc = 0;
      let fallbackEnd = cursor + 1;
      while (fallbackEnd < allBlocks.length) {
        acc += blockWordCount(allBlocks[fallbackEnd - 1]);
        const prev = allBlocks[fallbackEnd - 1];
        if (
          acc >= targetWordsPerPage &&
          prev.type !== 'h2' &&
          prev.type !== 'h3' &&
          !isProtectedRecipeBreak(allBlocks, fallbackEnd)
        ) {
          break;
        }
        fallbackEnd += 1;
      }
      bestBreak = Math.min(fallbackEnd, allBlocks.length);
    }

    pages.push(allBlocks.slice(cursor, bestBreak));
    cursor = bestBreak;
  }

  if (pages.length >= 2) {
    const lastPageWords = blocksWordCount(pages[pages.length - 1]);
    if (lastPageWords < minLastPageWords) {
      const last = pages.pop()!;
      pages[pages.length - 1].push(...last);
    }
  }

  return pages;
}

export function distributeImagesAcrossPages(
  pageCount: number,
  images: ArticleImage[]
): ArticleImage[] {
  if (pageCount <= 0) return images;

  const included = images.filter((img) => img.included);
  if (included.length === 0) return images;

  const featured = included.find((img) => img.isFeatured) ?? included[0];
  let extraIdx = 0;

  return images.map((img) => {
    if (!img.included) return img;
    if (img.id === featured.id) {
      return { ...img, isFeatured: true, assignedPage: 1 };
    }
    const assignedPage = pageCount > 1 ? ((extraIdx % (pageCount - 1)) + 2) : 1;
    extraIdx += 1;
    return { ...img, isFeatured: false, assignedPage };
  });
}

export function buildArticlePages(
  pageBlocksList: ArticleBlock[][],
  hooks: string[],
  images: ArticleImage[],
  options?: { preserveInlineOrder?: boolean }
): ArticlePage[] {
  return pageBlocksList.map((pageBlocks, idx) => {
    const pageNumber = idx + 1;
    const hook = hooks[idx] ?? '';
    const pageImages = images.filter((img) => img.included && img.assignedPage === pageNumber);
    const html = renderBlocksToHtml(pageBlocks, hook, pageImages, pageNumber === 1, options);
    const plainText = stripHtml(html);
    return {
      pageNumber,
      hook,
      html,
      plainText,
      wordCount: countWords(html),
    };
  });
}

export function assembleWordPressContent(pages: ArticlePage[]): string {
  return pages.map((p) => p.html.trim()).join('\n\n<!--nextpage-->\n\n');
}
