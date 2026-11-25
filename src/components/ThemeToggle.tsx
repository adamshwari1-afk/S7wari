import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

function applyTheme(mode: ThemeMode): void {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const shouldBeDark = mode === 'dark' || (mode === 'system' && prefersDark);
  if (shouldBeDark) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    try {
      const saved = localStorage.getItem('s7wari-theme');
      if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
    } catch {
      // ignore
    }
    return 'system';
  });

  useEffect(() => {
    applyTheme(mode);
    try {
      localStorage.setItem('s7wari-theme', mode);
    } catch {
      // ignore
    }

    if (mode === 'system') {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => applyTheme('system');
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    }
  }, [mode]);

  const options: Array<{ value: ThemeMode; label: string; Icon: typeof Sun }> = [
    { value: 'light', label: 'Light', Icon: Sun },
    { value: 'dark', label: 'Dark', Icon: Moon },
    { value: 'system', label: 'System', Icon: Monitor },
  ];

  return (
    <div
      role="group"
      aria-label="Theme mode"
      className="grid grid-cols-3 gap-1 rounded-xl border border-slate-200/80 bg-slate-100/80 p-1 dark:border-white/[0.08] dark:bg-white/[0.04]"
    >
      {options.map(({ value, label, Icon }) => {
        const active = mode === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium whitespace-nowrap transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
              active
                ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-800 dark:text-white'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
            }`}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
