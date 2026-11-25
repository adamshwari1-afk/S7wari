import {
  AlertCircle,
  CheckCircle2,
  Cpu,
  Edit3,
  Globe,
  Loader2,
  Plus,
  Shield,
  Trash2,
  Wifi,
} from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import type { AuthStatus, WordPressSite, WorkspaceStatus } from '../types';

interface SettingsViewProps {
  sites: WordPressSite[];
  status: WorkspaceStatus | null;
  authStatus: AuthStatus | null;
  onRefresh: () => void;
}

interface SiteFormState {
  id?: string;
  name: string;
  url: string;
  username: string;
  appPassword: string;
  language: string;
  targetWordsPerPage: number;
  minTotalWords: number;
}

const EMPTY_FORM: SiteFormState = {
  name: '',
  url: '',
  username: '',
  appPassword: '',
  language: 'Czech',
  targetWordsPerPage: 300,
  minTotalWords: 900,
};

export function SettingsView({ sites, status, authStatus, onRefresh }: SettingsViewProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<SiteFormState>(EMPTY_FORM);
  const [savingSite, setSavingSite] = useState(false);
  const [testingForm, setTestingForm] = useState(false);
  const [testingSiteId, setTestingSiteId] = useState<string | null>(null);
  const [siteFeedback, setSiteFeedback] = useState<{ ok: boolean; message: string } | null>(null);

  const [testingAi, setTestingAi] = useState(false);
  const [aiFeedback, setAiFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const [savingTone, setSavingTone] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newEmail, setNewEmail] = useState(authStatus?.ownerEmail ?? '');
  const [newPassword, setNewPassword] = useState('');
  const [savingCreds, setSavingCreds] = useState(false);
  const [credsFeedback, setCredsFeedback] = useState<{ ok: boolean; message: string } | null>(null);

  const openAddForm = () => {
    setForm(EMPTY_FORM);
    setSiteFeedback(null);
    setFormOpen(true);
  };

  const openEditForm = (site: WordPressSite) => {
    setForm({
      id: site.id,
      name: site.name,
      url: site.url,
      username: site.username,
      appPassword: '',
      language: site.language,
      targetWordsPerPage: site.targetWordsPerPage,
      minTotalWords: site.minTotalWords,
    });
    setSiteFeedback(null);
    setFormOpen(true);
  };

  const handleTestFormConnection = async () => {
    setTestingForm(true);
    setSiteFeedback(null);
    try {
      const res = await api.testSite({
        siteId: form.id,
        url: form.url,
        username: form.username,
        appPassword: form.appPassword || undefined,
      });
      setSiteFeedback({ ok: res.ok, message: res.message });
    } catch (err) {
      setSiteFeedback({ ok: false, message: err instanceof Error ? err.message : 'Test failed.' });
    } finally {
      setTestingForm(false);
    }
  };

  const handleSaveSite = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSite(true);
    setSiteFeedback(null);
    try {
      if (form.id) {
        await api.updateSite(form.id, {
          name: form.name,
          url: form.url,
          username: form.username,
          ...(form.appPassword ? { appPassword: form.appPassword } : {}),
          language: form.language,
          targetWordsPerPage: form.targetWordsPerPage,
          minTotalWords: form.minTotalWords,
        });
      } else {
        await api.createSite({
          name: form.name,
          url: form.url,
          username: form.username,
          appPassword: form.appPassword,
          language: form.language,
          targetWordsPerPage: form.targetWordsPerPage,
          minTotalWords: form.minTotalWords,
        });
      }
      setFormOpen(false);
      onRefresh();
    } catch (err) {
      setSiteFeedback({ ok: false, message: err instanceof Error ? err.message : 'Failed to save destination.' });
    } finally {
      setSavingSite(false);
    }
  };

  const handleTestSavedSite = async (siteId: string) => {
    setTestingSiteId(siteId);
    try {
      await api.testSite({ siteId });
      onRefresh();
    } finally {
      setTestingSiteId(null);
    }
  };

  const handleDeleteSite = async (siteId: string) => {
    await api.deleteSite(siteId);
    onRefresh();
  };

  const handleTestAi = async () => {
    setTestingAi(true);
    setAiFeedback(null);
    try {
      const res = await api.testAi();
      setAiFeedback({ ok: res.ok, message: res.message });
    } catch (err) {
      setAiFeedback({ ok: false, message: err instanceof Error ? err.message : 'AI test failed.' });
    } finally {
      setTestingAi(false);
    }
  };

  const handleToneChange = async (tone: 'editorial' | 'engaging' | 'informative') => {
    setSavingTone(true);
    try {
      await api.updateSettings(tone);
      onRefresh();
    } finally {
      setSavingTone(false);
    }
  };

  const handleUpdateCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingCreds(true);
    setCredsFeedback(null);
    try {
      const res = await api.updateCredentials(currentPassword, newEmail, newPassword || undefined);
      setCurrentPassword('');
      setNewPassword('');
      setCredsFeedback({ ok: true, message: `Updated owner credentials for ${res.email}.` });
      onRefresh();
    } catch (err) {
      setCredsFeedback({ ok: false, message: err instanceof Error ? err.message : 'Failed to update credentials.' });
    } finally {
      setSavingCreds(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1160px] space-y-8 px-4 py-8 sm:px-8">
      <header className="space-y-1.5">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900 dark:text-white">Settings</h1>
        <p className="text-[15px] text-slate-600 dark:text-slate-400">
          Manage WordPress publishing destinations, verify AI engine connectivity, and secure owner access.
        </p>
      </header>

      {/* 1. WordPress Destinations */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">
              WordPress Destinations
            </h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              Connect sites using WordPress Application Passwords for REST API publishing and media uploads.
            </p>
          </div>
          <button
            type="button"
            onClick={openAddForm}
            className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-[#2563EB] to-[#6366F1] px-4 py-2 text-xs font-semibold text-white shadow-sm hover:opacity-95"
          >
            <Plus className="h-4 w-4" />
            <span>Add destination</span>
          </button>
        </div>

        {/* Add / Edit Site Form */}
        {formOpen && (
          <form
            onSubmit={handleSaveSite}
            className="space-y-5 rounded-2xl border border-blue-200 bg-white p-6 shadow-xs dark:border-blue-500/30 dark:bg-[#111827]"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900 dark:text-white">
                {form.id ? 'Edit WordPress destination' : 'New WordPress destination'}
              </h3>
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="text-xs font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white"
              >
                Cancel
              </button>
            </div>

            {siteFeedback && (
              <div
                className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-xs font-medium ${
                  siteFeedback.ok
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300'
                    : 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-300'
                }`}
              >
                {siteFeedback.ok ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                ) : (
                  <AlertCircle className="h-4 w-4 shrink-0" />
                )}
                <span>{siteFeedback.message}</span>
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Destination name
                </label>
                <input
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Magazín Praha"
                  className="w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-white/[0.1] dark:bg-[#0B0F1A] dark:text-white"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300">
                  WordPress site URL
                </label>
                <input
                  type="url"
                  required
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  placeholder="https://example.cz"
                  className="w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-white/[0.1] dark:bg-[#0B0F1A] dark:text-white"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300">
                  WordPress username
                </label>
                <input
                  type="text"
                  required
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  placeholder="editor"
                  className="w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-white/[0.1] dark:bg-[#0B0F1A] dark:text-white"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Application Password {form.id ? '(leave blank to keep current)' : ''}
                </label>
                <input
                  type="password"
                  required={!form.id}
                  value={form.appPassword}
                  onChange={(e) => setForm({ ...form, appPassword: e.target.value })}
                  placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"
                  className="w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-2.5 font-mono text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-white/[0.1] dark:bg-[#0B0F1A] dark:text-white"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Target language
                </label>
                <input
                  type="text"
                  required
                  value={form.language}
                  onChange={(e) => setForm({ ...form, language: e.target.value })}
                  placeholder="Czech, English, German..."
                  className="w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-white/[0.1] dark:bg-[#0B0F1A] dark:text-white"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Words / page
                  </label>
                  <input
                    type="number"
                    min={150}
                    max={800}
                    value={form.targetWordsPerPage}
                    onChange={(e) => setForm({ ...form, targetWordsPerPage: Number(e.target.value) || 300 })}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-2.5 font-mono text-sm tabular-nums text-slate-900 focus:border-blue-600 focus:outline-none dark:border-white/[0.1] dark:bg-[#0B0F1A] dark:text-white"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Minimum words
                  </label>
                  <input
                    type="number"
                    min={300}
                    max={3000}
                    value={form.minTotalWords}
                    onChange={(e) => setForm({ ...form, minTotalWords: Number(e.target.value) || 900 })}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-2.5 font-mono text-sm tabular-nums text-slate-900 focus:border-blue-600 focus:outline-none dark:border-white/[0.1] dark:bg-[#0B0F1A] dark:text-white"
                  />
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-200/80 pt-4 dark:border-white/[0.08]">
              <button
                type="button"
                disabled={testingForm || !form.url || !form.username}
                onClick={() => void handleTestFormConnection()}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-white/[0.1] dark:text-slate-200 dark:hover:bg-white/[0.05]"
              >
                {testingForm ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />}
                <span>Test connection</span>
              </button>
              <button
                type="submit"
                disabled={savingSite}
                className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-5 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {savingSite ? 'Saving...' : form.id ? 'Save changes' : 'Add destination'}
              </button>
            </div>
          </form>
        )}

        {/* Sites List */}
        {sites.length === 0 && !formOpen ? (
          <div className="rounded-2xl border border-slate-200/90 bg-white p-8 text-center dark:border-white/[0.08] dark:bg-[#111827]">
            <Globe className="mx-auto h-6 w-6 text-slate-400" />
            <div className="mt-3 text-sm font-semibold text-slate-900 dark:text-white">
              No WordPress sites added yet
            </div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Click “Add destination” to configure your first publishing site.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-200/80 overflow-hidden rounded-2xl border border-slate-200/90 bg-white dark:divide-white/[0.08] dark:border-white/[0.08] dark:bg-[#111827]">
            {sites.map((site) => (
              <div
                key={site.id}
                className="flex flex-col justify-between gap-4 p-5 sm:flex-row sm:items-center"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold text-slate-900 dark:text-white">{site.name}</span>
                    {site.lastTestOk === true && (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        <span>Verified</span>
                      </span>
                    )}
                    {site.lastTestOk === false && (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400">
                        <AlertCircle className="h-3.5 w-3.5" />
                        <span>Connection failed</span>
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                    <span className="font-mono">{site.url}</span>
                    <span aria-hidden="true">·</span>
                    <span>{site.language}</span>
                    <span aria-hidden="true">·</span>
                    <span className="tabular-nums">
                      {site.targetWordsPerPage} words/page · min {site.minTotalWords} words
                    </span>
                  </div>
                  {site.lastTestMessage && (
                    <p className="text-xs text-slate-500 dark:text-slate-400">{site.lastTestMessage}</p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={testingSiteId === site.id}
                    onClick={() => void handleTestSavedSite(site.id)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-white/[0.1] dark:text-slate-200 dark:hover:bg-white/[0.05]"
                  >
                    {testingSiteId === site.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Wifi className="h-3.5 w-3.5" />
                    )}
                    <span>Test connection</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => openEditForm(site)}
                    className="inline-flex items-center gap-1 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-white/[0.1] dark:text-slate-200 dark:hover:bg-white/[0.05]"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                    <span>Edit</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeleteSite(site.id)}
                    aria-label={`Delete ${site.name}`}
                    className="inline-flex items-center justify-center rounded-xl border border-slate-200 p-1.5 text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600 dark:border-white/[0.1] dark:text-slate-400 dark:hover:border-red-500/30 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 2. AI Engine & Editorial Tone */}
      <section className="rounded-2xl border border-slate-200/90 bg-white p-6 dark:border-white/[0.08] dark:bg-[#111827]">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400">
              <Cpu className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-white">AI Rewriting Engine</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Powered by {status?.aiModel || 'gemini-2.5-flash'} via server environment secrets ({status?.aiConnected ? 'Configured' : 'Missing secret'}).
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={testingAi}
            onClick={() => void handleTestAi()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-white/[0.1] dark:text-slate-200 dark:hover:bg-white/[0.05]"
          >
            {testingAi ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />}
            <span>Test AI connection</span>
          </button>
        </div>

        {aiFeedback && (
          <div
            className={`mt-4 flex items-center gap-2 rounded-xl border px-4 py-3 text-xs font-medium ${
              aiFeedback.ok
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300'
                : 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-300'
            }`}
          >
            {aiFeedback.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
            <span>{aiFeedback.message}</span>
          </div>
        )}

        <div className="mt-5 border-t border-slate-200/80 pt-5 dark:border-white/[0.08]">
          <div className="mb-2 text-xs font-medium text-slate-700 dark:text-slate-300">
            Default editorial voice
          </div>
          <div className="inline-flex flex-wrap gap-2">
            {(['editorial', 'engaging', 'informative'] as const).map((tone) => {
              const active = status?.editorialTone === tone;
              return (
                <button
                  key={tone}
                  type="button"
                  disabled={savingTone}
                  onClick={() => void handleToneChange(tone)}
                  className={`rounded-xl border px-3.5 py-2 text-xs font-medium capitalize transition-colors ${
                    active
                      ? 'border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-500/15 dark:text-blue-300'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-white/[0.08] dark:text-slate-400 dark:hover:bg-white/[0.04]'
                  }`}
                >
                  {tone}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* 3. Owner Access */}
      <section className="rounded-2xl border border-slate-200/90 bg-white p-6 dark:border-white/[0.08] dark:bg-[#111827]">
        <div className="mb-5 flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700 dark:bg-white/[0.06] dark:text-slate-300">
            <Shield className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-white">Owner Login Protection</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {authStatus?.envManaged
                ? 'Owner credentials are managed by server environment variables (OWNER_EMAIL / OWNER_PASSWORD).'
                : 'Update the email or password required to sign in to S7wari.'}
            </p>
          </div>
        </div>

        {!authStatus?.envManaged && (
          <form onSubmit={handleUpdateCredentials} className="space-y-4">
            {credsFeedback && (
              <div
                className={`rounded-xl border px-4 py-3 text-xs font-medium ${
                  credsFeedback.ok
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300'
                    : 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-300'
                }`}
              >
                {credsFeedback.message}
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Owner email
                </label>
                <input
                  type="email"
                  required
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-white/[0.1] dark:bg-[#0B0F1A] dark:text-white"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Current password
                </label>
                <input
                  type="password"
                  required
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-white/[0.1] dark:bg-[#0B0F1A] dark:text-white"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300">
                  New password (optional)
                </label>
                <input
                  type="password"
                  minLength={8}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Min 8 characters"
                  className="w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-white/[0.1] dark:bg-[#0B0F1A] dark:text-white"
                />
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={savingCreds}
                className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
              >
                {savingCreds ? 'Updating...' : 'Update owner credentials'}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
