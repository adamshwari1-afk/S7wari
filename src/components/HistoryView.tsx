import { Check, Copy, ExternalLink, FileText, Link2, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { copyTextToClipboard } from '../lib/clipboard';
import type { EditorialJob, JobStatus } from '../types';

interface HistoryViewProps {
  jobs: EditorialJob[];
  loading: boolean;
  onOpenJob: (job: EditorialJob) => void;
  onRefresh: () => void;
}

export function HistoryView({ jobs, loading, onOpenJob, onRefresh }: HistoryViewProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | JobStatus>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs.filter((job) => {
      if (filter !== 'all' && job.status !== filter) return false;
      if (!q) return true;
      return (
        job.title.toLowerCase().includes(q) ||
        job.siteName.toLowerCase().includes(q) ||
        job.resolvedUrl.toLowerCase().includes(q)
      );
    });
  }, [jobs, query, filter]);

  const handleCopyFb = async (job: EditorialJob) => {
    const text = [
      job.facebook.caption,
      '',
      job.facebook.hashtags.join(' '),
      '',
      job.wpPostUrl || job.facebook.postUrl,
    ].join('\n');
    await copyTextToClipboard(text);
    setCopiedId(job.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleCopyLink = async (job: EditorialJob) => {
    if (!job.wpPostUrl) return;
    await copyTextToClipboard(job.wpPostUrl);
    setCopiedLinkId(job.id);
    setTimeout(() => setCopiedLinkId((prev) => (prev === job.id ? null : prev)), 2000);
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await api.deleteJob(id);
      onRefresh();
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1160px] space-y-6 px-4 py-8 sm:px-8">
      <header className="space-y-1.5">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900 dark:text-white">History</h1>
        <p className="text-[15px] text-slate-600 dark:text-slate-400">
          Review generated articles, reopen drafts in the studio, or copy Facebook sharing packages.
        </p>
      </header>

      {/* Search & Filter Toolbar */}
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title, site, or source URL..."
            className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pr-4 pl-10 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none dark:border-white/[0.08] dark:bg-[#111827] dark:text-white"
          />
        </div>

        <div className="inline-flex items-center gap-1 rounded-xl border border-slate-200/80 bg-white p-1 dark:border-white/[0.08] dark:bg-[#111827]">
          {(['all', 'published', 'draft', 'ready'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setFilter(tab)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize whitespace-nowrap transition-colors ${
                filter === tab
                  ? 'bg-slate-900 text-white dark:bg-blue-600'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-24 rounded-2xl border border-slate-200/80 bg-white p-5 dark:border-white/[0.08] dark:bg-[#111827]"
            >
              <div className="skeleton-shimmer h-4 w-1/2 rounded" />
              <div className="skeleton-shimmer mt-3 h-3 w-1/3 rounded" />
            </div>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!loading && filtered.length === 0 && (
        <div className="rounded-2xl border border-slate-200/90 bg-white p-10 text-center dark:border-white/[0.08] dark:bg-[#111827]">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-500 dark:bg-white/[0.05] dark:text-slate-400">
            <FileText className="h-5 w-5" />
          </div>
          <h2 className="mt-4 text-base font-semibold text-slate-900 dark:text-white">
            {jobs.length === 0 ? 'No articles processed yet' : 'No matching articles'}
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {jobs.length === 0
              ? 'Processed and published articles from Editorial studio will appear here.'
              : 'Try adjusting your search query or status filter.'}
          </p>
        </div>
      )}

      {/* Jobs List */}
      {!loading && filtered.length > 0 && (
        <div className="divide-y divide-slate-200/80 overflow-hidden rounded-2xl border border-slate-200/90 bg-white dark:divide-white/[0.08] dark:border-white/[0.08] dark:bg-[#111827]">
          {filtered.map((job) => (
            <div
              key={job.id}
              className="flex flex-col justify-between gap-4 p-5 transition-colors hover:bg-slate-50/70 lg:flex-row lg:items-center dark:hover:bg-white/[0.02]"
            >
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase ${
                      job.status === 'published'
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
                        : job.status === 'draft'
                        ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'
                        : 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300'
                    }`}
                  >
                    {job.status}
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {job.siteName} · {job.language}
                  </span>
                  <span className="text-xs text-slate-400 dark:text-slate-500" aria-hidden="true">
                    ·
                  </span>
                  <span className="font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">
                    {job.totalWords} words · {job.pages.length} pages · {job.images.filter((i) => i.included).length} images
                  </span>
                </div>

                <h3 className="truncate text-base font-semibold text-slate-900 dark:text-white">
                  {job.title}
                </h3>

                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <span className="truncate max-w-md">{job.resolvedUrl}</span>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">{new Date(job.updatedAt).toLocaleString()}</span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {job.wpPostUrl && (
                  <>
                    <a
                      href={job.wpPostUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-white/[0.1] dark:text-slate-200 dark:hover:bg-white/[0.05]"
                    >
                      <span>View post</span>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                    <button
                      type="button"
                      onClick={() => void handleCopyLink(job)}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-white/[0.1] dark:text-slate-200 dark:hover:bg-white/[0.05]"
                    >
                      {copiedLinkId !== job.id && <Link2 className="h-3.5 w-3.5" />}
                      <span>{copiedLinkId === job.id ? 'Copied ✓' : 'Copy link'}</span>
                    </button>
                  </>
                )}

                <button
                  type="button"
                  onClick={() => void handleCopyFb(job)}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-white/[0.1] dark:text-slate-200 dark:hover:bg-white/[0.05]"
                >
                  {copiedId === job.id ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                  <span>{copiedId === job.id ? 'Copied' : 'Copy FB'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => onOpenJob(job)}
                  className="inline-flex items-center rounded-xl bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
                >
                  Open in studio
                </button>

                <button
                  type="button"
                  disabled={deletingId === job.id}
                  onClick={() => void handleDelete(job.id)}
                  aria-label={`Delete ${job.title}`}
                  className="inline-flex items-center justify-center rounded-xl border border-slate-200 p-1.5 text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600 dark:border-white/[0.1] dark:text-slate-400 dark:hover:border-red-500/30 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
