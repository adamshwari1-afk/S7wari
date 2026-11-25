import { ArrowRight, Lock, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { api, setAuthToken } from '../lib/api';
import type { AuthStatus } from '../types';
import { ThemeToggle } from './ThemeToggle';

interface AuthGateProps {
  authStatus: AuthStatus;
  onAuthenticated: (email: string) => void;
}

export function AuthGate({ authStatus, onAuthenticated }: AuthGateProps) {
  const [email, setEmail] = useState(authStatus.ownerEmail ?? '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSetup = authStatus.needsSetup;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (isSetup && password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const res = isSetup ? await api.setupOwner(email, password) : await api.login(email, password);
      setAuthToken(res.token);
      onAuthenticated(res.email);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col justify-between bg-[#F7F8FB] px-4 py-8 text-slate-900 dark:bg-[#0B0F1A] dark:text-slate-100">
      <div className="mx-auto flex w-full max-w-md items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#2563EB] to-[#6366F1] text-white shadow-sm">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 7h16M4 12h10M4 17h16" strokeLinecap="round" />
              <circle cx="18" cy="12" r="2.2" fill="currentColor" stroke="none" />
            </svg>
          </div>
          <div>
            <div className="text-base font-semibold tracking-tight">S7wari</div>
            <div className="text-[11px] font-medium tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">
              Editorial Workspace
            </div>
          </div>
        </div>
        <div className="w-48">
          <ThemeToggle />
        </div>
      </div>

      <div className="mx-auto my-10 w-full max-w-md rounded-2xl border border-slate-200/90 bg-white p-8 shadow-sm dark:border-white/[0.08] dark:bg-[#111827] dark:shadow-none">
        <div className="mb-6">
          <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400">
            {isSetup ? <ShieldCheck className="h-5 w-5" /> : <Lock className="h-5 w-5" />}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-white">
            {isSetup ? 'Claim owner access' : 'Sign in to S7wari'}
          </h1>
          <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
            {isSetup
              ? 'Set your private owner email and password to protect this Editorial Workspace.'
              : 'Enter your workspace credentials to rewrite, paginate, and publish articles.'}
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300"
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="auth-email" className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300">
              Owner email
            </label>
            <input
              id="auth-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@publication.com"
              className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20 dark:border-white/[0.1] dark:bg-[#0B0F1A] dark:text-white dark:placeholder:text-slate-500"
            />
          </div>

          <div>
            <label htmlFor="auth-password" className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300">
              Password
            </label>
            <input
              id="auth-password"
              type="password"
              required
              minLength={isSetup ? 8 : 1}
              autoComplete={isSetup ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isSetup ? 'Minimum 8 characters' : 'Enter your password'}
              className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20 dark:border-white/[0.1] dark:bg-[#0B0F1A] dark:text-white dark:placeholder:text-slate-500"
            />
          </div>

          {isSetup && (
            <div>
              <label htmlFor="auth-confirm" className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300">
                Confirm password
              </label>
              <input
                id="auth-confirm"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Repeat password"
                className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20 dark:border-white/[0.1] dark:bg-[#0B0F1A] dark:text-white dark:placeholder:text-slate-500"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#2563EB] to-[#6366F1] px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all duration-150 hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>{loading ? 'Verifying...' : isSetup ? 'Create owner account' : 'Sign in'}</span>
            <ArrowRight className="h-4 w-4" />
          </button>
        </form>
      </div>

      <p className="text-center text-xs text-slate-500 dark:text-slate-500">
        S7wari Editorial Workspace · Private single-owner publishing console
      </p>
    </div>
  );
}
