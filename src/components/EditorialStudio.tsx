import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  Edit3,
  ExternalLink,
  Eye,
  Globe,
  Image as ImageIcon,
  ImageOff,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  Save,
  Scissors,
  Share2,
  Upload,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { copyTextToClipboard } from '../lib/clipboard';
import type { ArticleImage, EditorialJob, PipelineStage, WordPressSite } from '../types';
import { SafeArticlePreview } from './SafeArticlePreview';

interface EditorialStudioProps {
  sites: WordPressSite[];
  activeJob: EditorialJob | null;
  onJobChange: (job: EditorialJob | null) => void;
  onGoToSettings: () => void;
  onRefreshData: () => void;
}

const AI_PIPELINE_STEPS: Array<{ id: PipelineStage; label: string }> = [
  { id: 'fetching', label: 'Fetching' },
  { id: 'rewriting', label: 'Rewriting (900+ words check)' },
  { id: 'splitting', label: 'Splitting pages' },
  { id: 'uploading_images', label: 'Uploading images' },
  { id: 'publishing', label: 'Publishing to WordPress' },
  { id: 'facebook_package', label: 'Generating Facebook package' },
  { id: 'saved', label: 'Saved' },
];

const COPY_PIPELINE_STEPS: Array<{ id: PipelineStage; label: string }> = [
  { id: 'fetching', label: 'Fetching' },
  { id: 'splitting', label: 'Splitting pages' },
  { id: 'uploading_images', label: 'Uploading images' },
  { id: 'publishing', label: 'Publishing to WordPress' },
  { id: 'saved', label: 'Saved' },
];

type StageState = 'idle' | 'active' | 'done' | 'error';

function decodeFacebookLinkPreview(rawUrl: string): { isFb: boolean; decoded: string | null } {
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.toLowerCase();
    if (
      (host === 'l.facebook.com' ||
        host === 'lm.facebook.com' ||
        host === 'm.facebook.com' ||
        host === 'www.facebook.com') &&
      (parsed.pathname === '/l.php' || parsed.pathname === '/flx/warn/')
    ) {
      let u = parsed.searchParams.get('u');
      if (u) {
        if (u.includes('%3A%2F%2F') || u.includes('%25')) {
          try {
            u = decodeURIComponent(u);
          } catch {
            // keep first decode
          }
        }
        return { isFb: true, decoded: u };
      }
    }
  } catch {
    // ignore incomplete typing
  }
  return { isFb: false, decoded: null };
}

function countWordsClient(html: string): number {
  const clean = html
    .replace(/<!--nextpage-->/gi, ' ')
    .replace(/<figure[\s\S]*?<\/figure>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? clean.split(/\s+/).filter(Boolean).length : 0;
}

function ImageThumbCard({
  img,
  totalPages,
  onToggleInclude,
  onChangePage,
  onChangeAlt,
  onSetFeatured,
}: {
  img: ArticleImage;
  totalPages: number;
  onToggleInclude: () => void;
  onChangePage: (page: number) => void;
  onChangeAlt: (alt: string) => void;
  onSetFeatured: () => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
  }, [img.sourceUrl, img.wpSourceUrl]);

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-2xl border transition-all duration-150 ${
        img.included
          ? 'border-slate-200 bg-white dark:border-white/[0.08] dark:bg-[#111827]'
          : 'border-slate-200/60 bg-slate-50/70 opacity-65 dark:border-white/[0.05] dark:bg-white/[0.02]'
      }`}
    >
      <div className="relative aspect-[16/10] w-full overflow-hidden bg-slate-100 dark:bg-[#0B0F1A]">
        {!imgFailed ? (
          <img
            src={img.wpSourceUrl || img.sourceUrl}
            alt={img.alt}
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-3 text-center">
            <ImageOff className="h-5 w-5 text-slate-400" />
            <span className="line-clamp-2 text-[11px] text-slate-500 dark:text-slate-400">
              Preview blocked by source host (uploads via server)
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col justify-between gap-3 p-3.5">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-medium text-slate-700 dark:text-slate-300">
              {img.wpMediaId ? `WP Media #${img.wpMediaId}` : `Page ${img.assignedPage}`}
            </span>
            <button
              type="button"
              onClick={onToggleInclude}
              className={`rounded-lg px-2 py-1 text-xs font-medium transition-colors ${
                img.included
                  ? 'bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-500/15 dark:text-blue-300'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-white/[0.06] dark:text-slate-400'
              }`}
            >
              {img.included ? 'Included' : 'Excluded'}
            </button>
          </div>

          <input
            type="text"
            value={img.alt}
            onChange={(e) => onChangeAlt(e.target.value)}
            placeholder="Image alt text..."
            aria-label="Image alt text"
            className="w-full rounded-lg border border-slate-200 bg-slate-50/70 px-2.5 py-1.5 text-xs text-slate-800 focus:border-blue-600 focus:outline-none dark:border-white/[0.08] dark:bg-[#0B0F1A] dark:text-slate-200"
          />
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-2.5 dark:border-white/[0.06]">
          {img.isFeatured ? (
            <span className="text-[11px] font-semibold text-blue-600 dark:text-blue-400">
              Featured · Top of Page 1
            </span>
          ) : (
            <button
              type="button"
              onClick={onSetFeatured}
              className="text-[11px] font-medium text-slate-600 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400"
            >
              Set as featured
            </button>
          )}
          <select
            value={img.assignedPage}
            onChange={(e) => onChangePage(Number(e.target.value))}
            className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 focus:border-blue-600 focus:outline-none dark:border-white/[0.08] dark:bg-[#0B0F1A] dark:text-slate-200"
          >
            {Array.from({ length: Math.max(1, totalPages) }, (_, i) => i + 1).map((p) => (
              <option key={p} value={p}>
                Page {p}
              </option>
            ))}
          </select>
        </div>

        {img.uploadError && (
          <p className="text-[11px] text-red-600 dark:text-red-400">{img.uploadError}</p>
        )}
      </div>
    </div>
  );
}

export function EditorialStudio({
  sites,
  activeJob,
  onJobChange,
  onGoToSettings,
  onRefreshData,
}: EditorialStudioProps) {
  const [selectedSiteId, setSelectedSiteId] = useState<string>(sites[0]?.id ?? '');
  const [urlInput, setUrlInput] = useState(activeJob?.originalInputUrl ?? '');
  const [aiRewrite, setAiRewrite] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [activePageTab, setActivePageTab] = useState(1);
  const [editingPage, setEditingPage] = useState<number | null>(null);
  const [copiedFb, setCopiedFb] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [featuredUrlInput, setFeaturedUrlInput] = useState('');
  const [featuredPreviewFailed, setFeaturedPreviewFailed] = useState(false);
  const [extractionConfirmed, setExtractionConfirmed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [stages, setStages] = useState<Record<PipelineStage, { state: StageState; detail?: string }>>({
    fetching: { state: 'idle' },
    rewriting: { state: 'idle' },
    splitting: { state: 'idle' },
    uploading_images: { state: 'idle' },
    publishing: { state: 'idle' },
    facebook_package: { state: 'idle' },
    saved: { state: 'idle' },
  });

  useEffect(() => {
    if (sites.length > 0 && !sites.some((s) => s.id === selectedSiteId)) {
      setSelectedSiteId(sites[0].id);
    }
  }, [sites, selectedSiteId]);

  useEffect(() => {
    if (activeJob) {
      setUrlInput(activeJob.originalInputUrl);
      if (activeJob.siteId) setSelectedSiteId(activeJob.siteId);
      if (activeJob.mode) {
        setAiRewrite(activeJob.mode === 'ai');
      }
      setExtractionConfirmed(Boolean(activeJob.extractionConfirmed));
      setActivePageTab(1);
      setEditingPage(null);
      if (activeJob.status === 'published' || activeJob.status === 'draft') {
        setStages({
          fetching: { state: 'done' },
          rewriting: { state: 'done', detail: `${activeJob.totalWords} words verified` },
          splitting: { state: 'done', detail: `${activeJob.pages.length} pages` },
          uploading_images: { state: 'done' },
          publishing: { state: 'done', detail: activeJob.status === 'published' ? 'Published' : 'Saved as draft' },
          facebook_package: { state: 'done' },
          saved: { state: 'done' },
        });
      }
    }
  }, [activeJob?.id]);

  const fbPreview = useMemo(() => decodeFacebookLinkPreview(urlInput), [urlInput]);

  const resetStages = () => {
    setStages({
      fetching: { state: 'idle' },
      rewriting: { state: 'idle' },
      splitting: { state: 'idle' },
      uploading_images: { state: 'idle' },
      publishing: { state: 'idle' },
      facebook_package: { state: 'idle' },
      saved: { state: 'idle' },
    });
  };

  const handleStart = async (overrideUrl?: string) => {
    const targetUrl = (overrideUrl ?? urlInput).trim();
    if (!selectedSiteId) {
      setErrorMsg('Please select or add a WordPress destination first.');
      return;
    }
    if (!targetUrl) {
      setErrorMsg('Please paste an article URL (or Facebook redirect link) to begin.');
      return;
    }

    setErrorMsg(null);
    setIsGenerating(true);
    setEditingPage(null);
    setExtractionConfirmed(false);
    setActivePageTab(1);
    resetStages();

    try {
      await api.streamGenerate(targetUrl, selectedSiteId, aiRewrite, {
        onStage: ({ stage, state, detail }) => {
          setStages((prev) => ({
            ...prev,
            [stage]: { state, detail },
          }));
        },
        onComplete: (job) => {
          onJobChange(job);
          onRefreshData();
        },
        onError: (message) => {
          setErrorMsg(message);
        },
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to process article.');
    } finally {
      setIsGenerating(false);
    }
  };

  const handlePublish = async (publishStatus: 'publish' | 'draft') => {
    if (!activeJob) return;
    if (activeJob.extractionIncomplete && !extractionConfirmed) {
      setErrorMsg('Extraction incomplete (under 200 words). Please confirm you reviewed the extracted text before publishing.');
      return;
    }
    setErrorMsg(null);
    setIsPublishing(true);
    setEditingPage(null);

    try {
      await api.streamPublish(
        {
          jobId: activeJob.id,
          publishStatus,
          title: activeJob.title,
          pages: activeJob.pages,
          images: activeJob.images,
          seo: activeJob.seo,
          facebook: activeJob.facebook,
          extractionConfirmed,
        },
        {
          onStage: ({ stage, state, detail }) => {
            setStages((prev) => ({
              ...prev,
              [stage]: { state, detail },
            }));
          },
          onComplete: (updatedJob) => {
            onJobChange(updatedJob);
            onRefreshData();
          },
          onError: (message) => {
            setErrorMsg(message);
          },
        }
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Publishing failed.');
    } finally {
      setIsPublishing(false);
    }
  };

  const handleUpdatePageHtml = (pageNumber: number, nextHtml: string) => {
    if (!activeJob) return;
    const nextPages = activeJob.pages.map((p) =>
      p.pageNumber === pageNumber
        ? { ...p, html: nextHtml, wordCount: countWordsClient(nextHtml) }
        : p
    );
    const totalWords = nextPages.reduce((sum, p) => sum + p.wordCount, 0);
    onJobChange({ ...activeJob, pages: nextPages, totalWords });
  };

  const handleCopyFacebookPackage = async () => {
    if (!activeJob) return;
    const text = [
      activeJob.facebook.caption,
      '',
      activeJob.facebook.hashtags.join(' '),
      '',
      activeJob.wpPostUrl || activeJob.facebook.postUrl,
    ]
      .filter((line, idx, arr) => !(line === '' && arr[idx - 1] === ''))
      .join('\n');

    await copyTextToClipboard(text);
    setCopiedFb(true);
    setTimeout(() => setCopiedFb(false), 2200);
  };

  const handleCopyPostLink = async () => {
    if (!activeJob?.wpPostUrl) return;
    await copyTextToClipboard(activeJob.wpPostUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const currentPage = activeJob?.pages.find((p) => p.pageNumber === activePageTab) ?? activeJob?.pages[0];
  const includedImagesCount = activeJob?.images.filter((i) => i.included).length ?? 0;
  const featuredImage =
    activeJob?.images.find((i) => i.isFeatured && i.included) ??
    activeJob?.images.find((i) => i.included) ??
    activeJob?.images[0];

  useEffect(() => {
    setFeaturedPreviewFailed(false);
  }, [featuredImage?.sourceUrl, featuredImage?.wpSourceUrl]);

  const escapeAttr = (val: string) =>
    val.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const applyFeaturedImage = (newSrc: string, customAlt?: string) => {
    if (!activeJob) return;
    const cleanSrc = newSrc.trim();
    if (!cleanSrc) return;

    const altText = (customAlt ?? featuredImage?.alt ?? activeJob.title).trim() || activeJob.title;
    const newId = `featured-${Date.now()}`;
    const existingWithoutOldFeatured = activeJob.images.map((img) => ({
      ...img,
      isFeatured: false,
    }));

    const replacedExisting = featuredImage
      ? existingWithoutOldFeatured.map((img) =>
          img.id === featuredImage.id
            ? {
                ...img,
                sourceUrl: cleanSrc,
                alt: altText,
                included: true,
                isFeatured: true,
                assignedPage: 1,
                wpMediaId: undefined,
                wpSourceUrl: undefined,
                uploadError: undefined,
              }
            : img
        )
      : [
          {
            id: newId,
            sourceUrl: cleanSrc,
            alt: altText,
            included: true,
            isFeatured: true,
            assignedPage: 1,
          },
          ...existingWithoutOldFeatured,
        ];

    const figHtml = `<figure class="wp-block-image s7-featured-image"><img src="${escapeAttr(cleanSrc)}" alt="${escapeAttr(altText)}" /></figure>`;
    const updatedPages = activeJob.pages.map((page) => {
      if (page.pageNumber !== 1) return page;
      let html = page.html;
      if (/<figure[^>]*class="[^"]*s7-featured-image[^"]*"[\s\S]*?<\/figure>/i.test(html)) {
        html = html.replace(/<figure[^>]*class="[^"]*s7-featured-image[^"]*"[\s\S]*?<\/figure>/i, figHtml);
      } else if (/<figure[\s\S]*?<\/figure>/i.test(html)) {
        html = html.replace(/<figure[\s\S]*?<\/figure>/i, figHtml);
      } else if (html.includes('<p class="s7-page-hook">')) {
        html = html.replace(/(<p class="s7-page-hook">[\s\S]*?<\/p>)/i, `$1\n\n${figHtml}`);
      } else {
        html = `${figHtml}\n\n${html}`;
      }
      return { ...page, html, wordCount: countWordsClient(html) };
    });

    const nextJob: EditorialJob = {
      ...activeJob,
      images: replacedExisting,
      pages: updatedPages,
    };
    onJobChange(nextJob);
    void api.updateJob(activeJob.id, { images: replacedExisting, pages: updatedPages });
  };

  const handleSetExistingAsFeatured = (targetImg: ArticleImage) => {
    if (!activeJob) return;
    const nextImages = activeJob.images.map((img) =>
      img.id === targetImg.id
        ? { ...img, isFeatured: true, included: true, assignedPage: 1 }
        : { ...img, isFeatured: false }
    );
    const src = targetImg.wpSourceUrl || targetImg.sourceUrl;
    const figHtml = `<figure class="wp-block-image s7-featured-image"><img src="${escapeAttr(src)}" alt="${escapeAttr(targetImg.alt)}" /></figure>`;
    const updatedPages = activeJob.pages.map((page) => {
      if (page.pageNumber !== 1) return page;
      let html = page.html;
      if (/<figure[^>]*class="[^"]*s7-featured-image[^"]*"[\s\S]*?<\/figure>/i.test(html)) {
        html = html.replace(/<figure[^>]*class="[^"]*s7-featured-image[^"]*"[\s\S]*?<\/figure>/i, figHtml);
      } else if (html.includes('<p class="s7-page-hook">')) {
        html = html.replace(/(<p class="s7-page-hook">[\s\S]*?<\/p>)/i, `$1\n\n${figHtml}`);
      } else {
        html = `${figHtml}\n\n${html}`;
      }
      return { ...page, html, wordCount: countWordsClient(html) };
    });
    onJobChange({ ...activeJob, images: nextImages, pages: updatedPages });
    void api.updateJob(activeJob.id, { images: nextImages, pages: updatedPages });
  };

  const handleReplaceWithUrl = () => {
    const trimmed = featuredUrlInput.trim();
    if (!trimmed) return;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        setErrorMsg('Please enter an image URL starting with https:// or http://.');
        return;
      }
      setErrorMsg(null);
      applyFeaturedImage(parsed.toString());
      setFeaturedUrlInput('');
    } catch {
      setErrorMsg('Please enter a valid image URL.');
    }
  };

  const handleFeaturedFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
    if (!allowed.includes(file.type)) {
      setErrorMsg('Please choose a JPG, PNG, WebP, GIF, or AVIF image file.');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setErrorMsg('Uploaded image must be 8MB or smaller.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setErrorMsg(null);
        applyFeaturedImage(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="mx-auto w-full max-w-[1160px] space-y-8 px-4 py-8 sm:px-8">
      {/* Page Header */}
      <header className="space-y-1.5">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900 dark:text-white">
          AdamAPP
        </h1>
        <p className="text-[15px] text-slate-600 dark:text-slate-400">
          Bring in an article, refine it with AI, review every change, and publish it to the site.
        </p>
      </header>

      {/* 1. CHOOSE DESTINATION */}
      <section aria-labelledby="dest-heading" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2
            id="dest-heading"
            className="text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400"
          >
            Choose destination
          </h2>
          {sites.length > 0 && (
            <button
              type="button"
              onClick={onGoToSettings}
              className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
            >
              Manage sites
            </button>
          )}
        </div>

        {sites.length === 0 ? (
          <div className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-dashed border-slate-300 bg-white p-6 sm:flex-row sm:items-center dark:border-white/[0.12] dark:bg-[#111827]">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-slate-900 dark:text-white">
                No WordPress destination configured yet
              </div>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Add your WordPress site URL, username, and Application Password in Settings to start publishing.
              </p>
            </div>
            <button
              type="button"
              onClick={onGoToSettings}
              className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-gradient-to-r from-[#2563EB] to-[#6366F1] px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-95"
            >
              <Plus className="h-4 w-4" />
              <span>Add WordPress site</span>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sites.map((site) => {
              const selected = site.id === selectedSiteId;
              const estPages = Math.max(1, Math.round(site.minTotalWords / site.targetWordsPerPage));
              return (
                <button
                  key={site.id}
                  type="button"
                  onClick={() => setSelectedSiteId(site.id)}
                  className={`group flex flex-col items-start justify-between rounded-2xl border p-5 text-left transition-all duration-150 hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
                    selected
                      ? 'border-blue-600 bg-white ring-2 ring-blue-600/15 dark:border-blue-500 dark:bg-[#111827] dark:ring-blue-500/20 dark:shadow-[0_0_24px_-6px_rgba(37,99,235,0.45)]'
                      : 'border-slate-200/90 bg-white hover:border-slate-300 dark:border-white/[0.08] dark:bg-[#111827] dark:hover:border-white/[0.16]'
                  }`}
                >
                  <div className="flex w-full items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-base font-semibold text-slate-900 dark:text-white">
                        {site.name}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                        {site.url.replace(/^https?:\/\//, '')}
                      </div>
                    </div>
                    <div
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors ${
                        selected
                          ? 'border-blue-600 bg-blue-600 text-white'
                          : 'border-slate-300 text-transparent dark:border-white/[0.15]'
                      }`}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
                    <Globe className="h-3.5 w-3.5 text-slate-400" />
                    <span>{site.language}</span>
                    <span aria-hidden="true">·</span>
                    <span className="tabular-nums">{estPages} pages</span>
                    <span aria-hidden="true">·</span>
                    <span>Images and pagination included</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* 2. URL INPUT + START */}
      <section className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-2xs dark:border-white/[0.08] dark:bg-[#111827] dark:shadow-none">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleStart();
          }}
          className="flex flex-col gap-3 sm:flex-row sm:items-center"
        >
          <div className="relative flex-1">
            <Link2 className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="Paste article URL or Facebook redirect link (l.facebook.com/l.php?u=...)..."
              aria-label="Source article URL"
              className="w-full rounded-xl border border-slate-200 bg-slate-50/60 py-3 pr-4 pl-10 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600/20 dark:border-white/[0.1] dark:bg-[#0B0F1A] dark:text-white dark:placeholder:text-slate-500 dark:focus:bg-[#0B0F1A]"
            />
          </div>
          <div className="flex items-center justify-end gap-3 shrink-0">
            <button
              type="button"
              role="switch"
              aria-checked={aiRewrite}
              disabled={isGenerating || isPublishing}
              onClick={() => setAiRewrite((prev) => !prev)}
              title={aiRewrite ? 'AI rewrite enabled' : 'Copy mode (no AI rewriting)'}
              className="inline-flex items-center gap-2.5 rounded-xl border border-slate-200/90 bg-slate-50/70 px-3 py-2.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100/80 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.1] dark:bg-[#0B0F1A] dark:text-slate-300 dark:hover:bg-white/[0.06]"
            >
              <span>AI rewrite</span>
              <span
                className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150 ${
                  aiRewrite ? 'bg-blue-600' : 'bg-slate-300 dark:bg-slate-700'
                }`}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-xs transition-transform duration-150 ${
                    aiRewrite ? 'translate-x-4.5' : 'translate-x-1'
                  }`}
                />
              </span>
              <span
                className={`font-mono text-[11px] font-semibold ${
                  aiRewrite ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                {aiRewrite ? 'ON' : 'OFF'}
              </span>
            </button>

            <button
              type="submit"
              disabled={isGenerating || isPublishing || sites.length === 0}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#2563EB] to-[#6366F1] px-6 py-3 text-sm font-semibold text-white shadow-sm transition-all duration-150 hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Processing...</span>
                </>
              ) : (
                <>
                  <span>Start</span>
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </div>
        </form>

        {fbPreview.isFb && fbPreview.decoded && (
          <div className="mt-3 flex items-center gap-2 text-xs text-blue-700 dark:text-blue-300">
            <Share2 className="h-3.5 w-3.5 shrink-0" />
            <span className="font-medium">Facebook link detected:</span>
            <span className="truncate font-mono">{fbPreview.decoded}</span>
          </div>
        )}
      </section>

      {/* Error Alert */}
      {errorMsg && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-800 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-300"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-0.5">
            <div className="font-semibold">Workflow paused</div>
            <p>{errorMsg}</p>
          </div>
        </div>
      )}

      {/* 3. PROGRESS PIPELINE */}
      <section aria-label="Editorial workflow progress" className="space-y-2.5">
        {(() => {
          const useCopyPipeline = isPublishing && activeJob?.mode
            ? activeJob.mode === 'copy'
            : !aiRewrite;
          const visibleSteps = useCopyPipeline ? COPY_PIPELINE_STEPS : AI_PIPELINE_STEPS;
          return (
            <div className="flex flex-wrap items-center gap-2">
              {visibleSteps.map((step, idx) => {
                const current = stages[step.id];
                const state = current.state;
                return (
                  <div key={step.id} className="flex items-center gap-2">
                    <div
                      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-all duration-200 ${
                        state === 'done'
                          ? 'border-emerald-500/25 bg-emerald-50 text-emerald-700 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300'
                          : state === 'active'
                          ? 'border-blue-500/40 bg-blue-50 text-blue-700 shadow-xs dark:border-blue-400/40 dark:bg-blue-500/15 dark:text-blue-300'
                          : state === 'error'
                          ? 'border-red-500/30 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
                          : 'border-slate-200/80 bg-white text-slate-500 dark:border-white/[0.08] dark:bg-[#111827] dark:text-slate-400'
                      }`}
                    >
                      {state === 'active' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {state === 'done' && <CheckCircle2 className="h-3.5 w-3.5" />}
                      {state === 'error' && <AlertCircle className="h-3.5 w-3.5" />}
                      <span>{step.label}</span>
                    </div>
                    {idx < visibleSteps.length - 1 && (
                      <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                        ›
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()}

        {/* Live pipeline step detail */}
        {Object.values(stages).some((s) => s.state === 'active' && s.detail) && (
          <p className="text-xs font-medium text-blue-600 dark:text-blue-400">
            {Object.values(stages).find((s) => s.state === 'active')?.detail}
          </p>
        )}
      </section>

      {/* Skeleton loader while generating initial article */}
      {isGenerating && !activeJob && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-24 rounded-2xl border border-slate-200/80 bg-white p-5 dark:border-white/[0.08] dark:bg-[#111827]"
              >
                <div className="skeleton-shimmer h-3 w-16 rounded" />
                <div className="skeleton-shimmer mt-3 h-7 w-24 rounded" />
              </div>
            ))}
          </div>
          <div className="h-72 rounded-2xl border border-slate-200/80 bg-white p-6 dark:border-white/[0.08] dark:bg-[#111827]">
            <div className="skeleton-shimmer h-6 w-2/3 rounded" />
            <div className="skeleton-shimmer mt-4 h-4 w-full rounded" />
            <div className="skeleton-shimmer mt-2 h-4 w-11/12 rounded" />
            <div className="skeleton-shimmer mt-2 h-4 w-4/5 rounded" />
          </div>
        </div>
      )}

      {/* 4. STAT CARDS + 5. REFINED RESULT CARD + 6. IMAGES */}
      {activeJob && (
        <div className="space-y-8 transition-opacity duration-200">
          {/* Stat Cards */}
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-2xl border border-slate-200/90 bg-white p-5 dark:border-white/[0.08] dark:bg-[#111827]">
              <div className="text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">
                Words
              </div>
              <div className="mt-2 flex items-baseline gap-2.5">
                <span className="font-mono text-2xl font-semibold tabular-nums text-slate-900 dark:text-white">
                  {activeJob.totalWords.toLocaleString()}
                </span>
                <span
                  className={`text-xs ${
                    activeJob.extractionIncomplete
                      ? 'font-medium text-amber-600 dark:text-amber-400'
                      : 'text-slate-500 dark:text-slate-400'
                  }`}
                >
                  {activeJob.extractionIncomplete
                    ? 'Extraction incomplete (< 200w)'
                    : activeJob.mode === 'copy'
                    ? 'Copy mode'
                    : activeJob.expansionAttempts > 0
                    ? `Expanded (${activeJob.expansionAttempts}x)`
                    : '900+ verified'}
                </span>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200/90 bg-white p-5 dark:border-white/[0.08] dark:bg-[#111827]">
              <div className="text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">
                Pages
              </div>
              <div className="mt-2 flex items-baseline gap-2.5">
                <span className="font-mono text-2xl font-semibold tabular-nums text-slate-900 dark:text-white">
                  {activeJob.pages.length}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  &lt;!--nextpage--&gt; split
                </span>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200/90 bg-white p-5 dark:border-white/[0.08] dark:bg-[#111827]">
              <div className="text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">
                Images
              </div>
              <div className="mt-2 flex items-baseline gap-2.5">
                <span className="font-mono text-2xl font-semibold tabular-nums text-slate-900 dark:text-white">
                  {includedImagesCount}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  of {activeJob.images.length} extracted
                </span>
              </div>
            </div>
          </section>

          {/* Refined Result Card */}
          <section className="overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-2xs dark:border-white/[0.08] dark:bg-[#111827] dark:shadow-none">
            {/* Card Header */}
            <div className="flex flex-col justify-between gap-4 border-b border-slate-200/80 p-6 lg:flex-row lg:items-center dark:border-white/[0.08]">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                    {activeJob.mode === 'copy' ? 'Copy mode' : 'Refined'}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold tracking-wide uppercase ${
                      activeJob.status === 'published'
                        ? 'border-blue-500/25 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/15 dark:text-blue-300'
                        : 'border-emerald-500/25 bg-emerald-50 text-emerald-700 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300'
                    }`}
                  >
                    <CheckCircle2 className="h-3 w-3" />
                    <span>
                      {activeJob.status === 'published'
                        ? 'PUBLISHED'
                        : activeJob.status === 'draft'
                        ? 'DRAFT SAVED'
                        : 'READY'}
                    </span>
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {activeJob.siteName} · {activeJob.language}
                  </span>
                </div>

                <input
                  type="text"
                  value={activeJob.title}
                  onChange={(e) => onJobChange({ ...activeJob, title: e.target.value })}
                  aria-label="Article title"
                  className="w-full bg-transparent text-xl font-semibold tracking-tight text-slate-900 focus:outline-none dark:text-white"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                <button
                  type="button"
                  disabled={isPublishing || isGenerating}
                  onClick={() => void handleStart(activeJob.originalInputUrl)}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-slate-200 dark:hover:bg-white/[0.06]"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>Regenerate</span>
                </button>

                <button
                  type="button"
                  disabled={
                    isPublishing ||
                    isGenerating ||
                    Boolean(activeJob.extractionIncomplete && !extractionConfirmed)
                  }
                  onClick={() => void handlePublish('draft')}
                  title={
                    activeJob.extractionIncomplete && !extractionConfirmed
                      ? 'Confirm incomplete extraction warning below to enable publishing'
                      : undefined
                  }
                  className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-slate-200 dark:hover:bg-white/[0.06]"
                >
                  <Save className="h-3.5 w-3.5" />
                  <span>Save as draft</span>
                </button>

                <button
                  type="button"
                  disabled={
                    isPublishing ||
                    isGenerating ||
                    Boolean(activeJob.extractionIncomplete && !extractionConfirmed)
                  }
                  onClick={() => void handlePublish('publish')}
                  title={
                    activeJob.extractionIncomplete && !extractionConfirmed
                      ? 'Confirm incomplete extraction warning below to enable publishing'
                      : undefined
                  }
                  className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-[#2563EB] to-[#6366F1] px-4 py-2 text-xs font-semibold text-white shadow-sm transition-opacity hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isPublishing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                  <span>{isPublishing ? 'Publishing...' : 'Publish'}</span>
                </button>
              </div>
            </div>

            {/* Extraction Incomplete (< 200 words) Warning + Confirmation Gate */}
            {activeJob.extractionIncomplete && (
              <div
                role="alert"
                className="flex flex-col gap-3 border-b border-amber-300/80 bg-amber-50 px-6 py-4 text-xs text-amber-950 sm:flex-row sm:items-center sm:justify-between dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-100"
              >
                <div className="flex items-start gap-2.5">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <div className="space-y-0.5">
                    <div className="font-semibold">Extraction incomplete</div>
                    <p className="text-amber-900/90 dark:text-amber-200/90">
                      Only {activeJob.totalWords} words were extracted (under 200 words). Review the content below and confirm before publishing to WordPress.
                    </p>
                  </div>
                </div>
                <label className="inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-xl border border-amber-300 bg-white px-3.5 py-2 font-semibold text-amber-950 transition-colors hover:bg-amber-100/60 dark:border-amber-400/30 dark:bg-[#0B0F1A] dark:text-amber-100 dark:hover:bg-white/[0.06]">
                  <input
                    type="checkbox"
                    checked={extractionConfirmed}
                    onChange={(e) => setExtractionConfirmed(e.target.checked)}
                    className="h-4 w-4 rounded border-amber-400 text-blue-600 focus:ring-blue-600"
                  />
                  <span>Confirm &amp; allow publish</span>
                </label>
              </div>
            )}

            {/* Missing Recipe Data Notice */}
            {activeJob.hasRecipeData === false && activeJob.recipeNotice && (
              <div className="flex items-start gap-2.5 border-b border-amber-200/70 bg-amber-50/70 px-6 py-3 text-xs text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <span>{activeJob.recipeNotice}</span>
              </div>
            )}

            {/* Post Link Banner after Publish/Draft */}
            {activeJob.wpPostUrl && (
              <div className="flex flex-col justify-between gap-3 border-b border-emerald-200/70 bg-emerald-50/70 px-6 py-3.5 sm:flex-row sm:items-center dark:border-emerald-500/20 dark:bg-emerald-500/10">
                <div className="flex min-w-0 items-center gap-2 text-sm text-emerald-900 dark:text-emerald-200">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span className="font-medium">
                    {activeJob.wpPostStatus === 'publish' ? 'Live on WordPress:' : 'Saved as draft:'}
                  </span>
                  <a
                    href={activeJob.wpPostUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 truncate font-mono text-xs underline hover:opacity-80"
                  >
                    <span className="truncate">{activeJob.wpPostUrl}</span>
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => void handleCopyPostLink()}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-emerald-300/80 bg-white px-3.5 py-1.5 text-xs font-semibold text-emerald-800 transition-colors hover:bg-emerald-100/70 dark:border-emerald-500/30 dark:bg-[#0B0F1A] dark:text-emerald-200 dark:hover:bg-white/[0.06]"
                  >
                    {!copiedLink && <Link2 className="h-3.5 w-3.5" />}
                    <span>{copiedLink ? 'Copied ✓' : 'Copy link'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyFacebookPackage}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-700"
                  >
                    {copiedFb ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    <span>{copiedFb ? 'Copied!' : 'Copy Facebook package'}</span>
                  </button>
                </div>
              </div>
            )}

            {/* Featured Image Preview + Replace / Upload */}
            <div className="flex flex-col gap-4 border-b border-slate-200/80 bg-slate-50/40 p-5 sm:flex-row sm:items-center dark:border-white/[0.08] dark:bg-white/[0.015]">
              <div className="h-24 w-36 shrink-0 overflow-hidden rounded-xl border border-slate-200/80 bg-slate-100 dark:border-white/[0.08] dark:bg-[#0B0F1A]">
                {featuredImage && !featuredPreviewFailed ? (
                  <img
                    src={featuredImage.wpSourceUrl || featuredImage.sourceUrl}
                    alt={featuredImage.alt}
                    referrerPolicy="no-referrer"
                    onError={() => setFeaturedPreviewFailed(true)}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-center text-[11px] text-slate-400">
                    <ImageIcon className="h-5 w-5" />
                    <span>{featuredImage ? 'Server upload ready' : 'No featured image'}</span>
                  </div>
                )}
              </div>

              <div className="min-w-0 flex-1 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-slate-900 dark:text-white">
                      Featured image · Top of Page 1
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      Automatically sets the WordPress featured image and opens Page 1.
                    </p>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                    onChange={handleFeaturedFileUpload}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-slate-200 dark:hover:bg-white/[0.08]"
                  >
                    <Upload className="h-3.5 w-3.5" />
                    <span>Upload image</span>
                  </button>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="url"
                    value={featuredUrlInput}
                    onChange={(e) => setFeaturedUrlInput(e.target.value)}
                    placeholder="Paste another high-res image URL to replace..."
                    aria-label="Replacement featured image URL"
                    className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none dark:border-white/[0.08] dark:bg-[#0B0F1A] dark:text-white"
                  />
                  <button
                    type="button"
                    disabled={!featuredUrlInput.trim()}
                    onClick={handleReplaceWithUrl}
                    className="inline-flex shrink-0 items-center justify-center rounded-xl bg-slate-900 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-slate-800 disabled:opacity-40 dark:bg-blue-600 dark:hover:bg-blue-700"
                  >
                    Use URL
                  </button>
                </div>
              </div>
            </div>

            {/* Page-by-Page Preview Tabs */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/80 bg-slate-50/70 px-6 py-3 dark:border-white/[0.08] dark:bg-white/[0.02]">
              <div role="tablist" aria-label="Article pages" className="flex flex-wrap items-center gap-1.5">
                {activeJob.pages.map((page) => {
                  const active = page.pageNumber === activePageTab;
                  return (
                    <button
                      key={page.pageNumber}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => {
                        setActivePageTab(page.pageNumber);
                        setEditingPage(null);
                      }}
                      className={`inline-flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-all ${
                        active
                          ? 'bg-white text-slate-900 shadow-xs ring-1 ring-slate-200/80 dark:bg-slate-800 dark:text-white dark:ring-white/[0.1]'
                          : 'text-slate-600 hover:bg-white/60 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/[0.04] dark:hover:text-slate-200'
                      }`}
                    >
                      <span>Page {page.pageNumber}</span>
                      <span className="font-mono text-[11px] tabular-nums text-slate-400 dark:text-slate-500">
                        {page.wordCount}w
                      </span>
                    </button>
                  );
                })}
              </div>

              {currentPage && (
                <button
                  type="button"
                  onClick={() => {
                    if (editingPage === currentPage.pageNumber) {
                      setEditingPage(null);
                      void api.updateJob(activeJob.id, {
                        title: activeJob.title,
                        pages: activeJob.pages,
                        images: activeJob.images,
                        seo: activeJob.seo,
                        facebook: activeJob.facebook,
                      });
                    } else {
                      setEditingPage(currentPage.pageNumber);
                    }
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-white/[0.08] dark:bg-[#0B0F1A] dark:text-slate-300 dark:hover:bg-white/[0.05]"
                >
                  {editingPage === currentPage.pageNumber ? (
                    <>
                      <Eye className="h-3.5 w-3.5" />
                      <span>Preview</span>
                    </>
                  ) : (
                    <>
                      <Edit3 className="h-3.5 w-3.5" />
                      <span>Edit page</span>
                    </>
                  )}
                </button>
              )}
            </div>

            {/* Active Page Content */}
            {currentPage && (
              <div className="p-6">
                <div className="mb-4 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                  <span>
                    Page {currentPage.pageNumber} of {activeJob.pages.length}
                  </span>
                  <span className="font-mono tabular-nums">{currentPage.wordCount} words</span>
                </div>

                {editingPage === currentPage.pageNumber ? (
                  <textarea
                    value={currentPage.html}
                    onChange={(e) => handleUpdatePageHtml(currentPage.pageNumber, e.target.value)}
                    rows={16}
                    aria-label={`Edit Page ${currentPage.pageNumber} HTML`}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50/60 p-4 font-mono text-xs leading-relaxed text-slate-800 focus:border-blue-600 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600/20 dark:border-white/[0.1] dark:bg-[#0B0F1A] dark:text-slate-200"
                  />
                ) : (
                  <SafeArticlePreview html={currentPage.html} />
                )}

                {/* Visible Page Break Divider */}
                {currentPage.pageNumber < activeJob.pages.length && (
                  <div className="mt-8 flex items-center gap-3">
                    <div className="h-px flex-1 border-t border-dashed border-slate-300 dark:border-white/[0.14]" />
                    <button
                      type="button"
                      onClick={() => setActivePageTab(currentPage.pageNumber + 1)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1 font-mono text-[11px] font-medium text-slate-600 transition-colors hover:border-blue-400 hover:text-blue-600 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-slate-300 dark:hover:text-blue-400"
                    >
                      <Scissors className="h-3 w-3" />
                      <span>&lt;!--nextpage--&gt; · Continue to Page {currentPage.pageNumber + 1}</span>
                    </button>
                    <div className="h-px flex-1 border-t border-dashed border-slate-300 dark:border-white/[0.14]" />
                  </div>
                )}
              </div>
            )}

            {/* SEO & Facebook Package Split */}
            <div className="grid grid-cols-1 divide-y divide-slate-200/80 border-t border-slate-200/80 lg:grid-cols-2 lg:divide-x lg:divide-y-0 dark:divide-white/[0.08] dark:border-white/[0.08]">
              {/* SEO Metadata */}
              <div className="space-y-4 p-6">
                <div className="text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">
                  SEO Metadata
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
                      Meta title
                    </label>
                    <input
                      type="text"
                      value={activeJob.seo.metaTitle}
                      onChange={(e) =>
                        onJobChange({ ...activeJob, seo: { ...activeJob.seo, metaTitle: e.target.value } })
                      }
                      className="w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2 text-xs text-slate-900 focus:border-blue-600 focus:outline-none dark:border-white/[0.08] dark:bg-[#0B0F1A] dark:text-slate-100"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
                      Meta description
                    </label>
                    <textarea
                      rows={2}
                      value={activeJob.seo.metaDescription}
                      onChange={(e) =>
                        onJobChange({
                          ...activeJob,
                          seo: { ...activeJob.seo, metaDescription: e.target.value },
                        })
                      }
                      className="w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2 text-xs text-slate-900 focus:border-blue-600 focus:outline-none dark:border-white/[0.08] dark:bg-[#0B0F1A] dark:text-slate-100"
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
                        Slug
                      </label>
                      <input
                        type="text"
                        value={activeJob.seo.slug}
                        onChange={(e) =>
                          onJobChange({ ...activeJob, seo: { ...activeJob.seo, slug: e.target.value } })
                        }
                        className="w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2 font-mono text-xs text-slate-900 focus:border-blue-600 focus:outline-none dark:border-white/[0.08] dark:bg-[#0B0F1A] dark:text-slate-100"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
                        Category
                      </label>
                      <input
                        type="text"
                        value={activeJob.seo.category}
                        onChange={(e) =>
                          onJobChange({ ...activeJob, seo: { ...activeJob.seo, category: e.target.value } })
                        }
                        className="w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2 text-xs text-slate-900 focus:border-blue-600 focus:outline-none dark:border-white/[0.08] dark:bg-[#0B0F1A] dark:text-slate-100"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
                      Tags (comma separated)
                    </label>
                    <input
                      type="text"
                      value={activeJob.seo.tags.join(', ')}
                      onChange={(e) =>
                        onJobChange({
                          ...activeJob,
                          seo: {
                            ...activeJob.seo,
                            tags: e.target.value
                              .split(',')
                              .map((t) => t.trim())
                              .filter(Boolean),
                          },
                        })
                      }
                      className="w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2 text-xs text-slate-900 focus:border-blue-600 focus:outline-none dark:border-white/[0.08] dark:bg-[#0B0F1A] dark:text-slate-100"
                    />
                  </div>
                </div>
              </div>

              {/* Facebook Package */}
              <div className="space-y-4 p-6">
                <div className="flex items-center justify-between">
                  <div className="text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">
                    Facebook Package
                  </div>
                  <button
                    type="button"
                    onClick={handleCopyFacebookPackage}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-slate-200 dark:hover:bg-white/[0.06]"
                  >
                    {copiedFb ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                    <span>{copiedFb ? 'Copied' : 'Copy Facebook package'}</span>
                  </button>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
                      Hook caption
                    </label>
                    <textarea
                      rows={4}
                      value={activeJob.facebook.caption}
                      onChange={(e) =>
                        onJobChange({
                          ...activeJob,
                          facebook: { ...activeJob.facebook, caption: e.target.value },
                        })
                      }
                      className="w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2 text-xs leading-relaxed text-slate-900 focus:border-blue-600 focus:outline-none dark:border-white/[0.08] dark:bg-[#0B0F1A] dark:text-slate-100"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
                      Hashtags (3–5)
                    </label>
                    <input
                      type="text"
                      value={activeJob.facebook.hashtags.join(' ')}
                      onChange={(e) =>
                        onJobChange({
                          ...activeJob,
                          facebook: {
                            ...activeJob.facebook,
                            hashtags: e.target.value
                              .split(/\s+/)
                              .filter(Boolean)
                              .map((h) => (h.startsWith('#') ? h : `#${h}`)),
                          },
                        })
                      }
                      className="w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2 font-mono text-xs text-blue-700 focus:border-blue-600 focus:outline-none dark:border-white/[0.08] dark:bg-[#0B0F1A] dark:text-blue-300"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
                      Post link
                    </label>
                    <div className="truncate rounded-xl border border-slate-200/80 bg-slate-50/70 px-3 py-2 font-mono text-xs text-slate-600 dark:border-white/[0.08] dark:bg-[#0B0F1A] dark:text-slate-400">
                      {activeJob.wpPostUrl || activeJob.facebook.postUrl}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* 7. IMAGES SECTION */}
          <section aria-labelledby="images-heading" className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h2
                  id="images-heading"
                  className="text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400"
                >
                  Images
                </h2>
                <span className="font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">
                  {includedImagesCount} / {activeJob.images.length}
                </span>
              </div>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Spread across pages &amp; uploaded to WordPress Media Library on publish
              </span>
            </div>

            {activeJob.images.length === 0 ? (
              <div className="flex items-center gap-3 rounded-2xl border border-slate-200/80 bg-white p-6 text-sm text-slate-500 dark:border-white/[0.08] dark:bg-[#111827] dark:text-slate-400">
                <ImageIcon className="h-5 w-5 shrink-0 text-slate-400" />
                <span>No article images were detected in the source page.</span>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {activeJob.images.map((img) => (
                  <ImageThumbCard
                    key={img.id}
                    img={img}
                    totalPages={activeJob.pages.length}
                    onToggleInclude={() =>
                      onJobChange({
                        ...activeJob,
                        images: activeJob.images.map((item) =>
                          item.id === img.id ? { ...item, included: !item.included } : item
                        ),
                      })
                    }
                    onChangePage={(assignedPage) =>
                      onJobChange({
                        ...activeJob,
                        images: activeJob.images.map((item) =>
                          item.id === img.id ? { ...item, assignedPage } : item
                        ),
                      })
                    }
                    onChangeAlt={(alt) =>
                      onJobChange({
                        ...activeJob,
                        images: activeJob.images.map((item) =>
                          item.id === img.id ? { ...item, alt } : item
                        ),
                      })
                    }
                    onSetFeatured={() => handleSetExistingAsFeatured(img)}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
