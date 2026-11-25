import { GoogleGenAI, Type, type GenerateContentParameters, type GenerateContentResponse } from '@google/genai';
import type { ArticleBlock, FacebookPackage, SeoMetadata } from '../types.ts';
import { blocksWordCount, countWords } from './paginator.ts';

export const PRIMARY_MODEL = 'gemini-2.5-flash';
export const FALLBACK_MODELS = ['gemini-3.5-flash-lite'] as const;
const MODEL_FALLBACK_CHAIN = [PRIMARY_MODEL, ...FALLBACK_MODELS] as const;

const RETRY_DELAYS_MS = [3000, 6000, 12000, 24000, 48000] as const;
const AI_CALL_TIMEOUT_MS = 90000;

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server. Set it in your .env file or hosting environment variables.');
  }
  return new GoogleGenAI({ apiKey });
}

export function isAiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractErrorInfo(err: unknown): { status?: number; code?: string; message: string } {
  if (err && typeof err === 'object') {
    const record = err as Record<string, unknown>;
    const status =
      typeof record.status === 'number'
        ? record.status
        : typeof record.statusCode === 'number'
        ? record.statusCode
        : undefined;
    const code = typeof record.code === 'string' ? record.code : undefined;
    const message =
      typeof record.message === 'string'
        ? record.message
        : err instanceof Error
        ? err.message
        : String(err);
    return { status, code, message };
  }
  return { message: String(err) };
}

function isNonRetryableAuthError(err: unknown): boolean {
  const { status, message } = extractErrorInfo(err);
  const upper = message.toUpperCase();
  if (status === 401 || status === 403) {
    return upper.includes('API_KEY_INVALID') || upper.includes('PERMISSION_DENIED') || upper.includes('UNAUTHENTICATED');
  }
  return upper.includes('API_KEY_INVALID') || upper.includes('GEMINI_API_KEY IS NOT CONFIGURED');
}

function isModelUnavailableError(err: unknown): boolean {
  const { status, message } = extractErrorInfo(err);
  const upper = message.toUpperCase();
  return status === 404 || upper.includes('404') || upper.includes('NOT_FOUND') || upper.includes('MODEL_NOT_FOUND');
}

function isRetryableBackoffError(err: unknown): boolean {
  if (isNonRetryableAuthError(err) || isModelUnavailableError(err)) return false;
  const { status, message } = extractErrorInfo(err);
  if (status === 503 || status === 429 || status === 500) return true;
  const upper = message.toUpperCase();
  return (
    upper.includes('503') ||
    upper.includes('429') ||
    upper.includes('500') ||
    upper.includes('UNAVAILABLE') ||
    upper.includes('RESOURCE_EXHAUSTED') ||
    upper.includes('"STATUS":"INTERNAL"') ||
    upper.includes('INTERNAL ERROR')
  );
}

async function callWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`AI request timed out after ${Math.round(timeoutMs / 1000)}s.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function generateWithRetry(
  ai: GoogleGenAI,
  request: Omit<GenerateContentParameters, 'model'>,
  options?: {
    onStatusUpdate?: (detail: string) => void;
    retryDelaysMs?: readonly number[];
  }
): Promise<{ response: GenerateContentResponse; modelUsed: string }> {
  const delays = options?.retryDelaysMs ?? RETRY_DELAYS_MS;
  let lastError: unknown = null;

  for (let modelIdx = 0; modelIdx < MODEL_FALLBACK_CHAIN.length; modelIdx += 1) {
    const model = MODEL_FALLBACK_CHAIN[modelIdx];
    const isFallback = modelIdx > 0;

    if (isFallback) {
      const reason = lastError && isModelUnavailableError(lastError) ? 'unavailable (404)' : 'busy';
      options?.onStatusUpdate?.(`Previous AI model is ${reason}. Switching to fallback model (${model})...`);
    }

    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      try {
        const response = await callWithTimeout(
          ai.models.generateContent({
            ...request,
            model,
          }),
          AI_CALL_TIMEOUT_MS
        );

        if (!response.text || !response.text.trim()) {
          throw new Error('AI returned an empty response.');
        }

        return { response, modelUsed: model };
      } catch (err) {
        lastError = err;

        if (isNonRetryableAuthError(err)) {
          throw err;
        }

        if (isModelUnavailableError(err)) {
          // 404 NOT_FOUND: skip immediately to next model without waiting or retrying
          break;
        }

        const hasNextRetry = attempt < delays.length;
        if (isRetryableBackoffError(err) && hasNextRetry) {
          const waitMs = delays[attempt];
          const retryNumber = attempt + 1;
          const totalRetries = delays.length;
          const modelNote = isFallback ? ` on ${model}` : '';
          options?.onStatusUpdate?.(
            `AI is busy${modelNote}, retrying (${retryNumber}/${totalRetries}) in ${Math.round(waitMs / 1000)}s...`
          );
          await sleep(waitMs);
          continue;
        }

        // Non-503/429/500 error or exhausted retries: move to next fallback model if available
        break;
      }
    }
  }

  const finalInfo = extractErrorInfo(lastError);
  throw new Error(
    `AI service remained unavailable after retries and fallback models (${finalInfo.message}). Please try again shortly.`
  );
}

interface GeneratedArticleDraft {
  title: string;
  intro: string;
  hasRecipeData: boolean;
  recipeNotice: string;
  blocks: ArticleBlock[];
  seo: SeoMetadata;
  facebook: Omit<FacebookPackage, 'postUrl'>;
}

const ARTICLE_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: 'Catchy, engaging editorial headline in the target language.' },
    intro: {
      type: Type.STRING,
      description: 'Short, compelling 60-100 word opening introduction in natural target-language prose.',
    },
    hasRecipeData: {
      type: Type.BOOLEAN,
      description:
        'True ONLY if the source actually contains concrete recipe data (ingredients and preparation steps). False if no recipe data exists in the source.',
    },
    recipeNotice: {
      type: Type.STRING,
      description:
        'Empty string when hasRecipeData is true. When hasRecipeData is false, a clear note stating that the source article contains no recipe data so no recipe was invented.',
    },
    blocks: {
      type: Type.ARRAY,
      description:
        'Ordered body content blocks: h2 headings, h3 subheadings, short paragraphs (p), bullet lists (ul), and numbered lists (ol).',
      items: {
        type: Type.OBJECT,
        properties: {
          type: { type: Type.STRING, description: 'One of: h2, h3, p, ul, ol' },
          text: { type: Type.STRING, description: 'Text for h2, h3, or p blocks.' },
          items: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'List strings when type is ul (bullet list) or ol (numbered list).',
          },
          keepTogether: {
            type: Type.BOOLEAN,
            description:
              'True for every block belonging to the core recipe card (prep/cook/servings summary, Ingredients heading & bullet list, Instructions heading & numbered list) so it stays together on a single page.',
          },
        },
        required: ['type'],
      },
    },
    seo: {
      type: Type.OBJECT,
      properties: {
        metaTitle: { type: Type.STRING, description: 'SEO title <= 60 chars in target language.' },
        metaDescription: { type: Type.STRING, description: 'SEO description 135-160 chars in target language.' },
        slug: { type: Type.STRING, description: 'URL-friendly lowercase hyphenated ASCII slug.' },
        category: { type: Type.STRING, description: 'Primary editorial category name in target language.' },
        tags: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: '4 to 6 relevant editorial tags in target language.',
        },
      },
      required: ['metaTitle', 'metaDescription', 'slug', 'category', 'tags'],
    },
    facebook: {
      type: Type.OBJECT,
      properties: {
        caption: {
          type: Type.STRING,
          description: 'High-curiosity Facebook hook caption in the target language (2-4 punchy sentences).',
        },
        hashtags: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: '3 to 5 relevant hashtags starting with #.',
        },
      },
      required: ['caption', 'hashtags'],
    },
  },
  required: ['title', 'intro', 'hasRecipeData', 'recipeNotice', 'blocks', 'seo', 'facebook'],
};

function sanitizeBlocks(rawBlocks: ArticleBlock[]): ArticleBlock[] {
  const cleaned: ArticleBlock[] = [];
  for (const b of rawBlocks) {
    const type =
      b.type === 'h2' || b.type === 'h3' || b.type === 'ul' || b.type === 'ol' ? b.type : 'p';
    const keepTogether = Boolean(b.keepTogether);
    if (type === 'ul' || type === 'ol') {
      const items = (b.items ?? []).map((i) => String(i).trim()).filter(Boolean);
      if (items.length > 0) cleaned.push({ type, items, ...(keepTogether ? { keepTogether: true } : {}) });
    } else {
      const text = (b.text ?? '').trim();
      if (text) cleaned.push({ type, text, ...(keepTogether ? { keepTogether: true } : {}) });
    }
  }
  return cleaned;
}

function draftTotalWords(draft: GeneratedArticleDraft): number {
  return countWords(draft.intro) + blocksWordCount(draft.blocks);
}

export async function generateRewrittenArticle(params: {
  sourceTitle: string;
  sourceText: string;
  targetLanguage: string;
  minWords: number;
  targetWordsPerPage: number;
  editorialTone: 'editorial' | 'engaging' | 'informative';
  onStatusUpdate?: (detail: string) => void;
}): Promise<{
  draft: GeneratedArticleDraft;
  totalWords: number;
  expansionAttempts: number;
}> {
  const ai = getGeminiClient();
  const targetMax = Math.max(params.minWords + 280, 1200);
  const targetMin = Math.max(params.minWords + 100, 1000);

  const toneDescriptions: Record<typeof params.editorialTone, string> = {
    editorial: 'Polished magazine journalism — authoritative, vivid, human, and deeply readable.',
    engaging: 'High-curiosity digital feature style — punchy storytelling, clear takeaways, strong narrative momentum.',
    informative: 'Clear, practical, structured explainer — helpful, precise, reader-first.',
  };

  params.onStatusUpdate?.(`Drafting ${params.minWords}+ words in ${params.targetLanguage}...`);

  const initialPrompt = [
    `Rewrite the source article below into an original, long-form feature written entirely in ${params.targetLanguage}.`,
    `Style: ${toneDescriptions[params.editorialTone]}`,
    '',
    'CRITICAL RECIPE & CONTENT RULES:',
    `1. LENGTH: Write between ${targetMin} and ${targetMax} words across the intro and body blocks (minimum absolute floor: ${params.minWords} words). Never pad with filler or repetition.`,
    `2. NATURAL HUMAN LANGUAGE: Write completely natural, idiomatic, human-sounding ${params.targetLanguage} (especially for Czech: fluent everyday culinary Czech, zero robotic or literal translation phrasing).`,
    '3. RECIPE DATA INTEGRITY: Check if the source contains a real recipe (ingredients + preparation steps).',
    '   - IF THE SOURCE HAS RECIPE DATA: Set hasRecipeData = true and recipeNotice = "". Extract ALL recipe details from the source EXACTLY: ingredients with exact quantities and units, steps in exact order, prep time, cook time, and servings. NEVER invent, round, or alter quantities, temperatures, or times.',
    '   - OUTPUT STRUCTURE FOR RECIPES:',
    '     a) Short intro (60-100 words).',
    '     b) Complete Recipe Card (mark EVERY block in this card with keepTogether = true so ingredients and steps are NEVER separated across pages):',
    '        - Summary paragraph with exact prep time, cook time, total time, and servings (only values present in source).',
    '        - "Ingredients" H2 (localized naturally, e.g. "Suroviny" in Czech) + bullet list (`ul`) with exact quantities and units.',
    '        - "Instructions" H2 (localized naturally, e.g. "Postup přípravy" in Czech) + numbered list (`ol`) with steps in exact order.',
    '     c) Tips H2 (helpful culinary advice, technique nuances, ingredient swaps — keepTogether = false).',
    '     d) Storage H2 (how to store, refrigerate, freeze, or reheat — keepTogether = false).',
    '     e) FAQ H2 (3-5 practical questions and answers about the dish — keepTogether = false).',
    '   - IF THE SOURCE HAS NO RECIPE DATA: Set hasRecipeData = false. Write a clear recipeNotice stating that the source contains no recipe data so no recipe was invented (and include a brief factual note in the intro or opening section). Rewrite only the real facts from the source without inventing ingredients, quantities, or steps.',
    `4. PACING FOR PAGINATION: Non-recipe sections will be split into pages of ~${params.targetWordsPerPage} words each while keeping the recipe card intact on a single page.`,
    '5. SEO & SOCIAL: Generate an SEO meta title, meta description, ASCII slug, 1 category, 4-6 tags, and a Facebook package (hook caption + 3-5 #hashtags).',
    '6. NO SOURCE LINKS OR PAGINATION TEXT: Never include the source URL, "Source:", links to the source website, or source page numbers (e.g. "Pages: 1 2 3") anywhere in the article, meta description, or Facebook caption.',
    '',
    `SOURCE TITLE: ${params.sourceTitle}`,
    'SOURCE CONTENT:',
    params.sourceText,
  ].join('\n');

  const { response: firstResp } = await generateWithRetry(
    ai,
    {
      contents: initialPrompt,
      config: {
        systemInstruction: `You are a senior culinary & magazine editor fluent in ${params.targetLanguage}. Extract recipe quantities, units, temperatures, times, and step order with 100% precision. Never fabricate missing recipe data. Write natural, human-sounding ${params.targetLanguage} with zero filler or repetition.`,
        responseMimeType: 'application/json',
        responseSchema: ARTICLE_RESPONSE_SCHEMA,
      },
    },
    { onStatusUpdate: params.onStatusUpdate }
  );

  if (!firstResp.text) {
    throw new Error('AI returned an empty response during rewriting.');
  }

  let draft = JSON.parse(firstResp.text) as GeneratedArticleDraft;
  draft.blocks = sanitizeBlocks(draft.blocks ?? []);
  let totalWords = draftTotalWords(draft);
  let expansionAttempts = 0;

  while (totalWords < params.minWords && expansionAttempts < 3) {
    expansionAttempts += 1;
    const deficit = params.minWords - totalWords;
    const goalWords = params.minWords + 180;

    params.onStatusUpdate?.(
      `Word count is ${totalWords} (< ${params.minWords}). Expanding with deeper insights (attempt ${expansionAttempts}/3)...`
    );

    const expandPrompt = [
      `The current article draft in ${params.targetLanguage} is ${totalWords} words, which is ${deficit} words short of the mandatory ${params.minWords}-word minimum.`,
      `Expand the full article so that intro + body blocks reach ${goalWords} to ${goalWords + 180} words total.`,
      '',
      'EXPANSION RULES:',
      '- NEVER add fluff, filler phrases, or repeat ideas already stated.',
      '- NEVER invent or alter recipe quantities, units, temperatures, times, or step order. Keep the exact recipe card blocks intact with keepTogether = true.',
      '- Expand by adding practical kitchen/editorial tips, serving suggestions, common mistakes to avoid, storage guidance, and a substantive FAQ section (4-5 Q&As) — all in natural, human-sounding ' +
        params.targetLanguage +
        '.',
      '- If hasRecipeData is false, keep hasRecipeData = false and do NOT invent any recipe.',
      '- Keep the exact same JSON structure, returning the COMPLETE expanded article.',
      '',
      'SOURCE FACTS REFERENCE:',
      params.sourceText.slice(0, 12000),
      '',
      'CURRENT DRAFT TO EXPAND:',
      JSON.stringify({
        title: draft.title,
        intro: draft.intro,
        hasRecipeData: draft.hasRecipeData,
        recipeNotice: draft.recipeNotice,
        blocks: draft.blocks,
      }),
    ].join('\n');

    const { response: expandResp } = await generateWithRetry(
      ai,
      {
        contents: expandPrompt,
        config: {
          systemInstruction: `You are a senior culinary & magazine editor fluent in ${params.targetLanguage}. Expand drafts with practical tips, storage advice, and FAQ depth until the word count strictly exceeds ${params.minWords} words, while never altering recipe quantities/times or inventing missing recipes.`,
          responseMimeType: 'application/json',
          responseSchema: ARTICLE_RESPONSE_SCHEMA,
        },
      },
      { onStatusUpdate: params.onStatusUpdate }
    );

    if (expandResp.text) {
      const expanded = JSON.parse(expandResp.text) as GeneratedArticleDraft;
      expanded.blocks = sanitizeBlocks(expanded.blocks ?? []);
      const expandedCount = draftTotalWords(expanded);
      if (expandedCount > totalWords) {
        draft = expanded;
        totalWords = expandedCount;
      }
    }
  }

  if (totalWords < params.minWords) {
    throw new Error(
      `Article reached ${totalWords} words after ${expansionAttempts} expansion attempts, which is still below the required ${params.minWords}-word minimum. Try a source article with more detailed material or adjust the minimum word threshold in Settings.`
    );
  }

  return { draft, totalWords, expansionAttempts };
}

export async function generatePageHooks(
  pagePreviews: Array<{ pageNumber: number; openingText: string; isLastPage: boolean }>,
  articleTitle: string,
  targetLanguage: string,
  onStatusUpdate?: (detail: string) => void
): Promise<string[]> {
  if (pagePreviews.length <= 1) {
    return pagePreviews.map(() => '');
  }

  const ai = getGeminiClient();
  const prompt = [
    `Write a short, compelling 1-sentence opening hook (10-18 words) in ${targetLanguage} for each page of this multi-page article titled "${articleTitle}".`,
    'Purpose: Every page should start with a small hook so readers stay intrigued and want to click "Next" at the end of the page.',
    'Do not repeat the page heading verbatim; tease what is unfolding on that page or coming next.',
    '',
    'Pages:',
    ...pagePreviews.map(
      (p) => `Page ${p.pageNumber}${p.isLastPage ? ' (final page)' : ''}: ${p.openingText.slice(0, 260)}`
    ),
  ].join('\n');

  try {
    const { response: resp } = await generateWithRetry(
      ai,
      {
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              hooks: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
            },
            required: ['hooks'],
          },
        },
      },
      { onStatusUpdate }
    );
    if (resp.text) {
      const parsed = JSON.parse(resp.text) as { hooks?: string[] };
      if (Array.isArray(parsed.hooks) && parsed.hooks.length === pagePreviews.length) {
        return parsed.hooks.map((h) => h.trim());
      }
    }
  } catch {
    // Non-fatal: continue cleanly without extra hooks if auxiliary call fails
  }

  return pagePreviews.map(() => '');
}

export async function testAiConnection(): Promise<{
  ok: boolean;
  model: string;
  latencyMs: number;
  message: string;
}> {
  const start = Date.now();
  try {
    const ai = getGeminiClient();
    const { response: resp, modelUsed } = await generateWithRetry(
      ai,
      { contents: 'Reply with OK.' },
      { retryDelaysMs: [3000] }
    );
    const latencyMs = Date.now() - start;
    if (!resp.text) {
      return {
        ok: false,
        model: modelUsed,
        latencyMs,
        message: 'Connected, but received an empty response from the model.',
      };
    }
    return {
      ok: true,
      model: modelUsed,
      latencyMs,
      message: `${modelUsed} responded in ${latencyMs}ms.`,
    };
  } catch (err) {
    return {
      ok: false,
      model: MODEL_FALLBACK_CHAIN[0],
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : 'Failed to connect to Gemini AI.',
    };
  }
}
