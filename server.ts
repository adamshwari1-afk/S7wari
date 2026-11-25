import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import type { Request, Response } from 'express';
import {
  authenticateOwner,
  claimInitialOwner,
  extractBearerToken,
  getAuthStatus,
  requireAuth,
  revokeSessionToken,
  updateOwnerCredentials,
} from './server/lib/auth.ts';
import {
  PRIMARY_MODEL,
  generatePageHooks,
  generateRewrittenArticle,
  isAiConfigured,
  testAiConnection,
} from './server/lib/ai.ts';
import { buildCopyModeFacebookPackage, buildCopyModeSeo } from './server/lib/copyMode.ts';
import {
  assembleWordPressContent,
  buildArticlePages,
  countWords,
  distributeImagesAcrossPages,
  splitBlocksIntoPages,
  stripHtml,
} from './server/lib/paginator.ts';
import { cleanPublishedPageHtml, stripSourceUrlsFromText } from './server/lib/sanitize.ts';
import { decodeSourceUrl, scrapeArticle } from './server/lib/scraper.ts';
import { assertSafeExternalUrl } from './server/lib/ssrf.ts';
import { readStore, toPublicSite, updateStore } from './server/lib/storage.ts';
import { publishPostToWordPress, testWordPressConnection, uploadImageToWordPress } from './server/lib/wordpress.ts';
import type { ArticleImage, ArticlePage, EditorialJob, PipelineStage, WordPressSite } from './server/types.ts';

dotenv.config();

const PORT = Number(process.env.PORT) || 3000;
const entryFile = path.basename(process.argv[1] || '');
const isCompiledEntry = entryFile.endsWith('.mjs') || entryFile.endsWith('.js');
const isProduction = process.env.NODE_ENV === 'production' || isCompiledEntry;

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = fs.existsSync(path.resolve(process.cwd(), 'package.json'))
  ? process.cwd()
  : currentDir;

function sendSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function escapeHtmlAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function replaceImageUrlsInHtml(html: string, replacements: Map<string, string>): string {
  let updated = html;
  for (const [oldUrl, newUrl] of replacements.entries()) {
    if (oldUrl && newUrl && oldUrl !== newUrl) {
      updated = updated.split(oldUrl).join(newUrl);
      updated = updated.split(escapeHtmlAttr(oldUrl)).join(escapeHtmlAttr(newUrl));
    }
  }
  return updated;
}

async function startServer(): Promise<void> {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '15mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // --- Auth routes ---
  app.get('/api/auth/status', async (_req: Request, res: Response) => {
    try {
      const status = await getAuthStatus();
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load auth status.' });
    }
  });

  app.post('/api/auth/setup', async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body as { email?: string; password?: string };
      const result = await claimInitialOwner(email ?? '', password ?? '');
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Setup failed.' });
    }
  });

  app.post('/api/auth/login', async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body as { email?: string; password?: string };
      if (!email || !password) {
        res.status(400).json({ error: 'Email and password are required.' });
        return;
      }
      const session = await authenticateOwner(email, password);
      if (!session) {
        res.status(401).json({ error: 'Invalid email or password.' });
        return;
      }
      res.json(session);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Login failed.' });
    }
  });

  app.post('/api/auth/logout', requireAuth, (req: Request, res: Response) => {
    const token = extractBearerToken(req);
    if (token) revokeSessionToken(token);
    res.json({ ok: true });
  });

  app.put('/api/auth/credentials', requireAuth, async (req: Request, res: Response) => {
    try {
      const { currentPassword, newEmail, newPassword } = req.body as {
        currentPassword?: string;
        newEmail?: string;
        newPassword?: string;
      };
      if (!currentPassword || !newEmail) {
        res.status(400).json({ error: 'Current password and email are required.' });
        return;
      }
      const updated = await updateOwnerCredentials(currentPassword, newEmail, newPassword?.trim() || undefined);
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Could not update credentials.' });
    }
  });

  // --- Workspace status & settings ---
  app.get('/api/status', requireAuth, async (_req: Request, res: Response) => {
    try {
      const store = await readStore();
      const connectedSites = store.sites.filter((s) => s.lastTestOk).length;
      res.json({
        aiConnected: isAiConfigured(),
        aiModel: PRIMARY_MODEL,
        activeSitesCount: store.sites.length,
        connectedSitesCount: connectedSites,
        wordpressConnected: store.sites.length > 0 && (connectedSites > 0 || store.sites.some((s) => Boolean(s.appPassword))),
        editorialTone: store.settings.editorialTone,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load workspace status.' });
    }
  });

  app.put('/api/settings', requireAuth, async (req: Request, res: Response) => {
    try {
      const { editorialTone } = req.body as { editorialTone?: 'editorial' | 'engaging' | 'informative' };
      const allowed = new Set(['editorial', 'engaging', 'informative']);
      if (!editorialTone || !allowed.has(editorialTone)) {
        res.status(400).json({ error: 'Invalid editorial tone.' });
        return;
      }
      const saved = await updateStore((draft) => {
        draft.settings.editorialTone = editorialTone;
        return draft.settings;
      });
      res.json(saved);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Could not update settings.' });
    }
  });

  app.post('/api/settings/test-ai', requireAuth, async (_req: Request, res: Response) => {
    const result = await testAiConnection();
    res.status(result.ok ? 200 : 502).json(result);
  });

  // --- WordPress Destinations ---
  app.get('/api/sites', requireAuth, async (_req: Request, res: Response) => {
    const store = await readStore();
    res.json({ sites: store.sites.map(toPublicSite) });
  });

  app.post('/api/sites', requireAuth, async (req: Request, res: Response) => {
    try {
      const body = req.body as Partial<WordPressSite>;
      const name = (body.name ?? '').trim();
      const rawUrl = (body.url ?? '').trim();
      const username = (body.username ?? '').trim();
      const appPassword = (body.appPassword ?? '').trim();
      const language = (body.language ?? 'English').trim();
      const targetWordsPerPage = Math.min(800, Math.max(150, Number(body.targetWordsPerPage) || 300));
      const minTotalWords = Math.min(3000, Math.max(300, Number(body.minTotalWords) || 900));

      if (!name || !rawUrl || !username || !appPassword) {
        res.status(400).json({ error: 'Site name, URL, username, and Application Password are required.' });
        return;
      }

      const parsedUrl = await assertSafeExternalUrl(rawUrl);
      const cleanUrl = parsedUrl.origin + parsedUrl.pathname.replace(/\/+$/, '');
      const now = new Date().toISOString();

      const site: WordPressSite = {
        id: crypto.randomUUID(),
        name,
        url: cleanUrl,
        username,
        appPassword,
        language,
        targetWordsPerPage,
        minTotalWords,
        createdAt: now,
        updatedAt: now,
      };

      await updateStore((draft) => {
        draft.sites.push(site);
      });

      res.status(201).json({ site: toPublicSite(site) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create destination.' });
    }
  });

  app.put('/api/sites/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const siteId = req.params.id;
      const body = req.body as Partial<WordPressSite>;

      const updated = await updateStore(async (draft) => {
        const idx = draft.sites.findIndex((s) => s.id === siteId);
        if (idx === -1) return null;
        const existing = draft.sites[idx];

        let cleanUrl = existing.url;
        if (body.url && body.url.trim() !== existing.url) {
          const parsedUrl = await assertSafeExternalUrl(body.url.trim());
          cleanUrl = parsedUrl.origin + parsedUrl.pathname.replace(/\/+$/, '');
        }

        const next: WordPressSite = {
          ...existing,
          name: body.name?.trim() || existing.name,
          url: cleanUrl,
          username: body.username?.trim() || existing.username,
          appPassword: body.appPassword && body.appPassword.trim() ? body.appPassword.trim() : existing.appPassword,
          language: body.language?.trim() || existing.language,
          targetWordsPerPage: body.targetWordsPerPage
            ? Math.min(800, Math.max(150, Number(body.targetWordsPerPage)))
            : existing.targetWordsPerPage,
          minTotalWords: body.minTotalWords
            ? Math.min(3000, Math.max(300, Number(body.minTotalWords)))
            : existing.minTotalWords,
          updatedAt: new Date().toISOString(),
        };
        draft.sites[idx] = next;
        return next;
      });

      if (!updated) {
        res.status(404).json({ error: 'WordPress destination not found.' });
        return;
      }

      res.json({ site: toPublicSite(updated) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update destination.' });
    }
  });

  app.delete('/api/sites/:id', requireAuth, async (req: Request, res: Response) => {
    const siteId = req.params.id;
    const removed = await updateStore((draft) => {
      const before = draft.sites.length;
      draft.sites = draft.sites.filter((s) => s.id !== siteId);
      return draft.sites.length < before;
    });
    if (!removed) {
      res.status(404).json({ error: 'WordPress destination not found.' });
      return;
    }
    res.json({ ok: true });
  });

  app.post('/api/sites/test', requireAuth, async (req: Request, res: Response) => {
    try {
      const { siteId, url, username, appPassword } = req.body as {
        siteId?: string;
        url?: string;
        username?: string;
        appPassword?: string;
      };

      let creds: { url: string; username: string; appPassword: string } | null = null;
      if (siteId) {
        const store = await readStore();
        const saved = store.sites.find((s) => s.id === siteId);
        if (!saved) {
          res.status(404).json({ error: 'WordPress destination not found.' });
          return;
        }
        creds = {
          url: url?.trim() || saved.url,
          username: username?.trim() || saved.username,
          appPassword: appPassword?.trim() || saved.appPassword,
        };
      } else if (url && username && appPassword) {
        creds = { url: url.trim(), username: username.trim(), appPassword: appPassword.trim() };
      }

      if (!creds) {
        res.status(400).json({ error: 'Site URL, username, and Application Password are required.' });
        return;
      }

      await assertSafeExternalUrl(creds.url);
      const testResult = await testWordPressConnection(creds);

      if (siteId) {
        await updateStore((draft) => {
          const target = draft.sites.find((s) => s.id === siteId);
          if (target) {
            target.lastTestedAt = new Date().toISOString();
            target.lastTestOk = testResult.ok;
            target.lastTestMessage = testResult.message;
          }
        });
      }

      res.json(testResult);
    } catch (err) {
      res.status(400).json({ ok: false, message: err instanceof Error ? err.message : 'Connection test failed.' });
    }
  });

  // --- URL Decode helper ---
  app.post('/api/studio/decode-url', requireAuth, (req: Request, res: Response) => {
    try {
      const { url } = req.body as { url?: string };
      const decoded = decodeSourceUrl(url ?? '');
      res.json(decoded);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid URL.' });
    }
  });

  // --- Editorial Studio Generate Pipeline (SSE) ---
  app.post('/api/studio/generate', requireAuth, async (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const emitStage = (stage: PipelineStage, state: 'active' | 'done' | 'error', detail?: string) => {
      sendSse(res, 'stage', { stage, state, detail });
    };

    try {
      const { url, siteId, aiRewrite } = req.body as {
        url?: string;
        siteId?: string;
        aiRewrite?: boolean;
      };
      const useAi = aiRewrite === true;
      if (!url || !siteId) {
        sendSse(res, 'error', { message: 'Please select a WordPress destination and enter an article URL.' });
        res.end();
        return;
      }

      const store = await readStore();
      const site = store.sites.find((s) => s.id === siteId);
      if (!site) {
        sendSse(res, 'error', { message: 'Selected WordPress destination was not found.' });
        res.end();
        return;
      }

      // 1. Fetching
      emitStage('fetching', 'active', 'Decoding URL & reading source article...');
      const scraped = await scrapeArticle(url);
      emitStage(
        'fetching',
        'done',
        scraped.wasFacebookRedirect
          ? `Facebook link decoded · ${scraped.pagesFetched} page(s) · ${scraped.images.length} images found`
          : `${scraped.pagesFetched} source page(s) · ${scraped.images.length} images found`
      );

      const siteOrigin = new URL(site.url).origin;
      const now = new Date().toISOString();

      if (!useAi) {
        // Copy mode: skip AI rewriting completely, preserve original structure & image order
        emitStage(
          'splitting',
          'active',
          `Splitting original article into ~${site.targetWordsPerPage}-word pages with <!--nextpage-->...`
        );

        const rawPages = splitBlocksIntoPages('', scraped.structuredBlocks, site.targetWordsPerPage, 150);
        if (rawPages.length === 0) {
          rawPages.push([{ type: 'p', text: scraped.textContent.slice(0, 4000) }]);
        }

        const imagePageMap = new Map<string, number>();
        rawPages.forEach((blocks, pageIdx) => {
          blocks.forEach((b) => {
            if (b.type === 'img' && b.imageUrl && !imagePageMap.has(b.imageUrl)) {
              imagePageMap.set(b.imageUrl, pageIdx + 1);
            }
          });
        });

        const initialImages: ArticleImage[] = scraped.images.map((img, i) => ({
          id: `img-${i + 1}`,
          sourceUrl: img.url,
          alt: img.alt || scraped.title,
          caption: img.caption,
          included: true,
          isFeatured: Boolean(img.isFeatured),
          assignedPage: imagePageMap.get(img.url) ?? 1,
        }));

        const pages = buildArticlePages(rawPages, [], initialImages, { preserveInlineOrder: true }).map((p) => {
          const cleanedHtml = cleanPublishedPageHtml(p.html, scraped.resolvedUrl, site.url);
          return {
            ...p,
            html: cleanedHtml,
            plainText: stripHtml(cleanedHtml),
            wordCount: countWords(cleanedHtml),
          };
        });
        const finalWordCount = pages.reduce((acc, p) => acc + p.wordCount, 0);

        const rawSeo = buildCopyModeSeo({
          title: scraped.title,
          description: scraped.description,
          blocks: scraped.structuredBlocks,
          language: site.language,
          hasRecipeData: scraped.hasRecipeData,
        });
        const seo = {
          ...rawSeo,
          metaTitle: stripSourceUrlsFromText(rawSeo.metaTitle, scraped.resolvedUrl, site.url) || rawSeo.metaTitle,
          metaDescription: stripSourceUrlsFromText(rawSeo.metaDescription, scraped.resolvedUrl, site.url),
        };
        const previewLink = `${siteOrigin}/${seo.slug}`;
        const rawFb = buildCopyModeFacebookPackage({
          title: scraped.title,
          category: seo.category,
          hasRecipeData: scraped.hasRecipeData,
          language: site.language,
          postUrl: previewLink,
        });
        const facebookPackage = {
          ...rawFb,
          caption: stripSourceUrlsFromText(rawFb.caption, scraped.resolvedUrl, site.url) || rawFb.caption,
        };

        emitStage('splitting', 'done', `${pages.length} pages ready (${finalWordCount} words · Copy mode)`);

        const job: EditorialJob = {
          id: crypto.randomUUID(),
          mode: 'copy',
          siteId: site.id,
          siteName: site.name,
          language: site.language,
          originalInputUrl: scraped.originalUrl,
          resolvedUrl: scraped.resolvedUrl,
          wasFacebookRedirect: scraped.wasFacebookRedirect,
          sourceTitle: scraped.title,
          title: scraped.title,
          intro: '',
          hasRecipeData: scraped.hasRecipeData,
          extractionIncomplete: scraped.extractionIncomplete,
          extractionConfirmed: false,
          pages,
          totalWords: finalWordCount,
          images: initialImages,
          seo,
          facebook: facebookPackage,
          status: 'ready',
          expansionAttempts: 0,
          createdAt: now,
          updatedAt: now,
        };

        await updateStore((storeDraft) => {
          storeDraft.jobs.unshift(job);
          if (storeDraft.jobs.length > 100) {
            storeDraft.jobs = storeDraft.jobs.slice(0, 100);
          }
        });

        sendSse(res, 'complete', { job });
        res.end();
        return;
      }

      // 2. Rewriting (900+ words check)
      emitStage('rewriting', 'active', `Rewriting in ${site.language} (${site.minTotalWords}+ words check)...`);
      const { draft, totalWords, expansionAttempts } = await generateRewrittenArticle({
        sourceTitle: scraped.title,
        sourceText: scraped.textContent,
        targetLanguage: site.language,
        minWords: site.minTotalWords,
        targetWordsPerPage: site.targetWordsPerPage,
        editorialTone: store.settings.editorialTone,
        onStatusUpdate: (detail) => emitStage('rewriting', 'active', detail),
      });
      emitStage(
        'rewriting',
        'done',
        expansionAttempts > 0
          ? `${totalWords} words verified after ${expansionAttempts} expansion pass(es)`
          : `${totalWords} words verified`
      );

      // 3. Splitting pages
      emitStage('splitting', 'active', `Splitting into ~${site.targetWordsPerPage}-word pages with <!--nextpage-->...`);
      const rawPages = splitBlocksIntoPages(draft.intro, draft.blocks, site.targetWordsPerPage, 150);

      const hookInputs = rawPages.map((blocks, idx) => ({
        pageNumber: idx + 1,
        openingText: blocks
          .slice(0, 2)
          .map((b) => b.text || (b.items ?? []).join(' '))
          .join(' '),
        isLastPage: idx === rawPages.length - 1,
      }));
      const hooks = await generatePageHooks(hookInputs, draft.title, site.language);

      const initialImages: ArticleImage[] = scraped.images.map((img, i) => ({
        id: `img-${i + 1}`,
        sourceUrl: img.url,
        alt: img.alt || draft.title,
        included: true,
        isFeatured: img.isFeatured ?? i === 0,
        assignedPage: 1,
      }));
      const distributedImages = distributeImagesAcrossPages(rawPages.length, initialImages);
      const pages = buildArticlePages(rawPages, hooks, distributedImages).map((p) => {
        const cleanedHtml = cleanPublishedPageHtml(p.html, scraped.resolvedUrl, site.url);
        return {
          ...p,
          html: cleanedHtml,
          plainText: stripHtml(cleanedHtml),
          wordCount: countWords(cleanedHtml),
        };
      });
      const finalWordCount = pages.reduce((acc, p) => acc + p.wordCount, 0);

      emitStage('splitting', 'done', `${pages.length} pages ready (${finalWordCount} words total)`);

      // 4. Generating Facebook package preview
      emitStage('facebook_package', 'active', 'Preparing SEO metadata & Facebook package...');
      const cleanSeo = {
        ...draft.seo,
        metaTitle: stripSourceUrlsFromText(draft.seo.metaTitle, scraped.resolvedUrl, site.url) || draft.seo.metaTitle,
        metaDescription: stripSourceUrlsFromText(draft.seo.metaDescription, scraped.resolvedUrl, site.url),
      };
      const previewLink = `${siteOrigin}/${cleanSeo.slug}`;
      const facebookPackage = {
        caption: stripSourceUrlsFromText(draft.facebook.caption, scraped.resolvedUrl, site.url) || draft.facebook.caption,
        hashtags: draft.facebook.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).slice(0, 5),
        postUrl: previewLink,
      };
      emitStage('facebook_package', 'done', `${facebookPackage.hashtags.length} hashtags & hook caption ready`);

      const job: EditorialJob = {
        id: crypto.randomUUID(),
        mode: 'ai',
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
        recipeNotice: draft.recipeNotice || undefined,
        pages,
        totalWords: finalWordCount,
        images: distributedImages,
        seo: cleanSeo,
        facebook: facebookPackage,
        status: 'ready',
        expansionAttempts,
        createdAt: now,
        updatedAt: now,
      };

      await updateStore((storeDraft) => {
        storeDraft.jobs.unshift(job);
        if (storeDraft.jobs.length > 100) {
          storeDraft.jobs = storeDraft.jobs.slice(0, 100);
        }
      });

      sendSse(res, 'complete', { job });
      res.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'An unexpected error occurred during processing.';
      sendSse(res, 'error', { message: msg });
      res.end();
    }
  });

  // --- Publish / Save as Draft to WordPress Pipeline (SSE) ---
  app.post('/api/studio/publish', requireAuth, async (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const emitStage = (stage: PipelineStage, state: 'active' | 'done' | 'error', detail?: string) => {
      sendSse(res, 'stage', { stage, state, detail });
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
        extractionConfirmed,
      } = req.body as {
        jobId?: string;
        publishStatus?: 'publish' | 'draft';
        title?: string;
        pages?: ArticlePage[];
        images?: ArticleImage[];
        seo?: EditorialJob['seo'];
        facebook?: EditorialJob['facebook'];
        extractionConfirmed?: boolean;
      };

      if (!jobId) {
        sendSse(res, 'error', { message: 'Missing article job ID.' });
        res.end();
        return;
      }

      const store = await readStore();
      const existingJob = store.jobs.find((j) => j.id === jobId);
      if (!existingJob) {
        sendSse(res, 'error', { message: 'Article job not found.' });
        res.end();
        return;
      }

      if (
        existingJob.extractionIncomplete &&
        !extractionConfirmed &&
        !existingJob.extractionConfirmed
      ) {
        sendSse(res, 'error', {
          message: 'Extraction incomplete (under 200 words). Please review and confirm before publishing.',
        });
        res.end();
        return;
      }

      const site = store.sites.find((s) => s.id === existingJob.siteId);
      if (!site) {
        sendSse(res, 'error', { message: 'Destination WordPress site no longer exists. Check Settings.' });
        res.end();
        return;
      }

      const targetStatus: 'publish' | 'draft' = publishStatus === 'draft' ? 'draft' : 'publish';
      const activeTitle = (title ?? existingJob.title).trim() || existingJob.title;
      const activeSeo = seo ?? existingJob.seo;
      const activePages = Array.isArray(pages) && pages.length > 0 ? pages : existingJob.pages;
      const activeImages = Array.isArray(images) ? images : existingJob.images;

      // Step 4: Upload images to WordPress Media Library
      const includedImages = activeImages.filter((img) => img.included);
      emitStage(
        'uploading_images',
        'active',
        includedImages.length > 0
          ? `Uploading ${includedImages.length} image(s) to WordPress Media Library...`
          : 'No images selected; preparing post body...'
      );

      const urlReplacements = new Map<string, string>();
      const updatedImages: ArticleImage[] = [];
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
            uploadError: undefined,
          });
          uploadedCount += 1;
        } catch (err) {
          updatedImages.push({
            ...img,
            uploadError: err instanceof Error ? err.message : 'Upload failed',
          });
        }
      }

      emitStage(
        'uploading_images',
        'done',
        includedImages.length > 0
          ? `${uploadedCount}/${includedImages.length} image(s) uploaded to WordPress Media Library`
          : 'No images attached'
      );

      // Rewrite image URLs in each page to WP Media URLs & ensure featured image is at top of Page 1
      const isCopyMode = existingJob.mode === 'copy';
      const featuredImage =
        updatedImages.find((img) => img.included && img.isFeatured && img.wpSourceUrl) ??
        updatedImages.find((img) => img.included && img.wpSourceUrl);

      const sourceUrlForClean = existingJob.resolvedUrl || existingJob.originalInputUrl;
      const sanitizedSeo = {
        ...activeSeo,
        metaTitle: stripSourceUrlsFromText(activeSeo.metaTitle, sourceUrlForClean, site.url) || activeSeo.metaTitle,
        metaDescription: stripSourceUrlsFromText(activeSeo.metaDescription, sourceUrlForClean, site.url),
      };
      const sanitizedTitle = stripSourceUrlsFromText(activeTitle, sourceUrlForClean, site.url) || activeTitle;

      const finalPages: ArticlePage[] = activePages
        .map((page) => {
          let html = replaceImageUrlsInHtml(page.html, urlReplacements);

          if (!isCopyMode) {
            if (page.pageNumber === 1 && featuredImage?.wpSourceUrl && !html.includes(featuredImage.wpSourceUrl)) {
              const featuredFigure = `<figure class="wp-block-image s7-featured-image"><img src="${escapeHtmlAttr(
                featuredImage.wpSourceUrl
              )}" alt="${escapeHtmlAttr(featuredImage.alt)}" /></figure>`;
              if (html.includes('<p class="s7-page-hook">')) {
                html = html.replace(/(<p class="s7-page-hook">[\s\S]*?<\/p>)/i, `$1\n\n${featuredFigure}`);
              } else {
                html = `${featuredFigure}\n\n${html}`;
              }
            }

            const pageImages = updatedImages.filter(
              (img) =>
                img.included &&
                img.assignedPage === page.pageNumber &&
                img.wpSourceUrl &&
                img.id !== featuredImage?.id
            );
            for (const img of pageImages) {
              if (img.wpSourceUrl && !html.includes(img.wpSourceUrl)) {
                html += `\n\n<figure class="wp-block-image"><img src="${escapeHtmlAttr(img.wpSourceUrl)}" alt="${escapeHtmlAttr(img.alt)}" /></figure>`;
              }
            }
          }

          html = cleanPublishedPageHtml(html, sourceUrlForClean, site.url);

          return {
            ...page,
            html,
            plainText: stripHtml(html),
            wordCount: countWords(html),
          };
        })
        .filter((page) => page.html.trim().length > 0)
        .map((page, idx) => ({ ...page, pageNumber: idx + 1 }));

      const wpContent = assembleWordPressContent(finalPages);
      const featuredMediaId =
        updatedImages.find((img) => img.included && img.isFeatured && img.wpMediaId)?.wpMediaId ??
        updatedImages.find((img) => img.included && img.wpMediaId)?.wpMediaId;

      // Publish to WordPress
      emitStage(
        'publishing',
        'active',
        targetStatus === 'publish' ? `Publishing to ${site.name}...` : `Saving draft on ${site.name}...`
      );

      const wpPost = await publishPostToWordPress(site, {
        title: sanitizedTitle,
        content: wpContent,
        slug: sanitizedSeo.slug,
        excerpt: sanitizedSeo.metaDescription,
        status: targetStatus,
        featuredMediaId,
        categoryName: sanitizedSeo.category,
        tagNames: sanitizedSeo.tags,
      });

      emitStage(
        'publishing',
        'done',
        targetStatus === 'publish' ? `Published post #${wpPost.id}` : `Draft saved (#${wpPost.id})`
      );

      // Update Facebook package with live post URL
      if (!isCopyMode) {
        emitStage('facebook_package', 'active', 'Finalizing Facebook package with post link...');
      }
      const rawCaption = facebook?.caption ?? existingJob.facebook.caption;
      const updatedFacebook = {
        caption: stripSourceUrlsFromText(rawCaption, sourceUrlForClean, site.url) || rawCaption,
        hashtags: facebook?.hashtags ?? existingJob.facebook.hashtags,
        postUrl: wpPost.link,
      };
      if (!isCopyMode) {
        emitStage('facebook_package', 'done', 'Facebook package ready to copy');
      }

      // Step 7: Save to local DB
      emitStage('saved', 'active', 'Saving record to workspace history...');
      const totalWords = finalPages.reduce((sum, p) => sum + p.wordCount, 0);
      const savedJob = await updateStore((draft) => {
        const idx = draft.jobs.findIndex((j) => j.id === jobId);
        const nextJob: EditorialJob = {
          ...existingJob,
          title: sanitizedTitle,
          pages: finalPages,
          totalWords,
          images: updatedImages,
          seo: sanitizedSeo,
          facebook: updatedFacebook,
          extractionConfirmed: Boolean(extractionConfirmed || existingJob.extractionConfirmed),
          status: wpPost.status === 'publish' ? 'published' : 'draft',
          wpPostId: wpPost.id,
          wpPostUrl: wpPost.link,
          wpPostStatus: wpPost.status,
          updatedAt: new Date().toISOString(),
        };
        if (idx !== -1) {
          draft.jobs[idx] = nextJob;
        } else {
          draft.jobs.unshift(nextJob);
        }
        return nextJob;
      });
      emitStage('saved', 'done', 'Saved to History');

      sendSse(res, 'complete', { job: savedJob });
      res.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Publishing to WordPress failed.';
      sendSse(res, 'error', { message: msg });
      res.end();
    }
  });

  // --- History / Jobs CRUD ---
  app.get('/api/jobs', requireAuth, async (_req: Request, res: Response) => {
    const store = await readStore();
    res.json({ jobs: store.jobs });
  });

  app.put('/api/jobs/:id', requireAuth, async (req: Request, res: Response) => {
    const jobId = req.params.id;
    const body = req.body as Partial<EditorialJob>;

    const updated = await updateStore((draft) => {
      const idx = draft.jobs.findIndex((j) => j.id === jobId);
      if (idx === -1) return null;
      const existing = draft.jobs[idx];
      const nextPages = Array.isArray(body.pages)
        ? body.pages.map((p) => ({ ...p, wordCount: countWords(p.html) }))
        : existing.pages;
      const nextTotalWords = nextPages.reduce((sum, p) => sum + p.wordCount, 0);

      const next: EditorialJob = {
        ...existing,
        title: body.title ?? existing.title,
        pages: nextPages,
        totalWords: nextTotalWords,
        images: body.images ?? existing.images,
        seo: body.seo ?? existing.seo,
        facebook: body.facebook ?? existing.facebook,
        updatedAt: new Date().toISOString(),
      };
      draft.jobs[idx] = next;
      return next;
    });

    if (!updated) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }
    res.json({ job: updated });
  });

  app.delete('/api/jobs/:id', requireAuth, async (req: Request, res: Response) => {
    const jobId = req.params.id;
    const deleted = await updateStore((draft) => {
      const before = draft.jobs.length;
      draft.jobs = draft.jobs.filter((j) => j.id !== jobId);
      return draft.jobs.length < before;
    });
    if (!deleted) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }
    res.json({ ok: true });
  });

  // --- Vite (dev) / Built Static SPA (production) ---
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(ROOT_DIR, 'dist');
    const indexHtml = path.resolve(distDir, 'index.html');
    if (fs.existsSync(indexHtml)) {
      app.use(express.static(distDir));
      app.get('*', (req: Request, res: Response) => {
        if (req.path.startsWith('/api/')) {
          res.status(404).json({ error: 'API endpoint not found.' });
          return;
        }
        res.sendFile(indexHtml);
      });
    } else {
      console.warn(`Warning: Built frontend not found at ${indexHtml}. Run "npm run build" first.`);
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`S7wari server listening on http://0.0.0.0:${PORT} (${isProduction ? 'production' : 'development'})`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start S7wari server:', err);
  process.exit(1);
});
