// server.ts
import crypto2 from "node:crypto";
import fs2 from "node:fs";
import path2 from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";

// server/lib/auth.ts
import crypto from "node:crypto";

// server/lib/storage.ts
import fs from "node:fs/promises";
import path from "node:path";
var DATA_DIR = process.env.DATA_DIR?.trim() ? path.resolve(process.env.DATA_DIR.trim()) : path.resolve(process.cwd(), "data");
var STORE_PATH = path.resolve(DATA_DIR, "s7wari.json");
var DEFAULT_STORE = {
  owner: null,
  sites: [],
  jobs: [],
  settings: {
    editorialTone: "editorial"
  }
};
var writeChain = Promise.resolve();
async function ensureStoreFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(STORE_PATH);
  } catch {
    await fs.writeFile(STORE_PATH, JSON.stringify(DEFAULT_STORE, null, 2), { encoding: "utf8", mode: 384 });
  }
}
async function readStore() {
  await ensureStoreFile();
  const raw = await fs.readFile(STORE_PATH, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return {
      owner: parsed.owner ?? null,
      sites: Array.isArray(parsed.sites) ? parsed.sites : [],
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      settings: {
        editorialTone: parsed.settings?.editorialTone ?? "editorial"
      }
    };
  } catch {
    return structuredClone(DEFAULT_STORE);
  }
}
async function updateStore(mutator) {
  let result;
  const task = writeChain.then(async () => {
    const current = await readStore();
    result = await mutator(current);
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmpPath = path.resolve(DATA_DIR, `s7wari.${process.pid}.${Date.now()}.tmp`);
    await fs.writeFile(tmpPath, JSON.stringify(current, null, 2), { encoding: "utf8", mode: 384 });
    await fs.rename(tmpPath, STORE_PATH);
  });
  writeChain = task.catch(() => {
  });
  await task;
  return result;
}
function toPublicSite(site) {
  return {
    id: site.id,
    name: site.name,
    url: site.url,
    username: site.username,
    hasAppPassword: Boolean(site.appPassword),
    language: site.language,
    targetWordsPerPage: site.targetWordsPerPage,
    minTotalWords: site.minTotalWords,
    lastTestedAt: site.lastTestedAt,
    lastTestOk: site.lastTestOk,
    lastTestMessage: site.lastTestMessage,
    createdAt: site.createdAt,
    updatedAt: site.updatedAt
  };
}

// server/lib/auth.ts
var EPHEMERAL_SECRET = crypto.randomBytes(32).toString("hex");
var TOKEN_TTL_MS = 24 * 60 * 60 * 1e3;
var revokedTokens = /* @__PURE__ */ new Set();
function getSigningSecret() {
  const envSecret = process.env.SESSION_SECRET?.trim();
  return envSecret && envSecret.length >= 16 ? envSecret : EPHEMERAL_SECRET;
}
function hashPassword(password, existingSalt) {
  const salt = existingSalt ?? crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash: derived, salt };
}
function verifyPassword(password, expectedHash, salt) {
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, "hex");
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}
function timingSafeTextEqual(a, b) {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
function isEnvOwnerConfigured() {
  return Boolean(process.env.OWNER_PASSWORD && process.env.OWNER_PASSWORD.trim().length > 0);
}
async function getAuthStatus() {
  if (isEnvOwnerConfigured()) {
    return {
      needsSetup: false,
      envManaged: true,
      ownerEmail: process.env.OWNER_EMAIL?.trim() || "owner@s7wari.app"
    };
  }
  const store = await readStore();
  return {
    needsSetup: store.owner === null,
    envManaged: false,
    ownerEmail: store.owner?.email ?? null
  };
}
async function claimInitialOwner(email, password) {
  if (isEnvOwnerConfigured()) {
    throw new Error("Owner credentials are managed by environment variables.");
  }
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes("@")) {
    throw new Error("Please enter a valid email address.");
  }
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters long.");
  }
  await updateStore((draft) => {
    if (draft.owner !== null) {
      throw new Error("Owner account is already configured. Please sign in.");
    }
    const { hash, salt } = hashPassword(password);
    draft.owner = {
      email: cleanEmail,
      passwordHash: hash,
      salt,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  });
  return { token: signSessionToken(cleanEmail), email: cleanEmail };
}
async function authenticateOwner(email, password) {
  const cleanEmail = email.trim().toLowerCase();
  if (isEnvOwnerConfigured()) {
    const envPass = process.env.OWNER_PASSWORD.trim();
    const envEmail = (process.env.OWNER_EMAIL?.trim() || "").toLowerCase();
    const emailOk = envEmail ? timingSafeTextEqual(cleanEmail, envEmail) : cleanEmail.length > 0;
    const passOk = timingSafeTextEqual(password, envPass);
    if (!emailOk || !passOk) return null;
    const resolvedEmail = envEmail || cleanEmail;
    return { token: signSessionToken(resolvedEmail), email: resolvedEmail };
  }
  const store = await readStore();
  if (!store.owner) return null;
  if (!timingSafeTextEqual(cleanEmail, store.owner.email.toLowerCase())) return null;
  if (!verifyPassword(password, store.owner.passwordHash, store.owner.salt)) return null;
  return { token: signSessionToken(store.owner.email), email: store.owner.email };
}
async function updateOwnerCredentials(currentPassword, newEmail, newPassword) {
  if (isEnvOwnerConfigured()) {
    throw new Error("Credentials are managed via environment secrets and cannot be changed in the UI.");
  }
  const cleanEmail = newEmail.trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes("@")) {
    throw new Error("Please enter a valid email address.");
  }
  if (newPassword && newPassword.length < 8) {
    throw new Error("New password must be at least 8 characters long.");
  }
  await updateStore((draft) => {
    if (!draft.owner) {
      throw new Error("Owner account is not initialized.");
    }
    if (!verifyPassword(currentPassword, draft.owner.passwordHash, draft.owner.salt)) {
      throw new Error("Current password is incorrect.");
    }
    const nextCreds = newPassword ? hashPassword(newPassword) : { hash: draft.owner.passwordHash, salt: draft.owner.salt };
    draft.owner = {
      email: cleanEmail,
      passwordHash: nextCreds.hash,
      salt: nextCreds.salt,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  });
  return { email: cleanEmail };
}
function signSessionToken(email) {
  const payload = Buffer.from(
    JSON.stringify({
      sub: email,
      iat: Date.now(),
      exp: Date.now() + TOKEN_TTL_MS,
      jti: crypto.randomBytes(12).toString("hex")
    })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", getSigningSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function verifySessionToken(token) {
  if (!token || revokedTokens.has(token)) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!payload || !sig) return null;
  const expectedSig = crypto.createHmac("sha256", getSigningSecret()).update(payload).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed.sub || !parsed.exp || Date.now() > parsed.exp) {
      return null;
    }
    return { email: parsed.sub };
  } catch {
    return null;
  }
}
function revokeSessionToken(token) {
  if (token) {
    revokedTokens.add(token);
  }
}
function extractBearerToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}
function requireAuth(req, res, next) {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: "Authentication required. Please sign in." });
    return;
  }
  const session = verifySessionToken(token);
  if (!session) {
    res.status(401).json({ error: "Session expired or invalid. Please sign in again." });
    return;
  }
  req.userEmail = session.email;
  next();
}

// server/lib/ai.ts
import { GoogleGenAI, Type } from "@google/genai";

// server/lib/paginator.ts
function stripHtml(html) {
  return html.replace(/<!--nextpage-->/gi, " ").replace(/<figure[\s\S]*?<\/figure>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/\s+/g, " ").trim();
}
function countWords(text) {
  const clean = stripHtml(text);
  if (!clean) return 0;
  return clean.split(/\s+/).filter(Boolean).length;
}
function blockWordCount(block) {
  if (block.type === "img" || block.type === "source") {
    return 0;
  }
  if (block.type === "ul" || block.type === "ol") {
    return countWords((block.items ?? []).join(" "));
  }
  return countWords(block.text ?? "");
}
function blocksWordCount(blocks) {
  return blocks.reduce((sum, b) => sum + blockWordCount(b), 0);
}
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function isSafeImageSrc(url) {
  if (/^data:image\/(jpeg|jpg|png|webp|gif|avif);base64,/i.test(url)) {
    return true;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
function buildFigureHtml(img, extraClass = "") {
  const src = img.wpSourceUrl || img.sourceUrl;
  if (!isSafeImageSrc(src)) return "";
  const cls = ["wp-block-image", extraClass].filter(Boolean).join(" ");
  return `<figure class="${cls}"><img src="${escapeHtml(src)}" alt="${escapeHtml(img.alt)}" />${img.caption ? `<figcaption>${escapeHtml(img.caption)}</figcaption>` : ""}</figure>`;
}
function renderBlocksToHtml(blocks, hook, imagesForPage = [], isFirstPage = false, options) {
  const parts = [];
  const preserveInlineOrder = Boolean(options?.preserveInlineOrder);
  if (hook && hook.trim()) {
    parts.push(`<p class="s7-page-hook"><em>${escapeHtml(hook.trim())}</em></p>`);
  }
  const featuredImg = !preserveInlineOrder && isFirstPage ? imagesForPage.find((img) => img.isFeatured) ?? imagesForPage[0] : void 0;
  if (featuredImg) {
    const figHtml = buildFigureHtml(featuredImg, "s7-featured-image");
    if (figHtml) parts.push(figHtml);
  }
  const remainingImages = preserveInlineOrder ? [] : featuredImg ? imagesForPage.filter((img) => img.id !== featuredImg.id) : imagesForPage;
  let insertedInlineImage = false;
  blocks.forEach((block, index) => {
    if (block.type === "img" && block.imageUrl) {
      if (isSafeImageSrc(block.imageUrl)) {
        parts.push(
          `<figure class="wp-block-image"><img src="${escapeHtml(block.imageUrl)}" alt="${escapeHtml(
            block.alt ?? ""
          )}" />${block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : ""}</figure>`
        );
      }
    } else if (block.type === "source") {
    } else if (block.type === "h2" && block.text) {
      parts.push(`<h2>${escapeHtml(block.text.trim())}</h2>`);
    } else if (block.type === "h3" && block.text) {
      parts.push(`<h3>${escapeHtml(block.text.trim())}</h3>`);
    } else if ((block.type === "ul" || block.type === "ol") && block.items?.length) {
      const tag = block.type;
      const lis = block.items.filter((item) => item.trim().length > 0).map((item) => `<li>${escapeHtml(item.trim())}</li>`).join("");
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
  return parts.join("\n\n");
}
function isRecipeHeading(block) {
  if (block.type !== "h2" && block.type !== "h3") return null;
  const text = (block.text ?? "").toLowerCase();
  if (/(ingredient|surovin|ingredienc|přísad|prisad|zutaten|ingrédient|co budete potřebovat)/i.test(text)) {
    return "ingredients";
  }
  if (/(instruction|method|direction|postup|příprav|priprav|jak na to|zubereitung|préparation)/i.test(text)) {
    return "instructions";
  }
  return null;
}
function isProtectedRecipeBreak(allBlocks, breakIndex) {
  if (breakIndex <= 0 || breakIndex >= allBlocks.length) return false;
  const prev = allBlocks[breakIndex - 1];
  const next = allBlocks[breakIndex];
  if (prev.keepTogether && next.keepTogether) {
    return true;
  }
  let ingredientsStart = -1;
  let instructionsEnd = -1;
  for (let i = 0; i < allBlocks.length; i += 1) {
    const kind = isRecipeHeading(allBlocks[i]);
    if (kind === "ingredients" && ingredientsStart === -1) {
      ingredientsStart = i;
    }
    if (kind === "instructions" && ingredientsStart !== -1) {
      let j = i + 1;
      while (j < allBlocks.length && allBlocks[j].type !== "h2") {
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
function splitBlocksIntoPages(intro, blocks, targetWordsPerPage = 300, minLastPageWords = 150) {
  const allBlocks = [];
  if (intro.trim()) {
    allBlocks.push({ type: "p", text: intro.trim() });
  }
  allBlocks.push(...blocks);
  if (allBlocks.length === 0) return [];
  const total = blocksWordCount(allBlocks);
  if (total <= targetWordsPerPage + minLastPageWords) {
    return [allBlocks];
  }
  const pages = [];
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
      if (currentBlock.type === "h2" || currentBlock.type === "h3") {
        continue;
      }
      if (isProtectedRecipeBreak(allBlocks, i + 1)) {
        continue;
      }
      if (running < Math.max(100, targetWordsPerPage * 0.4)) {
        continue;
      }
      const distance = Math.abs(running - targetWordsPerPage);
      const h2Bonus = nextBlock.type === "h2" && distance <= 120 ? -85 : 0;
      const h3Bonus = nextBlock.type === "h3" && distance <= 70 ? -35 : 0;
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
        if (acc >= targetWordsPerPage && prev.type !== "h2" && prev.type !== "h3" && !isProtectedRecipeBreak(allBlocks, fallbackEnd)) {
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
      const last = pages.pop();
      pages[pages.length - 1].push(...last);
    }
  }
  return pages;
}
function distributeImagesAcrossPages(pageCount, images) {
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
    const assignedPage = pageCount > 1 ? extraIdx % (pageCount - 1) + 2 : 1;
    extraIdx += 1;
    return { ...img, isFeatured: false, assignedPage };
  });
}
function buildArticlePages(pageBlocksList, hooks, images, options) {
  return pageBlocksList.map((pageBlocks, idx) => {
    const pageNumber = idx + 1;
    const hook = hooks[idx] ?? "";
    const pageImages = images.filter((img) => img.included && img.assignedPage === pageNumber);
    const html = renderBlocksToHtml(pageBlocks, hook, pageImages, pageNumber === 1, options);
    const plainText = stripHtml(html);
    return {
      pageNumber,
      hook,
      html,
      plainText,
      wordCount: countWords(html)
    };
  });
}
function assembleWordPressContent(pages) {
  return pages.map((p) => p.html.trim()).join("\n\n<!--nextpage-->\n\n");
}

// server/lib/ai.ts
var PRIMARY_MODEL = "gemini-2.5-flash";
var FALLBACK_MODELS = ["gemini-3.5-flash-lite"];
var MODEL_FALLBACK_CHAIN = [PRIMARY_MODEL, ...FALLBACK_MODELS];
var RETRY_DELAYS_MS = [3e3, 6e3, 12e3, 24e3, 48e3];
var AI_CALL_TIMEOUT_MS = 9e4;
function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured on the server. Set it in your .env file or hosting environment variables.");
  }
  return new GoogleGenAI({ apiKey });
}
function isAiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function extractErrorInfo(err) {
  if (err && typeof err === "object") {
    const record = err;
    const status = typeof record.status === "number" ? record.status : typeof record.statusCode === "number" ? record.statusCode : void 0;
    const code = typeof record.code === "string" ? record.code : void 0;
    const message = typeof record.message === "string" ? record.message : err instanceof Error ? err.message : String(err);
    return { status, code, message };
  }
  return { message: String(err) };
}
function isNonRetryableAuthError(err) {
  const { status, message } = extractErrorInfo(err);
  const upper = message.toUpperCase();
  if (status === 401 || status === 403) {
    return upper.includes("API_KEY_INVALID") || upper.includes("PERMISSION_DENIED") || upper.includes("UNAUTHENTICATED");
  }
  return upper.includes("API_KEY_INVALID") || upper.includes("GEMINI_API_KEY IS NOT CONFIGURED");
}
function isModelUnavailableError(err) {
  const { status, message } = extractErrorInfo(err);
  const upper = message.toUpperCase();
  return status === 404 || upper.includes("404") || upper.includes("NOT_FOUND") || upper.includes("MODEL_NOT_FOUND");
}
function isRetryableBackoffError(err) {
  if (isNonRetryableAuthError(err) || isModelUnavailableError(err)) return false;
  const { status, message } = extractErrorInfo(err);
  if (status === 503 || status === 429 || status === 500) return true;
  const upper = message.toUpperCase();
  return upper.includes("503") || upper.includes("429") || upper.includes("500") || upper.includes("UNAVAILABLE") || upper.includes("RESOURCE_EXHAUSTED") || upper.includes('"STATUS":"INTERNAL"') || upper.includes("INTERNAL ERROR");
}
async function callWithTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`AI request timed out after ${Math.round(timeoutMs / 1e3)}s.`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function generateWithRetry(ai, request, options) {
  const delays = options?.retryDelaysMs ?? RETRY_DELAYS_MS;
  let lastError = null;
  for (let modelIdx = 0; modelIdx < MODEL_FALLBACK_CHAIN.length; modelIdx += 1) {
    const model = MODEL_FALLBACK_CHAIN[modelIdx];
    const isFallback = modelIdx > 0;
    if (isFallback) {
      const reason = lastError && isModelUnavailableError(lastError) ? "unavailable (404)" : "busy";
      options?.onStatusUpdate?.(`Previous AI model is ${reason}. Switching to fallback model (${model})...`);
    }
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      try {
        const response = await callWithTimeout(
          ai.models.generateContent({
            ...request,
            model
          }),
          AI_CALL_TIMEOUT_MS
        );
        if (!response.text || !response.text.trim()) {
          throw new Error("AI returned an empty response.");
        }
        return { response, modelUsed: model };
      } catch (err) {
        lastError = err;
        if (isNonRetryableAuthError(err)) {
          throw err;
        }
        if (isModelUnavailableError(err)) {
          break;
        }
        const hasNextRetry = attempt < delays.length;
        if (isRetryableBackoffError(err) && hasNextRetry) {
          const waitMs = delays[attempt];
          const retryNumber = attempt + 1;
          const totalRetries = delays.length;
          const modelNote = isFallback ? ` on ${model}` : "";
          options?.onStatusUpdate?.(
            `AI is busy${modelNote}, retrying (${retryNumber}/${totalRetries}) in ${Math.round(waitMs / 1e3)}s...`
          );
          await sleep(waitMs);
          continue;
        }
        break;
      }
    }
  }
  const finalInfo = extractErrorInfo(lastError);
  throw new Error(
    `AI service remained unavailable after retries and fallback models (${finalInfo.message}). Please try again shortly.`
  );
}
var ARTICLE_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: "Catchy, engaging editorial headline in the target language." },
    intro: {
      type: Type.STRING,
      description: "Short, compelling 60-100 word opening introduction in natural target-language prose."
    },
    hasRecipeData: {
      type: Type.BOOLEAN,
      description: "True ONLY if the source actually contains concrete recipe data (ingredients and preparation steps). False if no recipe data exists in the source."
    },
    recipeNotice: {
      type: Type.STRING,
      description: "Empty string when hasRecipeData is true. When hasRecipeData is false, a clear note stating that the source article contains no recipe data so no recipe was invented."
    },
    blocks: {
      type: Type.ARRAY,
      description: "Ordered body content blocks: h2 headings, h3 subheadings, short paragraphs (p), bullet lists (ul), and numbered lists (ol).",
      items: {
        type: Type.OBJECT,
        properties: {
          type: { type: Type.STRING, description: "One of: h2, h3, p, ul, ol" },
          text: { type: Type.STRING, description: "Text for h2, h3, or p blocks." },
          items: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "List strings when type is ul (bullet list) or ol (numbered list)."
          },
          keepTogether: {
            type: Type.BOOLEAN,
            description: "True for every block belonging to the core recipe card (prep/cook/servings summary, Ingredients heading & bullet list, Instructions heading & numbered list) so it stays together on a single page."
          }
        },
        required: ["type"]
      }
    },
    seo: {
      type: Type.OBJECT,
      properties: {
        metaTitle: { type: Type.STRING, description: "SEO title <= 60 chars in target language." },
        metaDescription: { type: Type.STRING, description: "SEO description 135-160 chars in target language." },
        slug: { type: Type.STRING, description: "URL-friendly lowercase hyphenated ASCII slug." },
        category: { type: Type.STRING, description: "Primary editorial category name in target language." },
        tags: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "4 to 6 relevant editorial tags in target language."
        }
      },
      required: ["metaTitle", "metaDescription", "slug", "category", "tags"]
    },
    facebook: {
      type: Type.OBJECT,
      properties: {
        caption: {
          type: Type.STRING,
          description: "High-curiosity Facebook hook caption in the target language (2-4 punchy sentences)."
        },
        hashtags: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "3 to 5 relevant hashtags starting with #."
        }
      },
      required: ["caption", "hashtags"]
    }
  },
  required: ["title", "intro", "hasRecipeData", "recipeNotice", "blocks", "seo", "facebook"]
};
function sanitizeBlocks(rawBlocks) {
  const cleaned = [];
  for (const b of rawBlocks) {
    const type = b.type === "h2" || b.type === "h3" || b.type === "ul" || b.type === "ol" ? b.type : "p";
    const keepTogether = Boolean(b.keepTogether);
    if (type === "ul" || type === "ol") {
      const items = (b.items ?? []).map((i) => String(i).trim()).filter(Boolean);
      if (items.length > 0) cleaned.push({ type, items, ...keepTogether ? { keepTogether: true } : {} });
    } else {
      const text = (b.text ?? "").trim();
      if (text) cleaned.push({ type, text, ...keepTogether ? { keepTogether: true } : {} });
    }
  }
  return cleaned;
}
function draftTotalWords(draft) {
  return countWords(draft.intro) + blocksWordCount(draft.blocks);
}
async function generateRewrittenArticle(params) {
  const ai = getGeminiClient();
  const targetMax = Math.max(params.minWords + 280, 1200);
  const targetMin = Math.max(params.minWords + 100, 1e3);
  const toneDescriptions = {
    editorial: "Polished magazine journalism \u2014 authoritative, vivid, human, and deeply readable.",
    engaging: "High-curiosity digital feature style \u2014 punchy storytelling, clear takeaways, strong narrative momentum.",
    informative: "Clear, practical, structured explainer \u2014 helpful, precise, reader-first."
  };
  params.onStatusUpdate?.(`Drafting ${params.minWords}+ words in ${params.targetLanguage}...`);
  const initialPrompt = [
    `Rewrite the source article below into an original, long-form feature written entirely in ${params.targetLanguage}.`,
    `Style: ${toneDescriptions[params.editorialTone]}`,
    "",
    "CRITICAL RECIPE & CONTENT RULES:",
    `1. LENGTH: Write between ${targetMin} and ${targetMax} words across the intro and body blocks (minimum absolute floor: ${params.minWords} words). Never pad with filler or repetition.`,
    `2. NATURAL HUMAN LANGUAGE: Write completely natural, idiomatic, human-sounding ${params.targetLanguage} (especially for Czech: fluent everyday culinary Czech, zero robotic or literal translation phrasing).`,
    "3. RECIPE DATA INTEGRITY: Check if the source contains a real recipe (ingredients + preparation steps).",
    '   - IF THE SOURCE HAS RECIPE DATA: Set hasRecipeData = true and recipeNotice = "". Extract ALL recipe details from the source EXACTLY: ingredients with exact quantities and units, steps in exact order, prep time, cook time, and servings. NEVER invent, round, or alter quantities, temperatures, or times.',
    "   - OUTPUT STRUCTURE FOR RECIPES:",
    "     a) Short intro (60-100 words).",
    "     b) Complete Recipe Card (mark EVERY block in this card with keepTogether = true so ingredients and steps are NEVER separated across pages):",
    "        - Summary paragraph with exact prep time, cook time, total time, and servings (only values present in source).",
    '        - "Ingredients" H2 (localized naturally, e.g. "Suroviny" in Czech) + bullet list (`ul`) with exact quantities and units.',
    '        - "Instructions" H2 (localized naturally, e.g. "Postup p\u0159\xEDpravy" in Czech) + numbered list (`ol`) with steps in exact order.',
    "     c) Tips H2 (helpful culinary advice, technique nuances, ingredient swaps \u2014 keepTogether = false).",
    "     d) Storage H2 (how to store, refrigerate, freeze, or reheat \u2014 keepTogether = false).",
    "     e) FAQ H2 (3-5 practical questions and answers about the dish \u2014 keepTogether = false).",
    "   - IF THE SOURCE HAS NO RECIPE DATA: Set hasRecipeData = false. Write a clear recipeNotice stating that the source contains no recipe data so no recipe was invented (and include a brief factual note in the intro or opening section). Rewrite only the real facts from the source without inventing ingredients, quantities, or steps.",
    `4. PACING FOR PAGINATION: Non-recipe sections will be split into pages of ~${params.targetWordsPerPage} words each while keeping the recipe card intact on a single page.`,
    "5. SEO & SOCIAL: Generate an SEO meta title, meta description, ASCII slug, 1 category, 4-6 tags, and a Facebook package (hook caption + 3-5 #hashtags).",
    '6. NO SOURCE LINKS OR PAGINATION TEXT: Never include the source URL, "Source:", links to the source website, or source page numbers (e.g. "Pages: 1 2 3") anywhere in the article, meta description, or Facebook caption.',
    "",
    `SOURCE TITLE: ${params.sourceTitle}`,
    "SOURCE CONTENT:",
    params.sourceText
  ].join("\n");
  const { response: firstResp } = await generateWithRetry(
    ai,
    {
      contents: initialPrompt,
      config: {
        systemInstruction: `You are a senior culinary & magazine editor fluent in ${params.targetLanguage}. Extract recipe quantities, units, temperatures, times, and step order with 100% precision. Never fabricate missing recipe data. Write natural, human-sounding ${params.targetLanguage} with zero filler or repetition.`,
        responseMimeType: "application/json",
        responseSchema: ARTICLE_RESPONSE_SCHEMA
      }
    },
    { onStatusUpdate: params.onStatusUpdate }
  );
  if (!firstResp.text) {
    throw new Error("AI returned an empty response during rewriting.");
  }
  let draft = JSON.parse(firstResp.text);
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
      "",
      "EXPANSION RULES:",
      "- NEVER add fluff, filler phrases, or repeat ideas already stated.",
      "- NEVER invent or alter recipe quantities, units, temperatures, times, or step order. Keep the exact recipe card blocks intact with keepTogether = true.",
      "- Expand by adding practical kitchen/editorial tips, serving suggestions, common mistakes to avoid, storage guidance, and a substantive FAQ section (4-5 Q&As) \u2014 all in natural, human-sounding " + params.targetLanguage + ".",
      "- If hasRecipeData is false, keep hasRecipeData = false and do NOT invent any recipe.",
      "- Keep the exact same JSON structure, returning the COMPLETE expanded article.",
      "",
      "SOURCE FACTS REFERENCE:",
      params.sourceText.slice(0, 12e3),
      "",
      "CURRENT DRAFT TO EXPAND:",
      JSON.stringify({
        title: draft.title,
        intro: draft.intro,
        hasRecipeData: draft.hasRecipeData,
        recipeNotice: draft.recipeNotice,
        blocks: draft.blocks
      })
    ].join("\n");
    const { response: expandResp } = await generateWithRetry(
      ai,
      {
        contents: expandPrompt,
        config: {
          systemInstruction: `You are a senior culinary & magazine editor fluent in ${params.targetLanguage}. Expand drafts with practical tips, storage advice, and FAQ depth until the word count strictly exceeds ${params.minWords} words, while never altering recipe quantities/times or inventing missing recipes.`,
          responseMimeType: "application/json",
          responseSchema: ARTICLE_RESPONSE_SCHEMA
        }
      },
      { onStatusUpdate: params.onStatusUpdate }
    );
    if (expandResp.text) {
      const expanded = JSON.parse(expandResp.text);
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
async function generatePageHooks(pagePreviews, articleTitle, targetLanguage, onStatusUpdate) {
  if (pagePreviews.length <= 1) {
    return pagePreviews.map(() => "");
  }
  const ai = getGeminiClient();
  const prompt = [
    `Write a short, compelling 1-sentence opening hook (10-18 words) in ${targetLanguage} for each page of this multi-page article titled "${articleTitle}".`,
    'Purpose: Every page should start with a small hook so readers stay intrigued and want to click "Next" at the end of the page.',
    "Do not repeat the page heading verbatim; tease what is unfolding on that page or coming next.",
    "",
    "Pages:",
    ...pagePreviews.map(
      (p) => `Page ${p.pageNumber}${p.isLastPage ? " (final page)" : ""}: ${p.openingText.slice(0, 260)}`
    )
  ].join("\n");
  try {
    const { response: resp } = await generateWithRetry(
      ai,
      {
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              hooks: {
                type: Type.ARRAY,
                items: { type: Type.STRING }
              }
            },
            required: ["hooks"]
          }
        }
      },
      { onStatusUpdate }
    );
    if (resp.text) {
      const parsed = JSON.parse(resp.text);
      if (Array.isArray(parsed.hooks) && parsed.hooks.length === pagePreviews.length) {
        return parsed.hooks.map((h) => h.trim());
      }
    }
  } catch {
  }
  return pagePreviews.map(() => "");
}
async function testAiConnection() {
  const start = Date.now();
  try {
    const ai = getGeminiClient();
    const { response: resp, modelUsed } = await generateWithRetry(
      ai,
      { contents: "Reply with OK." },
      { retryDelaysMs: [3e3] }
    );
    const latencyMs = Date.now() - start;
    if (!resp.text) {
      return {
        ok: false,
        model: modelUsed,
        latencyMs,
        message: "Connected, but received an empty response from the model."
      };
    }
    return {
      ok: true,
      model: modelUsed,
      latencyMs,
      message: `${modelUsed} responded in ${latencyMs}ms.`
    };
  } catch (err) {
    return {
      ok: false,
      model: MODEL_FALLBACK_CHAIN[0],
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : "Failed to connect to Gemini AI."
    };
  }
}

// server/lib/copyMode.ts
var STOP_WORDS = /* @__PURE__ */ new Set([
  "about",
  "after",
  "again",
  "also",
  "always",
  "among",
  "another",
  "around",
  "because",
  "before",
  "being",
  "below",
  "between",
  "both",
  "could",
  "doing",
  "during",
  "each",
  "every",
  "from",
  "further",
  "have",
  "having",
  "here",
  "hers",
  "herself",
  "himself",
  "into",
  "just",
  "make",
  "more",
  "most",
  "much",
  "must",
  "neither",
  "never",
  "only",
  "other",
  "ours",
  "ourselves",
  "over",
  "same",
  "should",
  "some",
  "such",
  "than",
  "that",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "under",
  "until",
  "very",
  "what",
  "when",
  "where",
  "which",
  "while",
  "whom",
  "with",
  "would",
  "your",
  "yours",
  "yourself",
  "nebo",
  "jako",
  "jsou",
  "jsem",
  "jsme",
  "jste",
  "ktery",
  "ktera",
  "ktere",
  "kterou",
  "kterych",
  "tento",
  "tato",
  "toto",
  "tohle",
  "jeho",
  "jeji",
  "jejich",
  "pred",
  "pres",
  "proti",
  "podle",
  "mezi",
  "bude",
  "budou",
  "bylo",
  "byla",
  "byli",
  "byl",
  "aby",
  "takze",
  "proto",
  "kdyz",
  "pokud",
  "velmi",
  "vice",
  "jaky",
  "jaka",
  "jake",
  "recept",
  "recepty",
  "clanku",
  "clanek"
]);
function toAscii(input) {
  return input.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function buildSlugFromTitle(title) {
  const ascii = toAscii(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70).replace(/-+$/g, "");
  return ascii || `article-${Date.now()}`;
}
function truncateAtWord(text, maxLen) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  const sliced = clean.slice(0, maxLen - 1);
  const lastSpace = sliced.lastIndexOf(" ");
  const cut = lastSpace > Math.floor(maxLen * 0.55) ? sliced.slice(0, lastSpace) : sliced;
  return `${cut.replace(/[.,;:!?-]+$/, "").trim()}\u2026`;
}
function isCzechOrSlovak(language) {
  return /(czech|česk|slovak|sloven)/i.test(language);
}
function extractTagsFromTitle(title, category) {
  const words = title.split(/[^a-zA-Z0-9\u00C0-\u024F]+/).map((w) => w.trim()).filter((w) => w.length >= 4);
  const tags = [];
  const seen = /* @__PURE__ */ new Set();
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
function buildCopyModeSeo(params) {
  const cleanTitle = params.title.replace(/\s+/g, " ").trim() || "Untitled Article";
  const firstParagraph = params.blocks.find((b) => b.type === "p" && b.text && b.text.trim().length >= 25)?.text?.trim() || params.description.trim() || cleanTitle;
  const metaTitle = truncateAtWord(cleanTitle, 60);
  const rawDescription = firstParagraph.toLowerCase() === cleanTitle.toLowerCase() ? cleanTitle : firstParagraph.length >= 50 ? firstParagraph : `${cleanTitle} \u2014 ${firstParagraph}`;
  const metaDescription = truncateAtWord(rawDescription, 155);
  const cs = isCzechOrSlovak(params.language);
  const category = params.hasRecipeData ? cs ? "Recepty" : "Recipes" : cs ? "\u010Cl\xE1nky" : "Articles";
  const tags = extractTagsFromTitle(cleanTitle, category);
  return {
    metaTitle,
    metaDescription,
    slug: buildSlugFromTitle(cleanTitle),
    category,
    tags
  };
}
function toHashtagToken(label) {
  const cleaned = toAscii(label).replace(/[^a-zA-Z0-9]+/g, "").trim();
  return cleaned ? `#${cleaned}` : "";
}
function buildCopyModeFacebookPackage(params) {
  const cs = isCzechOrSlovak(params.language);
  const genericPool = params.hasRecipeData ? cs ? ["#Recepty", "#Vareni", "#DomaciKuchyne", "#Inspirace"] : ["#Recipes", "#Cooking", "#Homemade", "#FoodInspiration"] : cs ? ["#Clanek", "#Cteni", "#Inspirace", "#Novinky"] : ["#Article", "#Reading", "#MustRead", "#Inspiration"];
  const categoryTag = toHashtagToken(params.category);
  const hashtags = [];
  const seen = /* @__PURE__ */ new Set();
  for (const tag of [categoryTag, ...genericPool]) {
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hashtags.push(tag);
    if (hashtags.length >= 4) break;
  }
  return {
    caption: params.title.replace(/\s+/g, " ").trim(),
    hashtags,
    postUrl: params.postUrl
  };
}

// server/lib/sanitize.ts
import * as cheerio from "cheerio";
function normalizeDomain(urlOrHost) {
  const trimmed = (urlOrHost || "").trim();
  if (!trimmed) return "";
  try {
    const parsed = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return trimmed.toLowerCase().replace(/^www\./, "").split("/")[0] ?? "";
  }
}
function isSameWebsiteDomain(hostA, hostB) {
  const a = normalizeDomain(hostA);
  const b = normalizeDomain(hostB);
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}
function isPaginationText(rawText) {
  const text = rawText.replace(/\s+/g, " ").trim();
  if (!text || text.length > 90) return false;
  if (/^(?:pages?|stránky|stranky|strany|strony|seiten|p[áa]ginas?|sidor|oldalak)\s*:?\s*(?:(?:\d+|prev(?:ious)?|next|další|pokračovat|następna|poprzednia|weiter|suivant|‹|›|«|»|←|→|[|·•,/–—-])+\s*)+$/i.test(
    text
  )) {
    return true;
  }
  if (/^(?:page|strana|stránka|strona|seite|p[áa]gina)\s+\d+\s+(?:of|z|ze|von|de)\s+\d+$/i.test(text)) {
    return true;
  }
  if (/^(?:(?:previous|prev|next|next\s+page|prev\s+page|další|další\s+strana|pokračovat|předchozí|następna|poprzednia|weiter|zurück|suivant|précédent|←|→|«|»|‹|›)\s*[|·•,/–—-]?\s*)+(?:\d+\s*[|·•,/–—-]?\s*)*$/i.test(
    text
  )) {
    return true;
  }
  if (/^(?:\d{1,2}\s*[|·•,/–—-]?\s+){1,15}\d{1,2}(?:\s*[|·•,/–—-]?\s*(?:next|prev|previous|další|pokračovat|następna|poprzednia|←|→|«|»|‹|›))?$/i.test(
    text
  )) {
    return true;
  }
  return false;
}
function isSourceAttributionText(rawText) {
  const text = rawText.replace(/\s+/g, " ").trim();
  if (!text) return false;
  return /^(?:source|zdroj|źródło|zrodlo|quelle|fuente)\s*:\s*(?:https?:\/\/|www\.)\S*$/i.test(text);
}
function stripSourceUrlsFromText(text, sourceUrl, destinationSiteUrl) {
  if (!text) return text;
  const sourceDomain = sourceUrl ? normalizeDomain(sourceUrl) : "";
  const destDomain = destinationSiteUrl ? normalizeDomain(destinationSiteUrl) : "";
  let cleaned = text.replace(/(?:^|\n)\s*(?:source|zdroj|źródło|zrodlo|quelle|fuente)\s*:\s*(?:https?:\/\/|www\.)\S+/gi, "");
  if (sourceDomain && !(destDomain && isSameWebsiteDomain(sourceDomain, destDomain))) {
    cleaned = cleaned.replace(/(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi, (match) => {
      const candidateDomain = normalizeDomain(match);
      if (candidateDomain && isSameWebsiteDomain(candidateDomain, sourceDomain)) {
        return "";
      }
      return match;
    });
  }
  cleaned = cleaned.replace(/\b(?:source|zdroj|źródło|zrodlo|quelle|fuente)\s*:\s*(?:$|\n)/gim, "").replace(/[ \t]{2,}/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
  return cleaned;
}
function stripSourceLinksInCheerio($, $root, sourceUrl, destinationSiteUrl) {
  const sourceDomain = normalizeDomain(sourceUrl);
  const destDomain = destinationSiteUrl ? normalizeDomain(destinationSiteUrl) : "";
  $root.find("a").each((_, el) => {
    const $a = $(el);
    const rawHref = ($a.attr("href") || "").trim();
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("mailto:") || rawHref.startsWith("tel:") || rawHref.startsWith("javascript:")) {
      return;
    }
    let resolved = null;
    try {
      resolved = new URL(rawHref, sourceUrl);
    } catch {
      resolved = null;
    }
    if (!resolved || resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return;
    }
    const linkDomain = normalizeDomain(resolved.hostname);
    if (destDomain && isSameWebsiteDomain(linkDomain, destDomain)) {
      return;
    }
    if (sourceDomain && isSameWebsiteDomain(linkDomain, sourceDomain)) {
      if ($a.find("img, figure, picture").length > 0) {
        $a.replaceWith($a.contents());
        return;
      }
      const linkText = $a.text().replace(/\s+/g, " ").trim();
      const lowerText = linkText.toLowerCase();
      if (!linkText || /^(?:https?:\/\/|www\.)/i.test(linkText) || lowerText.includes(sourceDomain) || isPaginationText(linkText)) {
        $a.remove();
      } else {
        $a.replaceWith(linkText);
      }
    }
  });
}
var PAGINATION_CONTAINER_SELECTOR = [
  ".page-links",
  ".post-nav-links",
  ".post-pages",
  ".page-numbers",
  ".pagination",
  ".nav-links",
  ".pager",
  ".wp-pagenavi",
  ".post-pagination",
  ".entry-pagination",
  '[class*="page-links"]',
  '[class*="post-nav-links"]',
  'nav[aria-label*="page" i]',
  'nav[aria-label*="pagination" i]'
].join(", ");
function cleanPublishedPageHtml(html, sourceUrl, destinationSiteUrl) {
  if (!html || !html.trim()) return "";
  const $ = cheerio.load(`<div id="__s7_root">${html}</div>`, null, false);
  const $root = $("#__s7_root");
  $root.find(`.s7-source-attribution, ${PAGINATION_CONTAINER_SELECTOR}`).remove();
  if (sourceUrl) {
    stripSourceLinksInCheerio($, $root, sourceUrl, destinationSiteUrl);
  }
  const sourceDomain = sourceUrl ? normalizeDomain(sourceUrl) : "";
  const destDomain = destinationSiteUrl ? normalizeDomain(destinationSiteUrl) : "";
  const cleanTextNodes = (node) => {
    const n = node;
    if (!n) return;
    if (n.type === "text" && typeof n.data === "string") {
      let val = n.data;
      if (sourceDomain && !(destDomain && isSameWebsiteDomain(sourceDomain, destDomain))) {
        val = val.replace(/(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi, (match) => {
          const cand = normalizeDomain(match);
          return cand && isSameWebsiteDomain(cand, sourceDomain) ? "" : match;
        });
      }
      val = val.replace(/\b(?:source|zdroj|źródło|zrodlo|quelle|fuente)\s*:\s*$/i, "");
      n.data = val;
      return;
    }
    if (n.type === "tag") {
      const tag = (n.tagName ?? "").toLowerCase();
      if (tag === "figure" || tag === "img" || tag === "code" || tag === "pre") return;
      if (Array.isArray(n.children)) {
        for (const child of n.children) {
          cleanTextNodes(child);
        }
      }
    }
  };
  $root.contents().each((_, child) => cleanTextNodes(child));
  $root.find("p, div, span, small, li, ul, ol, nav").each((_, el) => {
    const $el = $(el);
    if ($el.find("img, figure").length > 0 || $el.closest("figure").length > 0) {
      return;
    }
    const text = $el.text().replace(/\s+/g, " ").trim();
    if (!text) {
      if ($el.is("p, div, small, li, ul, ol, nav")) {
        $el.remove();
      }
      return;
    }
    if (isPaginationText(text) || isSourceAttributionText(text) || /^(?:source|zdroj|źródło|zrodlo|quelle|fuente)\s*:?$/i.test(text)) {
      $el.remove();
    }
  });
  $root.find("ul, ol").each((_, el) => {
    const $el = $(el);
    if ($el.find("li").length === 0 && !$el.text().trim()) {
      $el.remove();
    }
  });
  return ($root.html() ?? "").trim();
}

// server/lib/scraper.ts
import * as cheerio2 from "cheerio";

// server/lib/ssrf.ts
import dns from "node:dns/promises";
import net from "node:net";
var BLOCKED_HOSTNAMES = /* @__PURE__ */ new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata"
]);
function isPrivateIPv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}
function isPrivateIPv6(ip) {
  const normalized = ip.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) {
    const mappedV4 = normalized.slice(7);
    if (net.isIPv4(mappedV4)) return isPrivateIPv4(mappedV4);
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return true;
  }
  return false;
}
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true;
}
async function assertSafeExternalUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Please enter a valid URL starting with http:// or https://.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs are supported.");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname) {
    throw new Error("URL is missing a hostname.");
  }
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("Requests to local or internal network addresses are not allowed.");
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error("Requests to private or loopback IP addresses are not allowed.");
    }
    return parsed;
  }
  try {
    const records = await dns.lookup(hostname, { all: true });
    if (!records.length) {
      throw new Error(`Could not resolve host "${hostname}".`);
    }
    for (const rec of records) {
      if (isPrivateIp(rec.address)) {
        throw new Error(`Host "${hostname}" resolves to a private network address and cannot be accessed.`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("private network")) {
      throw err;
    }
    throw new Error(`Unable to reach "${hostname}". Please verify the URL is correct and publicly accessible.`);
  }
  return parsed;
}
async function safeFetch(rawUrl, options = {}) {
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 2e4;
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertSafeExternalUrl(currentUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(currentUrl, {
        method: options.method ?? "GET",
        headers: options.headers,
        body: options.body,
        redirect: "manual",
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Request timed out after ${Math.round(timeoutMs / 1e3)}s while connecting to ${new URL(currentUrl).hostname}.`);
      }
      throw new Error(`Network error reaching ${new URL(currentUrl).hostname}: ${err instanceof Error ? err.message : "Connection failed"}`);
    }
    clearTimeout(timer);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        return { response: res, finalUrl: currentUrl };
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return { response: res, finalUrl: currentUrl };
  }
  throw new Error("Too many redirects while fetching the URL.");
}

// server/lib/scraper.ts
function decodeSourceUrl(input) {
  const trimmed = input.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Please enter a valid article URL starting with https:// or http://.");
  }
  const host = parsed.hostname.toLowerCase();
  const isFacebookRedirectHost = host === "l.facebook.com" || host === "lm.facebook.com" || host === "m.facebook.com" || host === "www.facebook.com";
  if (isFacebookRedirectHost && (parsed.pathname === "/l.php" || parsed.pathname === "/flx/warn/")) {
    const uParam = parsed.searchParams.get("u");
    if (uParam) {
      let decoded = uParam;
      try {
        if (decoded.includes("%3A%2F%2F") || decoded.includes("%25")) {
          decoded = decodeURIComponent(decoded);
        }
      } catch {
      }
      try {
        const target = new URL(decoded);
        if (target.protocol === "http:" || target.protocol === "https:") {
          return {
            originalUrl: trimmed,
            resolvedUrl: target.toString(),
            wasFacebookRedirect: true
          };
        }
      } catch {
        throw new Error("The Facebook redirect link did not contain a valid destination URL.");
      }
    }
  }
  return {
    originalUrl: trimmed,
    resolvedUrl: parsed.toString(),
    wasFacebookRedirect: false
  };
}
var NOISE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "button",
  "nav",
  "footer",
  "aside",
  "form",
  "body > header",
  'header[role="banner"]',
  ".site-header",
  "#masthead",
  '[role="navigation"]',
  '[role="banner"]',
  '[role="complementary"]',
  '[role="menu"]',
  '[aria-hidden="true"]',
  ".menu",
  ".nav-menu",
  ".ads",
  ".ad",
  ".advertisement",
  ".ad-unit",
  '[class*="ad-unit"]',
  '[id*="ad-slot"]',
  ".sidebar",
  "#sidebar",
  ".widget-area",
  ".comments",
  "#comments",
  "#respond",
  ".comment-list",
  ".comment-respond",
  ".cookie-banner",
  ".cookie-notice",
  "#cookie-banner",
  "#cookie-notice",
  ".cc-window",
  ".newsletter",
  ".newsletter-signup",
  ".related-posts",
  ".related-articles",
  ".jp-relatedposts",
  ".yarpp-related",
  '[class*="related-post"]',
  '[class*="related_post"]',
  ".author-box",
  ".share-buttons",
  ".social-share",
  ".sharedaddy",
  ".addtoany_share_save_container",
  '[class*="share-btn"]',
  '[class*="share-button"]',
  ".wprm-recipe-buttons",
  ".wprm-recipe-servings-adjustable-tooltip",
  ".wprm-recipe-jump",
  ".tasty-recipes-buttons",
  ".mv-create-buttons",
  ".mv-create-social",
  ".jump-to-recipe",
  '[class*="jump-to"]',
  '[class*="print-button"]',
  PAGINATION_CONTAINER_SELECTOR
].join(", ");
var PROTECTED_ANCESTOR_SELECTOR = 'article, main, .entry-content, .post-content, [itemprop="articleBody"], .article-content, .article-body, .story-body, .wprm-recipe-container, .wprm-recipe, .tasty-recipes, .tasty-recipe-card, .mv-create-card';
function removeNoiseSafely($) {
  $(NOISE_SELECTORS).each((_, el) => {
    const $el = $(el);
    if ($el.is("html, body") || $el.is(PROTECTED_ANCESTOR_SELECTOR)) {
      return;
    }
    if ($el.find(PROTECTED_ANCESTOR_SELECTOR).length > 0) {
      return;
    }
    $el.remove();
  });
}
function upgradeToHighResUrl(rawUrl) {
  return rawUrl.replace(/-\d{2,4}x\d{2,4}(?=\.(?:jpe?g|png|webp|gif|avif)(?:\?|$))/i, "");
}
function hasWpSizeSuffix(rawUrl) {
  return /-\d{2,4}x\d{2,4}(?=\.(?:jpe?g|png|webp|gif|avif)(?:\?|$))/i.test(rawUrl);
}
function isLikelyUsefulImage(imgUrl, alt, className = "") {
  const lower = imgUrl.toLowerCase();
  const lowerAlt = alt.toLowerCase();
  const lowerClass = className.toLowerCase();
  if (!lower.startsWith("http://") && !lower.startsWith("https://")) return false;
  if (lower.endsWith(".svg") || lower.includes(".svg?") || lower.startsWith("data:")) return false;
  const blockedPatterns = [
    "1x1",
    "pixel",
    "spacer",
    "blank.",
    "avatar",
    "gravatar",
    "emoji",
    "smiley",
    "icon",
    "favicon",
    "logo",
    "site-logo",
    "brand",
    "badge",
    "spinner",
    "loader",
    "doubleclick",
    "googlesyndication",
    "facebook.com/tr",
    "/ads/",
    "adserver"
  ];
  if (blockedPatterns.some((pat) => lower.includes(pat))) return false;
  if (lowerAlt.includes("avatar") || lowerAlt.includes("logo") || lowerAlt.includes("icon") || lowerClass.includes("avatar") || lowerClass.includes("logo") || lowerClass.includes("icon")) {
    return false;
  }
  return true;
}
function pickBestSrcsetUrl(srcset) {
  if (!srcset) return null;
  const candidates = srcset.split(",").map((entry) => entry.trim().split(/\s+/)).filter((parts) => Boolean(parts[0])).map((parts) => {
    const descriptor = (parts[1] ?? "").toLowerCase();
    let weight = 0;
    if (descriptor.endsWith("w")) {
      weight = parseInt(descriptor, 10) || 0;
    } else if (descriptor.endsWith("x")) {
      weight = Math.round((parseFloat(descriptor) || 1) * 1e3);
    }
    return { url: parts[0], weight };
  }).sort((a, b) => b.weight - a.weight);
  if (!candidates[0]) return null;
  return { url: candidates[0].url, maxWidth: candidates[0].weight };
}
function extractSpacedText($, $root) {
  const parts = [];
  const visit = (node) => {
    const n = node;
    if (!n) return;
    if (n.type === "text") {
      const txt = (n.data ?? "").replace(/\s+/g, " ");
      if (txt.trim()) {
        parts.push(txt.trim());
      }
      return;
    }
    if (n.type === "tag") {
      const tag = (n.tagName ?? "").toLowerCase();
      if (tag === "script" || tag === "style" || tag === "svg" || tag === "button" || tag === "input") {
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
  return parts.join(" ").replace(/\s+([,.;:!?)\]])/g, "$1").replace(/([(\[])\s+/g, "$1").replace(/\s+/g, " ").trim();
}
function formatIsoDuration(iso) {
  if (!iso || typeof iso !== "string") return "";
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return iso;
  const h = match[1] ? `${match[1]} h` : "";
  const m = match[2] ? `${match[2]} min` : "";
  const s = match[3] ? `${match[3]} s` : "";
  return [h, m, s].filter(Boolean).join(" ") || iso;
}
function extractInstructionTexts(instructions) {
  if (!instructions) return [];
  if (typeof instructions === "string") {
    return instructions.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(instructions)) {
    const out = [];
    for (const item of instructions) {
      if (typeof item === "string") {
        if (item.trim()) out.push(item.trim());
      } else if (item && typeof item === "object") {
        const obj = item;
        if (typeof obj.text === "string" && obj.text.trim()) {
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
function findRecipeInJsonLd(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecipeInJsonLd(item);
      if (found) return found;
    }
    return null;
  }
  const obj = node;
  const rawType = obj["@type"];
  const types = Array.isArray(rawType) ? rawType : [rawType];
  if (types.some((t) => typeof t === "string" && t.toLowerCase() === "recipe")) {
    return obj;
  }
  if (obj["@graph"]) {
    return findRecipeInJsonLd(obj["@graph"]);
  }
  return null;
}
function extractStructuredRecipe($) {
  const scripts = $('script[type="application/ld+json"]').toArray();
  for (const script of scripts) {
    const raw = $(script).html()?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const recipe = findRecipeInJsonLd(parsed);
      if (!recipe) continue;
      const lines = ["[STRUCTURED RECIPE DATA FROM SOURCE]"];
      const blocks = [];
      const metaParts = [];
      if (typeof recipe.name === "string" && recipe.name.trim()) {
        lines.push(`Recipe Name: ${recipe.name.trim()}`);
        blocks.push({ type: "h2", text: recipe.name.trim(), keepTogether: true });
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
        blocks.push({ type: "p", text: metaParts.join(" \xB7 "), keepTogether: true });
      }
      if (Array.isArray(recipe.recipeIngredient) && recipe.recipeIngredient.length > 0) {
        const ingItems = recipe.recipeIngredient.map((i) => String(i).trim()).filter(Boolean);
        if (ingItems.length > 0) {
          lines.push("Ingredients:");
          ingItems.forEach((ing) => lines.push(`- ${ing}`));
          blocks.push({ type: "h3", text: "Ingredients", keepTogether: true });
          blocks.push({ type: "ul", items: ingItems, keepTogether: true });
        }
      }
      const steps = extractInstructionTexts(recipe.recipeInstructions);
      if (steps.length > 0) {
        lines.push("Instructions:");
        steps.forEach((step, idx) => lines.push(`${idx + 1}. ${step}`));
        blocks.push({ type: "h3", text: "Instructions", keepTogether: true });
        blocks.push({ type: "ol", items: steps, keepTogether: true });
      }
      if (lines.length > 2) {
        return { textSummary: lines.join("\n"), blocks };
      }
    } catch {
    }
  }
  return null;
}
function resolveContentImage($, $img, pageUrl, fallbackTitle) {
  const widthAttr = parseInt($img.attr("width") ?? "", 10);
  const heightAttr = parseInt($img.attr("height") ?? "", 10);
  const className = $img.attr("class") ?? "";
  const srcsetBest = pickBestSrcsetUrl($img.attr("data-srcset") || $img.attr("srcset"));
  const lazyOrSrc = $img.attr("data-original") || $img.attr("data-lazy-src") || $img.attr("data-src") || $img.attr("src");
  const chosenRaw = srcsetBest && srcsetBest.maxWidth >= 400 ? srcsetBest.url : lazyOrSrc || srcsetBest?.url;
  if (!chosenRaw) return null;
  const upgradeableWp = hasWpSizeSuffix(chosenRaw);
  const srcsetHasLarge = Boolean(srcsetBest && srcsetBest.maxWidth >= 150);
  if (!srcsetHasLarge && !upgradeableWp) {
    if (widthAttr > 0 && widthAttr < 120 || heightAttr > 0 && heightAttr < 120) {
      return null;
    }
  }
  if (srcsetBest && srcsetBest.maxWidth > 0 && srcsetBest.maxWidth < 120 && !upgradeableWp) {
    return null;
  }
  try {
    const resolved = new URL(chosenRaw.trim(), pageUrl).toString();
    const upgraded = upgradeToHighResUrl(resolved);
    const alt = ($img.attr("alt") || $img.attr("title") || fallbackTitle).trim() || fallbackTitle;
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
function isRecipeHeadingText(text) {
  const lower = text.toLowerCase();
  if (/(ingredient|surovin|ingredienc|přísad|prisad|zutaten|ingrédient|co budete potřebovat)/i.test(lower)) {
    return "ingredients";
  }
  if (/(instruction|method|direction|postup|příprav|priprav|jak na to|zubereitung|préparation)/i.test(lower)) {
    return "instructions";
  }
  return null;
}
function markRecipeKeepTogether(blocks) {
  let ingredientsStart = -1;
  let instructionsHeading = -1;
  let instructionsEnd = -1;
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (b.keepTogether) {
      return true;
    }
    if (b.type === "h2" || b.type === "h3") {
      const kind = isRecipeHeadingText(b.text ?? "");
      if (kind === "ingredients" && ingredientsStart === -1) {
        ingredientsStart = i;
      } else if (kind === "instructions" && ingredientsStart !== -1 && instructionsHeading === -1) {
        instructionsHeading = i;
        let j = i + 1;
        while (j < blocks.length && blocks[j].type !== "h2") {
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
var RECIPE_PLUGIN_CARD_SELECTOR = ".wprm-recipe-container, .wprm-recipe, .tasty-recipes, .tasty-recipe-card, .mv-create-card";
function extractRecipePluginBlocks($, $card, pageUrl, fallbackTitle, onImage) {
  const blocks = [];
  const titleEl = $card.find(".wprm-recipe-name, .tasty-recipes-title, .mv-create-title, h2, h3").first();
  const recipeTitle = titleEl.text().replace(/\s+/g, " ").trim();
  if (recipeTitle) {
    blocks.push({ type: "h2", text: recipeTitle, keepTogether: true });
  }
  const cardImg = $card.find(".wprm-recipe-image img, .tasty-recipes-image img, .mv-create-image img, .mv-create-pin-button img").first();
  if (cardImg.length) {
    const resolved = resolveContentImage($, cardImg, pageUrl, recipeTitle || fallbackTitle);
    if (resolved) {
      onImage(resolved);
      blocks.push({
        type: "img",
        imageUrl: resolved.url,
        alt: resolved.alt
      });
    }
  }
  const summaryText = $card.find(".wprm-recipe-summary, .tasty-recipes-description, .mv-create-description").first().text().replace(/\s+/g, " ").trim();
  if (summaryText) {
    blocks.push({ type: "p", text: summaryText, keepTogether: true });
  }
  const detailsParts = [];
  $card.find(
    ".wprm-recipe-time-container, .wprm-recipe-servings-container, .tasty-recipes-details li, .mv-create-time-item"
  ).each((_, el) => {
    const txt = extractSpacedText($, $(el));
    if (txt && txt.length <= 80 && !detailsParts.includes(txt)) {
      detailsParts.push(txt);
    }
  });
  if (detailsParts.length > 0) {
    blocks.push({ type: "p", text: detailsParts.join(" \xB7 "), keepTogether: true });
  }
  const $ingContainer = $card.find(".wprm-recipe-ingredients-container, .tasty-recipes-ingredients, .tasty-recipe-ingredients, .mv-create-ingredients").first();
  if ($ingContainer.length) {
    const ingHeading = $ingContainer.find(".wprm-recipe-ingredients-header, h2, h3").first().text().replace(/\s+/g, " ").trim() || "Ingredients";
    blocks.push({ type: "h3", text: ingHeading, keepTogether: true });
    const $groups = $ingContainer.find(".wprm-recipe-ingredient-group, .mv-create-ingredients-group");
    if ($groups.length > 0) {
      $groups.each((_, grp) => {
        const $grp = $(grp);
        const grpTitle = $grp.find(".wprm-recipe-group-name, h4").first().text().replace(/\s+/g, " ").trim();
        if (grpTitle) {
          blocks.push({ type: "h3", text: grpTitle, keepTogether: true });
        }
        const items = [];
        $grp.find("li").each((__, li) => {
          const itemTxt = extractSpacedText($, $(li));
          if (itemTxt) items.push(itemTxt);
        });
        if (items.length > 0) {
          blocks.push({ type: "ul", items, keepTogether: true });
        }
      });
    } else {
      const items = [];
      $ingContainer.find("li").each((_, li) => {
        const itemTxt = extractSpacedText($, $(li));
        if (itemTxt) items.push(itemTxt);
      });
      if (items.length === 0) {
        $ingContainer.find("p").each((_, pEl) => {
          const itemTxt = extractSpacedText($, $(pEl));
          if (itemTxt) items.push(itemTxt);
        });
      }
      if (items.length > 0) {
        blocks.push({ type: "ul", items, keepTogether: true });
      }
    }
  }
  const $instContainer = $card.find(
    ".wprm-recipe-instructions-container, .tasty-recipes-instructions, .tasty-recipe-instructions, .mv-create-instructions"
  ).first();
  if ($instContainer.length) {
    const instHeading = $instContainer.find(".wprm-recipe-instructions-header, h2, h3").first().text().replace(/\s+/g, " ").trim() || "Instructions";
    blocks.push({ type: "h3", text: instHeading, keepTogether: true });
    const $groups = $instContainer.find(".wprm-recipe-instruction-group, .mv-create-instructions-group");
    const processInstructionScope = ($scope) => {
      const items = [];
      const stepImgs = [];
      $scope.find("li").each((_, li) => {
        const $li = $(li);
        $li.find("img").each((__, imgEl) => {
          const resolved = resolveContentImage($, $(imgEl), pageUrl, recipeTitle || fallbackTitle);
          if (resolved) stepImgs.push(resolved);
        });
        const $textEl = $li.find(".wprm-recipe-instruction-text").first();
        const stepTxt = extractSpacedText($, $textEl.length ? $textEl : $li);
        if (stepTxt) items.push(stepTxt);
      });
      if (items.length === 0) {
        $scope.find("p").each((_, pEl) => {
          const stepTxt = extractSpacedText($, $(pEl));
          if (stepTxt) items.push(stepTxt);
        });
      }
      if (items.length > 0) {
        blocks.push({ type: "ol", items, keepTogether: true });
      }
      for (const img of stepImgs) {
        onImage(img);
        blocks.push({ type: "img", imageUrl: img.url, alt: img.alt });
      }
    };
    if ($groups.length > 0) {
      $groups.each((_, grp) => {
        const $grp = $(grp);
        const grpTitle = $grp.find(".wprm-recipe-group-name, h4").first().text().replace(/\s+/g, " ").trim();
        if (grpTitle) {
          blocks.push({ type: "h3", text: grpTitle, keepTogether: true });
        }
        processInstructionScope($grp);
      });
    } else {
      processInstructionScope($instContainer);
    }
  }
  const $notes = $card.find(".wprm-recipe-notes-container, .tasty-recipes-notes, .mv-create-notes").first();
  if ($notes.length) {
    const notesHeading = $notes.find("h2, h3, h4").first().text().replace(/\s+/g, " ").trim();
    const notesBody = $notes.find(".wprm-recipe-notes, p").map((_, p) => $(p).text().replace(/\s+/g, " ").trim()).get().filter(Boolean);
    if (notesBody.length > 0) {
      if (notesHeading) blocks.push({ type: "h3", text: notesHeading });
      for (const line of notesBody) {
        blocks.push({ type: "p", text: line });
      }
    }
  }
  return blocks;
}
function getCurrentPageNumber(parsed, fallbackPageNum) {
  const qPage = parsed.searchParams.get("page") || parsed.searchParams.get("paged");
  if (qPage && /^\d+$/.test(qPage)) {
    return parseInt(qPage, 10);
  }
  const pathMatch = parsed.pathname.match(/\/(\d+)\/?$/);
  if (pathMatch) {
    return parseInt(pathMatch[1], 10);
  }
  return fallbackPageNum;
}
function normalizeBasePath(pathname) {
  return pathname.replace(/\/\d+\/?$/, "").replace(/\/+$/, "");
}
function findNextPageUrl($, pageUrl, currentPageNum) {
  let currentParsed;
  try {
    currentParsed = new URL(pageUrl);
  } catch {
    return null;
  }
  const origin = currentParsed.origin;
  const nextNum = currentPageNum + 1;
  const basePath = normalizeBasePath(currentParsed.pathname);
  const isValidNextCandidate = (href) => {
    if (!href) return null;
    const trimmed = href.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("javascript:")) return null;
    try {
      const candidate = new URL(trimmed, pageUrl);
      if (candidate.origin !== origin) return null;
      candidate.hash = "";
      if (candidate.toString() === currentParsed.toString()) return null;
      return candidate.toString();
    } catch {
      return null;
    }
  };
  const relNext = isValidNextCandidate(
    $('link[rel="next"]').attr("href") || $('a[rel="next"]').attr("href")
  );
  if (relNext) return relNext;
  const paginationLinks = $(
    '.page-links a, .post-nav-links a, .pagination a, .nav-links a, .pager a, .page-numbers a, nav[aria-label*="page" i] a, a.next, a.next-page, a[class*="next"]'
  ).toArray();
  for (const el of paginationLinks) {
    const $el = $(el);
    const candidate = isValidNextCandidate($el.attr("href"));
    if (!candidate) continue;
    const rawText = $el.text().replace(/\s+/g, " ").trim().toLowerCase();
    const cleanText = rawText.replace(/[›»→>]+/g, "").trim();
    const aria = ($el.attr("aria-label") || $el.attr("title") || "").toLowerCase();
    const cls = ($el.attr("class") || "").toLowerCase();
    const matchesNextLabel = cleanText === "next" || cleanText === "next page" || cleanText === "dal\u0161\xED" || cleanText === "dal\u0161\xED strana" || cleanText === "pokra\u010Dovat" || cleanText === "weiter" || cleanText === "suivant" || cleanText === "siguiente" || rawText === "\u2192" || rawText === "\xBB" || rawText === "\u203A" || rawText === String(nextNum) || cleanText === `page ${nextNum}` || cleanText === `strana ${nextNum}` || /\bnext\b|next-page|next_page/.test(cls) || /\b(next|další|weiter|suivant|siguiente)\b/.test(aria);
    if (matchesNextLabel) {
      return candidate;
    }
  }
  const allAnchors = $("article a, main a, .entry-content a, .post-content a, .page-links a, .pagination a").toArray();
  for (const el of allAnchors) {
    const href = $(el).attr("href");
    const candidate = isValidNextCandidate(href);
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      const qPage = parsed.searchParams.get("page") || parsed.searchParams.get("paged");
      if (qPage === String(nextNum) && normalizeBasePath(parsed.pathname) === basePath) {
        return candidate;
      }
      const candBase = normalizeBasePath(parsed.pathname);
      const candMatch = parsed.pathname.match(/\/(\d+)\/?$/);
      if (candMatch && candMatch[1] === String(nextNum) && candBase === basePath) {
        return candidate;
      }
    } catch {
    }
  }
  return null;
}
function selectMainContentContainer($) {
  const candidateSelectors = [
    '[itemprop="articleBody"]',
    ".entry-content",
    ".post-content",
    ".article-content",
    ".article-body",
    ".story-body",
    "article",
    "main article",
    "main"
  ];
  let bestEl = null;
  let bestScore = -1;
  for (const sel of candidateSelectors) {
    const $matched = $(sel).first();
    if (!$matched.length) continue;
    const textLen = $matched.text().replace(/\s+/g, " ").trim().length;
    if (textLen === 0) continue;
    const blockCount = $matched.find("p, h2, h3, ul, ol").length;
    const isSpecific = sel !== "main" && sel !== "article";
    const score = textLen + blockCount * 35 + (isSpecific ? 150 : 0);
    if (score > bestScore) {
      bestScore = score;
      bestEl = $matched;
    }
  }
  if (bestEl && bestEl.text().replace(/\s+/g, " ").trim().length > 40) {
    return bestEl;
  }
  return $("body").first();
}
function extractPageData(html, pageUrl, currentPageNum) {
  const $ = cheerio2.load(html);
  const ogTitle = $('meta[property="og:title"]').attr("content")?.trim() ?? "";
  const h1Title = $("h1").first().text().trim();
  const docTitle = $("title").text().trim();
  const title = ogTitle || h1Title || docTitle || "Untitled Article";
  const rawDescription = $('meta[property="og:description"]').attr("content")?.trim() || $('meta[name="description"]').attr("content")?.trim() || "";
  const cleanedDescription = stripSourceUrlsFromText(rawDescription, pageUrl);
  const description = isPaginationText(cleanedDescription) || isSourceAttributionText(cleanedDescription) ? "" : cleanedDescription;
  const structuredRecipe = extractStructuredRecipe($);
  const images = [];
  const imageIndexByUrl = /* @__PURE__ */ new Map();
  const pushImage = (rawUrl, alt, sourceOrigin, estimatedSize = 0, caption) => {
    if (!rawUrl) return;
    try {
      const resolved = new URL(rawUrl.trim(), pageUrl).toString();
      const upgraded = upgradeToHighResUrl(resolved);
      if (!isLikelyUsefulImage(upgraded, alt)) return;
      const existingIdx = imageIndexByUrl.get(upgraded);
      if (existingIdx !== void 0) {
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
        isFeatured: images.length === 0
      });
    } catch {
    }
  };
  pushImage($('meta[property="og:image:secure_url"]').attr("content"), title, "og", 0);
  pushImage($('meta[property="og:image"]').attr("content"), title, "og", 0);
  pushImage($('meta[name="twitter:image"]').attr("content"), title, "twitter", 0);
  pushImage($('meta[property="twitter:image"]').attr("content"), title, "twitter", 0);
  pushImage($('meta[name="twitter:image:src"]').attr("content"), title, "twitter", 0);
  const nextPageUrl = findNextPageUrl($, pageUrl, currentPageNum);
  removeNoiseSafely($);
  const container = selectMainContentContainer($);
  container.find(PAGINATION_CONTAINER_SELECTOR).remove();
  stripSourceLinksInCheerio($, container, pageUrl);
  const structuredBlocks = [];
  const seenInlineImages = /* @__PURE__ */ new Set();
  const extractedRecipeNodes = /* @__PURE__ */ new Set();
  let lastBlockSignature = "";
  let extractedPluginRecipe = false;
  const pushUniqueBlock = (block) => {
    let normalizedBlock = block;
    if (block.type === "source") {
      return;
    }
    if (block.type === "ul" || block.type === "ol") {
      const cleanedItems = (block.items ?? []).map((item) => stripSourceUrlsFromText(item, pageUrl)).filter((item) => item.length > 0 && !isPaginationText(item) && !isSourceAttributionText(item));
      if (cleanedItems.length === 0) return;
      normalizedBlock = { ...block, items: cleanedItems };
    } else if (block.type !== "img" && block.text) {
      const cleanedText = stripSourceUrlsFromText(block.text, pageUrl);
      if (!cleanedText || isPaginationText(cleanedText) || isSourceAttributionText(cleanedText)) {
        return;
      }
      normalizedBlock = { ...block, text: cleanedText };
    }
    const sig = normalizedBlock.type === "ul" || normalizedBlock.type === "ol" ? `${normalizedBlock.type}:${(normalizedBlock.items ?? []).join("|")}` : normalizedBlock.type === "img" ? `img:${normalizedBlock.imageUrl ?? ""}` : `${normalizedBlock.type}:${normalizedBlock.text ?? ""}`;
    if (sig === lastBlockSignature) return;
    lastBlockSignature = sig;
    structuredBlocks.push(normalizedBlock);
  };
  const pushInlineImageBlock = (resolved, caption, skipBlockEmit = false) => {
    pushImage(resolved.url, resolved.alt, "content", resolved.estimatedSize, caption);
    if (!skipBlockEmit && !seenInlineImages.has(resolved.url)) {
      seenInlineImages.add(resolved.url);
      pushUniqueBlock({
        type: "img",
        imageUrl: resolved.url,
        alt: resolved.alt,
        caption
      });
    }
  };
  const walkElement = ($el) => {
    const rawNode = $el.get(0);
    if (!rawNode) return;
    const tag = String($el.prop("tagName") ?? "").toLowerCase();
    if (!tag) return;
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "iframe" || tag === "svg" || tag === "button" || tag === "nav" || tag === "footer" || tag === "aside" || tag === "form") {
      return;
    }
    if ($el.is(RECIPE_PLUGIN_CARD_SELECTOR)) {
      if (extractedRecipeNodes.has(rawNode)) return;
      extractedRecipeNodes.add(rawNode);
      const recipeBlocks = extractRecipePluginBlocks($, $el, pageUrl, title, (resolved, cap) => {
        pushImage(resolved.url, resolved.alt, "content", resolved.estimatedSize, cap);
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
    if (tag === "h1") {
      const text2 = $el.text().replace(/\s+/g, " ").trim();
      if (!text2 || text2.length < 2) return;
      if (text2.toLowerCase() === title.trim().toLowerCase()) return;
      pushUniqueBlock({ type: "h2", text: text2 });
      return;
    }
    if (tag === "h2") {
      const text2 = $el.text().replace(/\s+/g, " ").trim();
      if (text2.length >= 2) {
        pushUniqueBlock({ type: "h2", text: text2 });
      }
      return;
    }
    if (tag === "h3" || tag === "h4") {
      const text2 = $el.text().replace(/\s+/g, " ").trim();
      if (text2.length >= 2) {
        pushUniqueBlock({ type: "h3", text: text2 });
      }
      return;
    }
    if (tag === "ul" || tag === "ol") {
      const listType = tag;
      const directLis = $el.children("li").toArray();
      const liNodes = directLis.length > 0 ? directLis : $el.find("li").toArray();
      const items = [];
      const stepImages = [];
      for (const li of liNodes) {
        const $li = $(li);
        $li.find("img").each((_, imgEl) => {
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
    if (tag === "figure") {
      const caption = $el.find("figcaption").first().text().replace(/\s+/g, " ").trim() || void 0;
      $el.find("img").each((_, imgEl) => {
        const resolved = resolveContentImage($, $(imgEl), pageUrl, title);
        if (resolved) {
          pushInlineImageBlock(resolved, caption);
        }
      });
      return;
    }
    if (tag === "img") {
      const resolved = resolveContentImage($, $el, pageUrl, title);
      if (resolved) {
        pushInlineImageBlock(resolved);
      }
      return;
    }
    if (tag === "p" || tag === "blockquote") {
      $el.find("img").each((_, imgEl) => {
        const resolved = resolveContentImage($, $(imgEl), pageUrl, title);
        if (resolved) {
          pushInlineImageBlock(resolved);
        }
      });
      const text2 = $el.text().replace(/\s+/g, " ").trim();
      if (text2.length >= 2) {
        pushUniqueBlock({ type: "p", text: text2 });
      }
      return;
    }
    const hasBlockChildren = $el.find("h1, h2, h3, h4, p, ul, ol, figure, img, blockquote, div, section, article").length > 0;
    if (hasBlockChildren) {
      $el.children().each((_, child) => {
        walkElement($(child));
      });
      return;
    }
    const text = $el.text().replace(/\s+/g, " ").trim();
    if (text.length >= 12) {
      pushUniqueBlock({ type: "p", text });
    }
  };
  container.children().each((_, child) => {
    walkElement($(child));
  });
  $(RECIPE_PLUGIN_CARD_SELECTOR).each((_, cardEl) => {
    if (extractedRecipeNodes.has(cardEl)) return;
    const $card = $(cardEl);
    if ($card.parents(RECIPE_PLUGIN_CARD_SELECTOR).toArray().some((p) => extractedRecipeNodes.has(p))) {
      return;
    }
    extractedRecipeNodes.add(cardEl);
    const recipeBlocks = extractRecipePluginBlocks($, $card, pageUrl, title, (resolved, cap) => {
      pushImage(resolved.url, resolved.alt, "content", resolved.estimatedSize, cap);
      seenInlineImages.add(resolved.url);
    });
    if (recipeBlocks.length > 0) {
      extractedPluginRecipe = true;
      for (const rb of recipeBlocks) {
        pushUniqueBlock(rb);
      }
    }
  });
  container.find("img").each((_, el) => {
    const resolved = resolveContentImage($, $(el), pageUrl, title);
    if (resolved) {
      pushImage(resolved.url, resolved.alt, "content", resolved.estimatedSize);
    }
  });
  const paragraphs = [];
  if (structuredRecipe) {
    paragraphs.push(structuredRecipe.textSummary);
  }
  const seenParagraphs = /* @__PURE__ */ new Set();
  container.find("h1, h2, h3, h4, p, li, blockquote").each((_, el) => {
    const $el = $(el);
    if ($el.closest(PAGINATION_CONTAINER_SELECTOR).length > 0) return;
    const tag = el.tagName?.toLowerCase() ?? "p";
    const rawText = $el.text().replace(/\s+/g, " ").trim();
    const text = stripSourceUrlsFromText(rawText, pageUrl);
    if (text.length < 10 && !tag.startsWith("h") && tag !== "li") return;
    if (text.length < 3) return;
    if (isPaginationText(text) || isSourceAttributionText(text)) return;
    if (!seenParagraphs.has(text)) {
      seenParagraphs.add(text);
      paragraphs.push(tag.startsWith("h") ? `[${tag.toUpperCase()}] ${text}` : text);
    }
  });
  if (paragraphs.length === 0) {
    const fallbackText = stripSourceUrlsFromText(container.text().replace(/\s+/g, " ").trim(), pageUrl);
    if (fallbackText.length > 20 && !isPaginationText(fallbackText) && !isSourceAttributionText(fallbackText)) {
      paragraphs.push(fallbackText);
    }
  }
  if (structuredBlocks.filter((b) => b.type !== "img").length === 0 && paragraphs.length > 0) {
    for (const p of paragraphs) {
      if (p.startsWith("[STRUCTURED RECIPE DATA")) continue;
      if (p.startsWith("[H2] ")) {
        structuredBlocks.push({ type: "h2", text: p.slice(5).trim() });
      } else if (p.startsWith("[H3] ") || p.startsWith("[H4] ")) {
        structuredBlocks.push({ type: "h3", text: p.slice(5).trim() });
      } else if (!p.startsWith("[H1] ")) {
        structuredBlocks.push({ type: "p", text: p });
      }
    }
  }
  const detectedHtmlRecipe = markRecipeKeepTogether(structuredBlocks);
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
    nextPageUrl
  };
}
function countWordsInBlocks(blocks) {
  let words = 0;
  for (const b of blocks) {
    if (b.type === "img" || b.type === "source") continue;
    const text = b.type === "ul" || b.type === "ol" ? (b.items ?? []).join(" ") : b.text ?? "";
    const trimmed = text.trim();
    if (trimmed) {
      words += trimmed.split(/\s+/).filter(Boolean).length;
    }
  }
  return words;
}
async function scrapeArticle(inputUrl) {
  const decoded = decodeSourceUrl(inputUrl);
  const visited = /* @__PURE__ */ new Set();
  const allParagraphs = [];
  const allStructuredBlocks = [];
  const allImages = [];
  const imageIndexByUrl = /* @__PURE__ */ new Map();
  let currentUrl = decoded.resolvedUrl;
  let mainTitle = "";
  let mainDescription = "";
  let hasRecipeData = false;
  let pagesFetched = 0;
  while (currentUrl && pagesFetched < 15 && !visited.has(currentUrl)) {
    visited.add(currentUrl);
    const { response, finalUrl } = await safeFetch(currentUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,cs;q=0.8"
      },
      timeoutMs: 2e4
    });
    if (!response.ok) {
      if (pagesFetched === 0) {
        throw new Error(`Could not fetch the article (website returned HTTP ${response.status}).`);
      }
      break;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      if (pagesFetched === 0) {
        throw new Error("The URL did not return a readable HTML article page.");
      }
      break;
    }
    const html = await response.text();
    let currentPageNum = pagesFetched + 1;
    try {
      currentPageNum = getCurrentPageNumber(new URL(finalUrl), pagesFetched + 1);
    } catch {
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
      if (existingIdx !== void 0) {
        const existing = allImages[existingIdx];
        if (img.estimatedSize > existing.estimatedSize) {
          existing.estimatedSize = img.estimatedSize;
        }
        if (img.sourceOrigin === "og") {
          existing.sourceOrigin = "og";
        }
        continue;
      }
      if (allImages.length < 50) {
        imageIndexByUrl.set(img.url, allImages.length);
        allImages.push({ ...img, isFeatured: false });
      }
    }
    pagesFetched += 1;
    currentUrl = extracted.nextPageUrl && !visited.has(extracted.nextPageUrl) ? extracted.nextPageUrl : null;
  }
  if (allImages.length > 0) {
    let featuredIdx = allImages.findIndex((img) => img.sourceOrigin === "og");
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
  const textContent = allParagraphs.join("\n\n").trim();
  const blockWords = countWordsInBlocks(allStructuredBlocks);
  const textWords = textContent ? textContent.split(/\s+/).filter(Boolean).length : 0;
  const wordCount = blockWords > 0 ? blockWords : textWords;
  if (textContent.length < 20 && wordCount === 0) {
    throw new Error(
      "Unable to extract readable article text from that URL. The site may block automated reading or require JavaScript rendering."
    );
  }
  return {
    originalUrl: decoded.originalUrl,
    resolvedUrl: decoded.resolvedUrl,
    wasFacebookRedirect: decoded.wasFacebookRedirect,
    title: mainTitle,
    description: mainDescription,
    textContent: textContent.slice(0, 28e3),
    wordCount,
    extractionIncomplete: wordCount < 200,
    structuredBlocks: allStructuredBlocks,
    hasRecipeData,
    pagesFetched,
    images: allImages
  };
}

// server/lib/wordpress.ts
function normalizeSiteUrl(rawUrl) {
  const parsed = new URL(rawUrl.trim());
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}
function buildAuthHeader(username, appPassword) {
  const token = Buffer.from(`${username}:${appPassword}`, "utf8").toString("base64");
  return `Basic ${token}`;
}
async function testWordPressConnection(site) {
  try {
    const baseUrl = normalizeSiteUrl(site.url);
    const endpoint = `${baseUrl}/wp-json/wp/v2/users/me?context=edit`;
    const { response } = await safeFetch(endpoint, {
      headers: {
        Authorization: buildAuthHeader(site.username, site.appPassword),
        Accept: "application/json"
      },
      timeoutMs: 15e3
    });
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        message: "Authentication failed. Check your WordPress username and Application Password."
      };
    }
    if (response.status === 404) {
      return {
        ok: false,
        message: "WordPress REST API (/wp-json/wp/v2) was not found at this URL."
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        message: `WordPress returned HTTP ${response.status}.`
      };
    }
    const user = await response.json();
    const displayName = user.name || user.slug || site.username;
    return {
      ok: true,
      wpUser: displayName,
      message: `Connected to ${new URL(baseUrl).hostname} as ${displayName}.`
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Unable to reach WordPress site."
    };
  }
}
async function uploadImageToWordPress(site, image, slugPrefix, index) {
  const baseUrl = normalizeSiteUrl(site.url);
  let contentType = "image/jpeg";
  let buffer;
  const dataUrlMatch = image.sourceUrl.match(/^data:(image\/(?:jpeg|jpg|png|webp|gif|avif));base64,([A-Za-z0-9+/=]+)$/i);
  if (dataUrlMatch) {
    contentType = dataUrlMatch[1].toLowerCase();
    buffer = Buffer.from(dataUrlMatch[2], "base64");
  } else {
    const { response: imgRes } = await safeFetch(image.sourceUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; S7wariEditorial/1.0)",
        Accept: "image/*,*/*;q=0.8"
      },
      timeoutMs: 2e4
    });
    if (!imgRes.ok) {
      throw new Error(`Image download failed (HTTP ${imgRes.status}).`);
    }
    contentType = (imgRes.headers.get("content-type") || "image/jpeg").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) {
      throw new Error(`Source did not return an image (${contentType}).`);
    }
    const arrayBuffer = await imgRes.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
  }
  if (buffer.byteLength === 0) {
    throw new Error("Image data was empty.");
  }
  if (buffer.byteLength > 10 * 1024 * 1024) {
    throw new Error("Image exceeds 10MB upload limit.");
  }
  const extMap = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif"
  };
  const ext = extMap[contentType] ?? "jpg";
  const safeSlug = slugPrefix.replace(/[^a-z0-9-]/gi, "-").slice(0, 40) || "article";
  const filename = `${safeSlug}-${index + 1}.${ext}`;
  const { response: uploadRes } = await safeFetch(`${baseUrl}/wp-json/wp/v2/media`, {
    method: "POST",
    headers: {
      Authorization: buildAuthHeader(site.username, site.appPassword),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": contentType,
      Accept: "application/json"
    },
    body: new Uint8Array(buffer),
    timeoutMs: 3e4
  });
  if (!uploadRes.ok) {
    const text = await uploadRes.text();
    throw new Error(`WordPress Media upload failed (${uploadRes.status}): ${text.slice(0, 180)}`);
  }
  const uploaded = await uploadRes.json();
  if (image.alt) {
    try {
      await safeFetch(`${baseUrl}/wp-json/wp/v2/media/${uploaded.id}`, {
        method: "POST",
        headers: {
          Authorization: buildAuthHeader(site.username, site.appPassword),
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({ alt_text: image.alt }),
        timeoutMs: 1e4
      });
    } catch {
    }
  }
  return { id: uploaded.id, sourceUrl: uploaded.source_url };
}
async function resolveOrCreateTerm(site, taxonomy, name) {
  const cleanName = name.trim();
  if (!cleanName) return null;
  const baseUrl = normalizeSiteUrl(site.url);
  const authHeader = buildAuthHeader(site.username, site.appPassword);
  try {
    const searchUrl = `${baseUrl}/wp-json/wp/v2/${taxonomy}?search=${encodeURIComponent(cleanName)}&per_page=5`;
    const { response: searchRes } = await safeFetch(searchUrl, {
      headers: { Authorization: authHeader, Accept: "application/json" },
      timeoutMs: 1e4
    });
    if (searchRes.ok) {
      const items = await searchRes.json();
      const exact = items.find((item) => item.name.toLowerCase() === cleanName.toLowerCase());
      if (exact) return exact.id;
      if (items[0] && taxonomy === "categories") return items[0].id;
    }
    const { response: createRes } = await safeFetch(`${baseUrl}/wp-json/wp/v2/${taxonomy}`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ name: cleanName }),
      timeoutMs: 1e4
    });
    if (createRes.ok) {
      const created = await createRes.json();
      return created.id;
    }
  } catch {
  }
  return null;
}
async function publishPostToWordPress(site, params) {
  const baseUrl = normalizeSiteUrl(site.url);
  const authHeader = buildAuthHeader(site.username, site.appPassword);
  const categoryId = await resolveOrCreateTerm(site, "categories", params.categoryName);
  const tagIds = [];
  for (const tag of params.tagNames.slice(0, 6)) {
    const id = await resolveOrCreateTerm(site, "tags", tag);
    if (id !== null) tagIds.push(id);
  }
  const bodyPayload = {
    title: params.title,
    content: params.content,
    slug: params.slug,
    excerpt: params.excerpt,
    status: params.status
  };
  if (params.featuredMediaId) {
    bodyPayload.featured_media = params.featuredMediaId;
  }
  if (categoryId !== null) {
    bodyPayload.categories = [categoryId];
  }
  if (tagIds.length > 0) {
    bodyPayload.tags = tagIds;
  }
  const { response } = await safeFetch(`${baseUrl}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(bodyPayload),
    timeoutMs: 25e3
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`WordPress post creation failed (HTTP ${response.status}): ${errText.slice(0, 220)}`);
  }
  const created = await response.json();
  return {
    id: created.id,
    link: created.link,
    status: created.status === "publish" ? "publish" : "draft"
  };
}

// server.ts
dotenv.config();
var PORT = Number(process.env.PORT) || 3e3;
var entryFile = path2.basename(process.argv[1] || "");
var isCompiledEntry = entryFile.endsWith(".mjs") || entryFile.endsWith(".js");
var isProduction = process.env.NODE_ENV === "production" || isCompiledEntry;
var currentDir = path2.dirname(fileURLToPath(import.meta.url));
var ROOT_DIR = fs2.existsSync(path2.resolve(process.cwd(), "package.json")) ? process.cwd() : currentDir;
function sendSse(res, event, data) {
  res.write(`event: ${event}
data: ${JSON.stringify(data)}

`);
}
function escapeHtmlAttr(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function replaceImageUrlsInHtml(html, replacements) {
  let updated = html;
  for (const [oldUrl, newUrl] of replacements.entries()) {
    if (oldUrl && newUrl && oldUrl !== newUrl) {
      updated = updated.split(oldUrl).join(newUrl);
      updated = updated.split(escapeHtmlAttr(oldUrl)).join(escapeHtmlAttr(newUrl));
    }
  }
  return updated;
}
async function startServer() {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: "15mb" }));
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/api/auth/status", async (_req, res) => {
    try {
      const status = await getAuthStatus();
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to load auth status." });
    }
  });
  app.post("/api/auth/setup", async (req, res) => {
    try {
      const { email, password } = req.body;
      const result = await claimInitialOwner(email ?? "", password ?? "");
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Setup failed." });
    }
  });
  app.post("/api/auth/login", async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        res.status(400).json({ error: "Email and password are required." });
        return;
      }
      const session = await authenticateOwner(email, password);
      if (!session) {
        res.status(401).json({ error: "Invalid email or password." });
        return;
      }
      res.json(session);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Login failed." });
    }
  });
  app.post("/api/auth/logout", requireAuth, (req, res) => {
    const token = extractBearerToken(req);
    if (token) revokeSessionToken(token);
    res.json({ ok: true });
  });
  app.put("/api/auth/credentials", requireAuth, async (req, res) => {
    try {
      const { currentPassword, newEmail, newPassword } = req.body;
      if (!currentPassword || !newEmail) {
        res.status(400).json({ error: "Current password and email are required." });
        return;
      }
      const updated = await updateOwnerCredentials(currentPassword, newEmail, newPassword?.trim() || void 0);
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Could not update credentials." });
    }
  });
  app.get("/api/status", requireAuth, async (_req, res) => {
    try {
      const store = await readStore();
      const connectedSites = store.sites.filter((s) => s.lastTestOk).length;
      res.json({
        aiConnected: isAiConfigured(),
        aiModel: PRIMARY_MODEL,
        activeSitesCount: store.sites.length,
        connectedSitesCount: connectedSites,
        wordpressConnected: store.sites.length > 0 && (connectedSites > 0 || store.sites.some((s) => Boolean(s.appPassword))),
        editorialTone: store.settings.editorialTone
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to load workspace status." });
    }
  });
  app.put("/api/settings", requireAuth, async (req, res) => {
    try {
      const { editorialTone } = req.body;
      const allowed = /* @__PURE__ */ new Set(["editorial", "engaging", "informative"]);
      if (!editorialTone || !allowed.has(editorialTone)) {
        res.status(400).json({ error: "Invalid editorial tone." });
        return;
      }
      const saved = await updateStore((draft) => {
        draft.settings.editorialTone = editorialTone;
        return draft.settings;
      });
      res.json(saved);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Could not update settings." });
    }
  });
  app.post("/api/settings/test-ai", requireAuth, async (_req, res) => {
    const result = await testAiConnection();
    res.status(result.ok ? 200 : 502).json(result);
  });
  app.get("/api/sites", requireAuth, async (_req, res) => {
    const store = await readStore();
    res.json({ sites: store.sites.map(toPublicSite) });
  });
  app.post("/api/sites", requireAuth, async (req, res) => {
    try {
      const body = req.body;
      const name = (body.name ?? "").trim();
      const rawUrl = (body.url ?? "").trim();
      const username = (body.username ?? "").trim();
      const appPassword = (body.appPassword ?? "").trim();
      const language = (body.language ?? "English").trim();
      const targetWordsPerPage = Math.min(800, Math.max(150, Number(body.targetWordsPerPage) || 300));
      const minTotalWords = Math.min(3e3, Math.max(300, Number(body.minTotalWords) || 900));
      if (!name || !rawUrl || !username || !appPassword) {
        res.status(400).json({ error: "Site name, URL, username, and Application Password are required." });
        return;
      }
      const parsedUrl = await assertSafeExternalUrl(rawUrl);
      const cleanUrl = parsedUrl.origin + parsedUrl.pathname.replace(/\/+$/, "");
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const site = {
        id: crypto2.randomUUID(),
        name,
        url: cleanUrl,
        username,
        appPassword,
        language,
        targetWordsPerPage,
        minTotalWords,
        createdAt: now,
        updatedAt: now
      };
      await updateStore((draft) => {
        draft.sites.push(site);
      });
      res.status(201).json({ site: toPublicSite(site) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Failed to create destination." });
    }
  });
  app.put("/api/sites/:id", requireAuth, async (req, res) => {
    try {
      const siteId = req.params.id;
      const body = req.body;
      const updated = await updateStore(async (draft) => {
        const idx = draft.sites.findIndex((s) => s.id === siteId);
        if (idx === -1) return null;
        const existing = draft.sites[idx];
        let cleanUrl = existing.url;
        if (body.url && body.url.trim() !== existing.url) {
          const parsedUrl = await assertSafeExternalUrl(body.url.trim());
          cleanUrl = parsedUrl.origin + parsedUrl.pathname.replace(/\/+$/, "");
        }
        const next = {
          ...existing,
          name: body.name?.trim() || existing.name,
          url: cleanUrl,
          username: body.username?.trim() || existing.username,
          appPassword: body.appPassword && body.appPassword.trim() ? body.appPassword.trim() : existing.appPassword,
          language: body.language?.trim() || existing.language,
          targetWordsPerPage: body.targetWordsPerPage ? Math.min(800, Math.max(150, Number(body.targetWordsPerPage))) : existing.targetWordsPerPage,
          minTotalWords: body.minTotalWords ? Math.min(3e3, Math.max(300, Number(body.minTotalWords))) : existing.minTotalWords,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString()
        };
        draft.sites[idx] = next;
        return next;
      });
      if (!updated) {
        res.status(404).json({ error: "WordPress destination not found." });
        return;
      }
      res.json({ site: toPublicSite(updated) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Failed to update destination." });
    }
  });
  app.delete("/api/sites/:id", requireAuth, async (req, res) => {
    const siteId = req.params.id;
    const removed = await updateStore((draft) => {
      const before = draft.sites.length;
      draft.sites = draft.sites.filter((s) => s.id !== siteId);
      return draft.sites.length < before;
    });
    if (!removed) {
      res.status(404).json({ error: "WordPress destination not found." });
      return;
    }
    res.json({ ok: true });
  });
  app.post("/api/sites/test", requireAuth, async (req, res) => {
    try {
      const { siteId, url, username, appPassword } = req.body;
      let creds = null;
      if (siteId) {
        const store = await readStore();
        const saved = store.sites.find((s) => s.id === siteId);
        if (!saved) {
          res.status(404).json({ error: "WordPress destination not found." });
          return;
        }
        creds = {
          url: url?.trim() || saved.url,
          username: username?.trim() || saved.username,
          appPassword: appPassword?.trim() || saved.appPassword
        };
      } else if (url && username && appPassword) {
        creds = { url: url.trim(), username: username.trim(), appPassword: appPassword.trim() };
      }
      if (!creds) {
        res.status(400).json({ error: "Site URL, username, and Application Password are required." });
        return;
      }
      await assertSafeExternalUrl(creds.url);
      const testResult = await testWordPressConnection(creds);
      if (siteId) {
        await updateStore((draft) => {
          const target = draft.sites.find((s) => s.id === siteId);
          if (target) {
            target.lastTestedAt = (/* @__PURE__ */ new Date()).toISOString();
            target.lastTestOk = testResult.ok;
            target.lastTestMessage = testResult.message;
          }
        });
      }
      res.json(testResult);
    } catch (err) {
      res.status(400).json({ ok: false, message: err instanceof Error ? err.message : "Connection test failed." });
    }
  });
  app.post("/api/studio/decode-url", requireAuth, (req, res) => {
    try {
      const { url } = req.body;
      const decoded = decodeSourceUrl(url ?? "");
      res.json(decoded);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Invalid URL." });
    }
  });
  app.post("/api/studio/generate", requireAuth, async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const emitStage = (stage, state, detail) => {
      sendSse(res, "stage", { stage, state, detail });
    };
    try {
      const { url, siteId, aiRewrite } = req.body;
      const useAi = aiRewrite === true;
      if (!url || !siteId) {
        sendSse(res, "error", { message: "Please select a WordPress destination and enter an article URL." });
        res.end();
        return;
      }
      const store = await readStore();
      const site = store.sites.find((s) => s.id === siteId);
      if (!site) {
        sendSse(res, "error", { message: "Selected WordPress destination was not found." });
        res.end();
        return;
      }
      emitStage("fetching", "active", "Decoding URL & reading source article...");
      const scraped = await scrapeArticle(url);
      emitStage(
        "fetching",
        "done",
        scraped.wasFacebookRedirect ? `Facebook link decoded \xB7 ${scraped.pagesFetched} page(s) \xB7 ${scraped.images.length} images found` : `${scraped.pagesFetched} source page(s) \xB7 ${scraped.images.length} images found`
      );
      const siteOrigin = new URL(site.url).origin;
      const now = (/* @__PURE__ */ new Date()).toISOString();
      if (!useAi) {
        emitStage(
          "splitting",
          "active",
          `Splitting original article into ~${site.targetWordsPerPage}-word pages with <!--nextpage-->...`
        );
        const rawPages2 = splitBlocksIntoPages("", scraped.structuredBlocks, site.targetWordsPerPage, 150);
        if (rawPages2.length === 0) {
          rawPages2.push([{ type: "p", text: scraped.textContent.slice(0, 4e3) }]);
        }
        const imagePageMap = /* @__PURE__ */ new Map();
        rawPages2.forEach((blocks, pageIdx) => {
          blocks.forEach((b) => {
            if (b.type === "img" && b.imageUrl && !imagePageMap.has(b.imageUrl)) {
              imagePageMap.set(b.imageUrl, pageIdx + 1);
            }
          });
        });
        const initialImages2 = scraped.images.map((img, i) => ({
          id: `img-${i + 1}`,
          sourceUrl: img.url,
          alt: img.alt || scraped.title,
          caption: img.caption,
          included: true,
          isFeatured: Boolean(img.isFeatured),
          assignedPage: imagePageMap.get(img.url) ?? 1
        }));
        const pages2 = buildArticlePages(rawPages2, [], initialImages2, { preserveInlineOrder: true }).map((p) => {
          const cleanedHtml = cleanPublishedPageHtml(p.html, scraped.resolvedUrl, site.url);
          return {
            ...p,
            html: cleanedHtml,
            plainText: stripHtml(cleanedHtml),
            wordCount: countWords(cleanedHtml)
          };
        });
        const finalWordCount2 = pages2.reduce((acc, p) => acc + p.wordCount, 0);
        const rawSeo = buildCopyModeSeo({
          title: scraped.title,
          description: scraped.description,
          blocks: scraped.structuredBlocks,
          language: site.language,
          hasRecipeData: scraped.hasRecipeData
        });
        const seo = {
          ...rawSeo,
          metaTitle: stripSourceUrlsFromText(rawSeo.metaTitle, scraped.resolvedUrl, site.url) || rawSeo.metaTitle,
          metaDescription: stripSourceUrlsFromText(rawSeo.metaDescription, scraped.resolvedUrl, site.url)
        };
        const previewLink2 = `${siteOrigin}/${seo.slug}`;
        const rawFb = buildCopyModeFacebookPackage({
          title: scraped.title,
          category: seo.category,
          hasRecipeData: scraped.hasRecipeData,
          language: site.language,
          postUrl: previewLink2
        });
        const facebookPackage2 = {
          ...rawFb,
          caption: stripSourceUrlsFromText(rawFb.caption, scraped.resolvedUrl, site.url) || rawFb.caption
        };
        emitStage("splitting", "done", `${pages2.length} pages ready (${finalWordCount2} words \xB7 Copy mode)`);
        const job2 = {
          id: crypto2.randomUUID(),
          mode: "copy",
          siteId: site.id,
          siteName: site.name,
          language: site.language,
          originalInputUrl: scraped.originalUrl,
          resolvedUrl: scraped.resolvedUrl,
          wasFacebookRedirect: scraped.wasFacebookRedirect,
          sourceTitle: scraped.title,
          title: scraped.title,
          intro: "",
          hasRecipeData: scraped.hasRecipeData,
          extractionIncomplete: scraped.extractionIncomplete,
          extractionConfirmed: false,
          pages: pages2,
          totalWords: finalWordCount2,
          images: initialImages2,
          seo,
          facebook: facebookPackage2,
          status: "ready",
          expansionAttempts: 0,
          createdAt: now,
          updatedAt: now
        };
        await updateStore((storeDraft) => {
          storeDraft.jobs.unshift(job2);
          if (storeDraft.jobs.length > 100) {
            storeDraft.jobs = storeDraft.jobs.slice(0, 100);
          }
        });
        sendSse(res, "complete", { job: job2 });
        res.end();
        return;
      }
      emitStage("rewriting", "active", `Rewriting in ${site.language} (${site.minTotalWords}+ words check)...`);
      const { draft, totalWords, expansionAttempts } = await generateRewrittenArticle({
        sourceTitle: scraped.title,
        sourceText: scraped.textContent,
        targetLanguage: site.language,
        minWords: site.minTotalWords,
        targetWordsPerPage: site.targetWordsPerPage,
        editorialTone: store.settings.editorialTone,
        onStatusUpdate: (detail) => emitStage("rewriting", "active", detail)
      });
      emitStage(
        "rewriting",
        "done",
        expansionAttempts > 0 ? `${totalWords} words verified after ${expansionAttempts} expansion pass(es)` : `${totalWords} words verified`
      );
      emitStage("splitting", "active", `Splitting into ~${site.targetWordsPerPage}-word pages with <!--nextpage-->...`);
      const rawPages = splitBlocksIntoPages(draft.intro, draft.blocks, site.targetWordsPerPage, 150);
      const hookInputs = rawPages.map((blocks, idx) => ({
        pageNumber: idx + 1,
        openingText: blocks.slice(0, 2).map((b) => b.text || (b.items ?? []).join(" ")).join(" "),
        isLastPage: idx === rawPages.length - 1
      }));
      const hooks = await generatePageHooks(hookInputs, draft.title, site.language);
      const initialImages = scraped.images.map((img, i) => ({
        id: `img-${i + 1}`,
        sourceUrl: img.url,
        alt: img.alt || draft.title,
        included: true,
        isFeatured: img.isFeatured ?? i === 0,
        assignedPage: 1
      }));
      const distributedImages = distributeImagesAcrossPages(rawPages.length, initialImages);
      const pages = buildArticlePages(rawPages, hooks, distributedImages).map((p) => {
        const cleanedHtml = cleanPublishedPageHtml(p.html, scraped.resolvedUrl, site.url);
        return {
          ...p,
          html: cleanedHtml,
          plainText: stripHtml(cleanedHtml),
          wordCount: countWords(cleanedHtml)
        };
      });
      const finalWordCount = pages.reduce((acc, p) => acc + p.wordCount, 0);
      emitStage("splitting", "done", `${pages.length} pages ready (${finalWordCount} words total)`);
      emitStage("facebook_package", "active", "Preparing SEO metadata & Facebook package...");
      const cleanSeo = {
        ...draft.seo,
        metaTitle: stripSourceUrlsFromText(draft.seo.metaTitle, scraped.resolvedUrl, site.url) || draft.seo.metaTitle,
        metaDescription: stripSourceUrlsFromText(draft.seo.metaDescription, scraped.resolvedUrl, site.url)
      };
      const previewLink = `${siteOrigin}/${cleanSeo.slug}`;
      const facebookPackage = {
        caption: stripSourceUrlsFromText(draft.facebook.caption, scraped.resolvedUrl, site.url) || draft.facebook.caption,
        hashtags: draft.facebook.hashtags.map((h) => h.startsWith("#") ? h : `#${h}`).slice(0, 5),
        postUrl: previewLink
      };
      emitStage("facebook_package", "done", `${facebookPackage.hashtags.length} hashtags & hook caption ready`);
      const job = {
        id: crypto2.randomUUID(),
        mode: "ai",
        siteId: site.id,
        siteName: site.name,
        language: site.language,
        originalInputUrl: scraped.originalUrl,
        resolvedUrl: scraped.resolvedUrl,
        wasFacebookRedirect: scraped.wasFacebookRedirect,
        sourceTitle: scraped.title,
        title: stripSourceUrlsFromText(draft.title, scraped.resolvedUrl, site.url) || draft.title,
        intro: stripSourceUrlsFromText(draft.intro, scraped.resolvedUrl, site.url),
        hasRecipeData: draft.hasRecipeData,
        recipeNotice: draft.recipeNotice || void 0,
        pages,
        totalWords: finalWordCount,
        images: distributedImages,
        seo: cleanSeo,
        facebook: facebookPackage,
        status: "ready",
        expansionAttempts,
        createdAt: now,
        updatedAt: now
      };
      await updateStore((storeDraft) => {
        storeDraft.jobs.unshift(job);
        if (storeDraft.jobs.length > 100) {
          storeDraft.jobs = storeDraft.jobs.slice(0, 100);
        }
      });
      sendSse(res, "complete", { job });
      res.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "An unexpected error occurred during processing.";
      sendSse(res, "error", { message: msg });
      res.end();
    }
  });
  app.post("/api/studio/publish", requireAuth, async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const emitStage = (stage, state, detail) => {
      sendSse(res, "stage", { stage, state, detail });
    };
    try {
      const {
        jobId,
        publishStatus,
        title,
        pages,
        images,
        seo,
        facebook,
        extractionConfirmed
      } = req.body;
      if (!jobId) {
        sendSse(res, "error", { message: "Missing article job ID." });
        res.end();
        return;
      }
      const store = await readStore();
      const existingJob = store.jobs.find((j) => j.id === jobId);
      if (!existingJob) {
        sendSse(res, "error", { message: "Article job not found." });
        res.end();
        return;
      }
      if (existingJob.extractionIncomplete && !extractionConfirmed && !existingJob.extractionConfirmed) {
        sendSse(res, "error", {
          message: "Extraction incomplete (under 200 words). Please review and confirm before publishing."
        });
        res.end();
        return;
      }
      const site = store.sites.find((s) => s.id === existingJob.siteId);
      if (!site) {
        sendSse(res, "error", { message: "Destination WordPress site no longer exists. Check Settings." });
        res.end();
        return;
      }
      const targetStatus = publishStatus === "draft" ? "draft" : "publish";
      const activeTitle = (title ?? existingJob.title).trim() || existingJob.title;
      const activeSeo = seo ?? existingJob.seo;
      const activePages = Array.isArray(pages) && pages.length > 0 ? pages : existingJob.pages;
      const activeImages = Array.isArray(images) ? images : existingJob.images;
      const includedImages = activeImages.filter((img) => img.included);
      emitStage(
        "uploading_images",
        "active",
        includedImages.length > 0 ? `Uploading ${includedImages.length} image(s) to WordPress Media Library...` : "No images selected; preparing post body..."
      );
      const urlReplacements = /* @__PURE__ */ new Map();
      const updatedImages = [];
      let uploadedCount = 0;
      for (let i = 0; i < activeImages.length; i += 1) {
        const img = activeImages[i];
        if (!img.included) {
          updatedImages.push(img);
          continue;
        }
        if (img.wpMediaId && img.wpSourceUrl) {
          urlReplacements.set(img.sourceUrl, img.wpSourceUrl);
          updatedImages.push(img);
          uploadedCount += 1;
          continue;
        }
        try {
          const uploaded = await uploadImageToWordPress(site, img, activeSeo.slug, i);
          urlReplacements.set(img.sourceUrl, uploaded.sourceUrl);
          updatedImages.push({
            ...img,
            wpMediaId: uploaded.id,
            wpSourceUrl: uploaded.sourceUrl,
            uploadError: void 0
          });
          uploadedCount += 1;
        } catch (err) {
          updatedImages.push({
            ...img,
            uploadError: err instanceof Error ? err.message : "Upload failed"
          });
        }
      }
      emitStage(
        "uploading_images",
        "done",
        includedImages.length > 0 ? `${uploadedCount}/${includedImages.length} image(s) uploaded to WordPress Media Library` : "No images attached"
      );
      const isCopyMode = existingJob.mode === "copy";
      const featuredImage = updatedImages.find((img) => img.included && img.isFeatured && img.wpSourceUrl) ?? updatedImages.find((img) => img.included && img.wpSourceUrl);
      const sourceUrlForClean = existingJob.resolvedUrl || existingJob.originalInputUrl;
      const sanitizedSeo = {
        ...activeSeo,
        metaTitle: stripSourceUrlsFromText(activeSeo.metaTitle, sourceUrlForClean, site.url) || activeSeo.metaTitle,
        metaDescription: stripSourceUrlsFromText(activeSeo.metaDescription, sourceUrlForClean, site.url)
      };
      const sanitizedTitle = stripSourceUrlsFromText(activeTitle, sourceUrlForClean, site.url) || activeTitle;
      const finalPages = activePages.map((page) => {
        let html = replaceImageUrlsInHtml(page.html, urlReplacements);
        if (!isCopyMode) {
          if (page.pageNumber === 1 && featuredImage?.wpSourceUrl && !html.includes(featuredImage.wpSourceUrl)) {
            const featuredFigure = `<figure class="wp-block-image s7-featured-image"><img src="${escapeHtmlAttr(
              featuredImage.wpSourceUrl
            )}" alt="${escapeHtmlAttr(featuredImage.alt)}" /></figure>`;
            if (html.includes('<p class="s7-page-hook">')) {
              html = html.replace(/(<p class="s7-page-hook">[\s\S]*?<\/p>)/i, `$1

${featuredFigure}`);
            } else {
              html = `${featuredFigure}

${html}`;
            }
          }
          const pageImages = updatedImages.filter(
            (img) => img.included && img.assignedPage === page.pageNumber && img.wpSourceUrl && img.id !== featuredImage?.id
          );
          for (const img of pageImages) {
            if (img.wpSourceUrl && !html.includes(img.wpSourceUrl)) {
              html += `

<figure class="wp-block-image"><img src="${escapeHtmlAttr(img.wpSourceUrl)}" alt="${escapeHtmlAttr(img.alt)}" /></figure>`;
            }
          }
        }
        html = cleanPublishedPageHtml(html, sourceUrlForClean, site.url);
        return {
          ...page,
          html,
          plainText: stripHtml(html),
          wordCount: countWords(html)
        };
      }).filter((page) => page.html.trim().length > 0).map((page, idx) => ({ ...page, pageNumber: idx + 1 }));
      const wpContent = assembleWordPressContent(finalPages);
      const featuredMediaId = updatedImages.find((img) => img.included && img.isFeatured && img.wpMediaId)?.wpMediaId ?? updatedImages.find((img) => img.included && img.wpMediaId)?.wpMediaId;
      emitStage(
        "publishing",
        "active",
        targetStatus === "publish" ? `Publishing to ${site.name}...` : `Saving draft on ${site.name}...`
      );
      const wpPost = await publishPostToWordPress(site, {
        title: sanitizedTitle,
        content: wpContent,
        slug: sanitizedSeo.slug,
        excerpt: sanitizedSeo.metaDescription,
        status: targetStatus,
        featuredMediaId,
        categoryName: sanitizedSeo.category,
        tagNames: sanitizedSeo.tags
      });
      emitStage(
        "publishing",
        "done",
        targetStatus === "publish" ? `Published post #${wpPost.id}` : `Draft saved (#${wpPost.id})`
      );
      if (!isCopyMode) {
        emitStage("facebook_package", "active", "Finalizing Facebook package with post link...");
      }
      const rawCaption = facebook?.caption ?? existingJob.facebook.caption;
      const updatedFacebook = {
        caption: stripSourceUrlsFromText(rawCaption, sourceUrlForClean, site.url) || rawCaption,
        hashtags: facebook?.hashtags ?? existingJob.facebook.hashtags,
        postUrl: wpPost.link
      };
      if (!isCopyMode) {
        emitStage("facebook_package", "done", "Facebook package ready to copy");
      }
      emitStage("saved", "active", "Saving record to workspace history...");
      const totalWords = finalPages.reduce((sum, p) => sum + p.wordCount, 0);
      const savedJob = await updateStore((draft) => {
        const idx = draft.jobs.findIndex((j) => j.id === jobId);
        const nextJob = {
          ...existingJob,
          title: sanitizedTitle,
          pages: finalPages,
          totalWords,
          images: updatedImages,
          seo: sanitizedSeo,
          facebook: updatedFacebook,
          extractionConfirmed: Boolean(extractionConfirmed || existingJob.extractionConfirmed),
          status: wpPost.status === "publish" ? "published" : "draft",
          wpPostId: wpPost.id,
          wpPostUrl: wpPost.link,
          wpPostStatus: wpPost.status,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString()
        };
        if (idx !== -1) {
          draft.jobs[idx] = nextJob;
        } else {
          draft.jobs.unshift(nextJob);
        }
        return nextJob;
      });
      emitStage("saved", "done", "Saved to History");
      sendSse(res, "complete", { job: savedJob });
      res.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Publishing to WordPress failed.";
      sendSse(res, "error", { message: msg });
      res.end();
    }
  });
  app.get("/api/jobs", requireAuth, async (_req, res) => {
    const store = await readStore();
    res.json({ jobs: store.jobs });
  });
  app.put("/api/jobs/:id", requireAuth, async (req, res) => {
    const jobId = req.params.id;
    const body = req.body;
    const updated = await updateStore((draft) => {
      const idx = draft.jobs.findIndex((j) => j.id === jobId);
      if (idx === -1) return null;
      const existing = draft.jobs[idx];
      const nextPages = Array.isArray(body.pages) ? body.pages.map((p) => ({ ...p, wordCount: countWords(p.html) })) : existing.pages;
      const nextTotalWords = nextPages.reduce((sum, p) => sum + p.wordCount, 0);
      const next = {
        ...existing,
        title: body.title ?? existing.title,
        pages: nextPages,
        totalWords: nextTotalWords,
        images: body.images ?? existing.images,
        seo: body.seo ?? existing.seo,
        facebook: body.facebook ?? existing.facebook,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      draft.jobs[idx] = next;
      return next;
    });
    if (!updated) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    res.json({ job: updated });
  });
  app.delete("/api/jobs/:id", requireAuth, async (req, res) => {
    const jobId = req.params.id;
    const deleted = await updateStore((draft) => {
      const before = draft.jobs.length;
      draft.jobs = draft.jobs.filter((j) => j.id !== jobId);
      return draft.jobs.length < before;
    });
    if (!deleted) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    res.json({ ok: true });
  });
  if (!isProduction) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path2.resolve(ROOT_DIR, "dist");
    const indexHtml = path2.resolve(distDir, "index.html");
    if (fs2.existsSync(indexHtml)) {
      app.use(express.static(distDir));
      app.get("*", (req, res) => {
        if (req.path.startsWith("/api/")) {
          res.status(404).json({ error: "API endpoint not found." });
          return;
        }
        res.sendFile(indexHtml);
      });
    } else {
      console.warn(`Warning: Built frontend not found at ${indexHtml}. Run "npm run build" first.`);
    }
  }
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`S7wari server listening on http://0.0.0.0:${PORT} (${isProduction ? "production" : "development"})`);
  });
}
startServer().catch((err) => {
  console.error("Failed to start S7wari server:", err);
  process.exit(1);
});
