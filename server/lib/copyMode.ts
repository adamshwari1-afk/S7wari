import type { ArticleBlock, FacebookPackage, SeoMetadata } from '../types.ts';

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'always', 'among', 'another', 'around', 'because', 'before',
  'being', 'below', 'between', 'both', 'could', 'doing', 'during', 'each', 'every', 'from',
  'further', 'have', 'having', 'here', 'hers', 'herself', 'himself', 'into', 'just', 'make',
  'more', 'most', 'much', 'must', 'neither', 'never', 'only', 'other', 'ours', 'ourselves',
  'over', 'same', 'should', 'some', 'such', 'than', 'that', 'their', 'theirs', 'them',
  'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'until',
  'very', 'what', 'when', 'where', 'which', 'while', 'whom', 'with', 'would', 'your', 'yours',
  'yourself', 'nebo', 'jako', 'jsou', 'jsem', 'jsme', 'jste', 'ktery', 'ktera', 'ktere',
  'kterou', 'kterych', 'tento', 'tato', 'toto', 'tohle', 'jeho', 'jeji', 'jejich', 'pred',
  'pres', 'proti', 'podle', 'mezi', 'bude', 'budou', 'bylo', 'byla', 'byli', 'byl', 'aby',
  'takze', 'proto', 'kdyz', 'pokud', 'velmi', 'vice', 'jaky', 'jaka', 'jake', 'recept',
  'recepty', 'clanku', 'clanek',
]);

function toAscii(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function buildSlugFromTitle(title: string): string {
  const ascii = toAscii(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/g, '');
  return ascii || `article-${Date.now()}`;
}

function truncateAtWord(text: string, maxLen: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  const sliced = clean.slice(0, maxLen - 1);
  const lastSpace = sliced.lastIndexOf(' ');
  const cut = lastSpace > Math.floor(maxLen * 0.55) ? sliced.slice(0, lastSpace) : sliced;
  return `${cut.replace(/[.,;:!?-]+$/, '').trim()}…`;
}

function isCzechOrSlovak(language: string): boolean {
  return /(czech|česk|slovak|sloven)/i.test(language);
}

function extractTagsFromTitle(title: string, category: string): string[] {
  const words = title
    .split(/[^a-zA-Z0-9\u00C0-\u024F]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4);

  const tags: string[] = [];
  const seen = new Set<string>();

  for (const w of words) {
    const norm = toAscii(w).toLowerCase();
    if (STOP_WORDS.has(norm) || seen.has(norm)) continue;
    seen.add(norm);
    tags.push(w.charAt(0).toUpperCase() + w.slice(1));
    if (tags.length >= 5) break;
  }

  const catNorm = toAscii(category).toLowerCase();
  if (tags.length < 3 && !seen.has(catNorm)) {
    tags.push(category);
  }

  return tags;
}

export function buildCopyModeSeo(params: {
  title: string;
  description: string;
  blocks: ArticleBlock[];
  language: string;
  hasRecipeData: boolean;
}): SeoMetadata {
  const cleanTitle = params.title.replace(/\s+/g, ' ').trim() || 'Untitled Article';
  const firstParagraph =
    params.blocks.find((b) => b.type === 'p' && b.text && b.text.trim().length >= 25)?.text?.trim() ||
    params.description.trim() ||
    cleanTitle;

  const metaTitle = truncateAtWord(cleanTitle, 60);
  const rawDescription =
    firstParagraph.toLowerCase() === cleanTitle.toLowerCase()
      ? cleanTitle
      : firstParagraph.length >= 50
      ? firstParagraph
      : `${cleanTitle} — ${firstParagraph}`;
  const metaDescription = truncateAtWord(rawDescription, 155);

  const cs = isCzechOrSlovak(params.language);
  const category = params.hasRecipeData
    ? cs
      ? 'Recepty'
      : 'Recipes'
    : cs
    ? 'Články'
    : 'Articles';

  const tags = extractTagsFromTitle(cleanTitle, category);

  return {
    metaTitle,
    metaDescription,
    slug: buildSlugFromTitle(cleanTitle),
    category,
    tags,
  };
}

function toHashtagToken(label: string): string {
  const cleaned = toAscii(label)
    .replace(/[^a-zA-Z0-9]+/g, '')
    .trim();
  return cleaned ? `#${cleaned}` : '';
}

export function buildCopyModeFacebookPackage(params: {
  title: string;
  category: string;
  hasRecipeData: boolean;
  language: string;
  postUrl: string;
}): FacebookPackage {
  const cs = isCzechOrSlovak(params.language);
  const genericPool = params.hasRecipeData
    ? cs
      ? ['#Recepty', '#Vareni', '#DomaciKuchyne', '#Inspirace']
      : ['#Recipes', '#Cooking', '#Homemade', '#FoodInspiration']
    : cs
    ? ['#Clanek', '#Cteni', '#Inspirace', '#Novinky']
    : ['#Article', '#Reading', '#MustRead', '#Inspiration'];

  const categoryTag = toHashtagToken(params.category);
  const hashtags: string[] = [];
  const seen = new Set<string>();

  for (const tag of [categoryTag, ...genericPool]) {
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hashtags.push(tag);
    if (hashtags.length >= 4) break;
  }

  return {
    caption: params.title.replace(/\s+/g, ' ').trim(),
    hashtags,
    postUrl: params.postUrl,
  };
}
