import { CheckCircle2, FilePenLine, History, LogOut, Menu, Settings, X } from 'lucide-react';
import type { WorkspaceStatus } from '../types';
import { ThemeToggle } from './ThemeToggle';

export type NavSection = 'studio' | 'history' | 'settings';

interface SidebarProps {
  activeNav: NavSection;
  onSelectNav: (nav: NavSection) => void;
  status: WorkspaceStatus | null;
  userEmail: string | null;
  onSignOut: () => void;
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
}

export function Sidebar({
  activeNav,
  onSelectNav,
  status,
  userEmail,
  onSignOut,
  mobileOpen,
  setMobileOpen,
}: SidebarProps) {
  const navItems: Array<{ id: NavSection; label: string; Icon: typeof FilePenLine }> = [
    { id: 'studio', label: 'Editorial studio', Icon: FilePenLine },
    { id: 'history', label: 'History', Icon: History },
    { id: 'settings', label: 'Settings', Icon: Settings },
  ];

  const handleNav = (id: NavSection) => {
    onSelectNav(id);
    setMobileOpen(false);
  };

  const sidebarBody = (
    <div className="flex h-full flex-col justify-between px-4 py-5">
      <div>
        {/* Brand */}
        <div className="mb-7 flex items-center justify-between px-2">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#2563EB] to-[#6366F1] text-white shadow-sm">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 7h16M4 12h10M4 17h16" strokeLinecap="round" />
                <circle cx="18" cy="12" r="2.2" fill="currentColor" stroke="none" />
              </svg>
            </div>
            <div className="min-w-0">
              <div className="truncate text-base font-semibold tracking-tight text-slate-900 dark:text-white">
                S7wari
              </div>
              <div className="truncate text-[10px] font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">
                Editorial Workspace
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden dark:text-slate-400 dark:hover:bg-white/[0.06]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav aria-label="Workspace navigation" className="space-y-1">
          {navItems.map(({ id, label, Icon }) => {
            const active = activeNav === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => handleNav(id)}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
                  active
                    ? 'bg-gradient-to-r from-[#2563EB]/12 to-[#6366F1]/10 text-blue-700 dark:from-[#2563EB]/20 dark:to-[#6366F1]/15 dark:text-blue-300 dark:shadow-[0_0_20px_-6px_rgba(37,99,235,0.45)]'
                    : 'text-slate-600 hover:bg-slate-100/80 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/[0.05] dark:hover:text-slate-100'
                }`}
              >
                <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-blue-600 dark:text-blue-400' : ''}`} />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Bottom status + controls */}
      <div className="space-y-3 border-t border-slate-200/80 pt-4 dark:border-white/[0.08]">
        {/* Connection Status Block */}
        <div className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-3 text-xs dark:border-white/[0.08] dark:bg-white/[0.03]">
          <div className="mb-2 text-[10px] font-semibold tracking-[0.12em] text-slate-500 uppercase dark:text-slate-400">
            Connections
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-600 dark:text-slate-400">AI</span>
              <span
                className={`inline-flex items-center gap-1 font-medium ${
                  status?.aiConnected ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'
                }`}
              >
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span>{status?.aiConnected ? 'Connected' : 'Pending'}</span>
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-600 dark:text-slate-400">WordPress</span>
              <span
                className={`font-medium ${
                  status?.wordpressConnected
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                {status?.wordpressConnected ? 'Connected' : 'Add site'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-600 dark:text-slate-400">Active sites</span>
              <span className="font-mono font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {status?.activeSitesCount ?? 0}
              </span>
            </div>
          </div>
        </div>

        <ThemeToggle />

        <div className="flex items-center justify-between gap-2 px-1 pt-1">
          <span className="truncate text-xs text-slate-500 dark:text-slate-400" title={userEmail ?? undefined}>
            {userEmail ?? 'Owner'}
          </span>
          <button
            type="button"
            onClick={onSignOut}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/[0.06] dark:hover:text-white"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span>Sign out</span>
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile Header Bar */}
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200/80 bg-white/90 px-4 py-3 backdrop-blur-md lg:hidden dark:border-white/[0.08] dark:bg-[#0D1322]/90">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[#2563EB] to-[#6366F1] text-white">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 7h16M4 12h10M4 17h16" strokeLinecap="round" />
              <circle cx="18" cy="12" r="2.2" fill="currentColor" stroke="none" />
            </svg>
          </div>
          <span className="text-sm font-semibold tracking-tight text-slate-900 dark:text-white">S7wari</span>
        </div>
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="Open navigation menu"
          className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200/80 text-slate-700 hover:bg-slate-100 dark:border-white/[0.08] dark:text-slate-200 dark:hover:bg-white/[0.06]"
        >
          <Menu className="h-5 w-5" />
        </button>
      </div>

      {/* Desktop Fixed Sidebar */}
      <aside className="hidden w-[264px] shrink-0 border-r border-slate-200/80 bg-white/85 backdrop-blur-xl lg:block dark:border-white/[0.08] dark:bg-[#0D1322]/85">
        <div className="sticky top-0 h-screen">{sidebarBody}</div>
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div
            className="fixed inset-0 bg-slate-950/50 backdrop-blur-xs"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative z-50 h-full w-72 max-w-[85vw] border-r border-slate-200 bg-white shadow-xl dark:border-white/[0.08] dark:bg-[#0D1322]">
            {sidebarBody}
          </aside>
        </div>
      )}
    </>
  );
}
