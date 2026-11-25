import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AuthGate } from './components/AuthGate';
import { EditorialStudio } from './components/EditorialStudio';
import { HistoryView } from './components/HistoryView';
import { SettingsView } from './components/SettingsView';
import { Sidebar, type NavSection } from './components/Sidebar';
import { api, getAuthToken, setAuthToken, setUnauthorizedHandler } from './lib/api';
import type { AuthStatus, EditorialJob, WordPressSite, WorkspaceStatus } from './types';

export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);

  const [activeNav, setActiveNav] = useState<NavSection>('studio');
  const [mobileOpen, setMobileOpen] = useState(false);

  const [sites, setSites] = useState<WordPressSite[]>([]);
  const [jobs, setJobs] = useState<EditorialJob[]>([]);
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [activeJob, setActiveJob] = useState<EditorialJob | null>(null);

  const loadAuthStatus = useCallback(async () => {
    try {
      const next = await api.getAuthStatus();
      setAuthStatus(next);
    } finally {
      setBooting(false);
    }
  }, []);

  const loadWorkspaceData = useCallback(async () => {
    if (!getAuthToken()) return;
    setLoadingJobs(true);
    try {
      const [sitesRes, jobsRes, statusRes] = await Promise.all([
        api.getSites(),
        api.getJobs(),
        api.getStatus(),
      ]);
      setSites(sitesRes.sites);
      setJobs(jobsRes.jobs);
      setStatus(statusRes);
    } catch {
      // handled cleanly by unauthorized interceptor if 401
    } finally {
      setLoadingJobs(false);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUserEmail(null);
      void loadAuthStatus();
    });
    void loadAuthStatus();
  }, [loadAuthStatus]);

  useEffect(() => {
    if (userEmail) {
      void loadWorkspaceData();
    }
  }, [userEmail, loadWorkspaceData]);

  const handleSignOut = async () => {
    try {
      await api.logout();
    } catch {
      // ignore
    }
    setAuthToken(null);
    setUserEmail(null);
    setActiveJob(null);
    void loadAuthStatus();
  };

  if (booting || !authStatus) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F7F8FB] dark:bg-[#0B0F1A]">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!userEmail) {
    return (
      <AuthGate
        authStatus={authStatus}
        onAuthenticated={(email) => {
          setUserEmail(email);
        }}
      />
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#F7F8FB] text-slate-900 lg:flex-row dark:bg-[#0B0F1A] dark:text-slate-100">
      <Sidebar
        activeNav={activeNav}
        onSelectNav={setActiveNav}
        status={status}
        userEmail={userEmail}
        onSignOut={() => void handleSignOut()}
        mobileOpen={mobileOpen}
        setMobileOpen={setMobileOpen}
      />

      <main className="min-w-0 flex-1">
        {activeNav === 'studio' && (
          <EditorialStudio
            sites={sites}
            activeJob={activeJob}
            onJobChange={setActiveJob}
            onGoToSettings={() => setActiveNav('settings')}
            onRefreshData={() => void loadWorkspaceData()}
          />
        )}

        {activeNav === 'history' && (
          <HistoryView
            jobs={jobs}
            loading={loadingJobs}
            onOpenJob={(job) => {
              setActiveJob(job);
              setActiveNav('studio');
            }}
            onRefresh={() => void loadWorkspaceData()}
          />
        )}

        {activeNav === 'settings' && (
          <SettingsView
            sites={sites}
            status={status}
            authStatus={authStatus}
            onRefresh={() => {
              void loadAuthStatus();
              void loadWorkspaceData();
            }}
          />
        )}
      </main>
    </div>
  );
}
