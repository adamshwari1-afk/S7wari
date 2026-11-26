import type {
  AuthStatus,
  EditorialJob,
  PipelineStage,
  WordPressSite,
  WorkspaceStatus,
} from '../types';

let memoryToken: string | null = null;
let onUnauthorizedCallback: (() => void) | null = null;

export function setAuthToken(token: string | null): void {
  memoryToken = token;
}

export function getAuthToken(): string | null {
  return memoryToken;
}

export function setUnauthorizedHandler(cb: () => void): void {
  onUnauthorizedCallback = cb;
}

async function apiFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (memoryToken) {
    headers.set('Authorization', `Bearer ${memoryToken}`);
  }

  const res = await fetch(url, { ...init, headers });
  if (res.status === 401 && url !== '/api/auth/login' && url !== '/api/auth/register') {
    memoryToken = null;
    onUnauthorizedCallback?.();
  }

  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) {
    throw new Error(data.error || data.message || `Request failed (${res.status})`);
  }
  return data;
}

export interface SseCallbacks {
  onStage: (payload: { stage: PipelineStage; state: 'active' | 'done' | 'error'; detail?: string }) => void;
  onComplete: (job: EditorialJob) => void;
  onError: (message: string) => void;
}

async function streamSsePost(url: string, body: unknown, callbacks: SseCallbacks): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (memoryToken) {
    headers.Authorization = `Bearer ${memoryToken}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (res.status === 401) {
    memoryToken = null;
    onUnauthorizedCallback?.();
    throw new Error('Session expired. Please sign in again.');
  }

  if (!res.ok || !res.body) {
    const errJson = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(errJson.error || `Request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';

    for (const chunk of chunks) {
      const lines = chunk.split('\n');
      let eventName = 'message';
      let dataLine = '';
      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLine += line.slice(5).trim();
        }
      }
      if (!dataLine) continue;
      const parsed = JSON.parse(dataLine) as Record<string, unknown>;
      if (eventName === 'stage') {
        callbacks.onStage(parsed as { stage: PipelineStage; state: 'active' | 'done' | 'error'; detail?: string });
      } else if (eventName === 'complete') {
        callbacks.onComplete(parsed.job as EditorialJob);
      } else if (eventName === 'error') {
        callbacks.onError(String(parsed.message || 'An error occurred.'));
      }
    }
  }
}

export const api = {
  getAuthStatus: () => apiFetch<AuthStatus>('/api/auth/status'),
  setupOwner: (email: string, password: string) =>
    apiFetch<{ token: string; email: string }>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  register: (email: string, password: string) =>
    apiFetch<{ token: string; email: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  login: (email: string, password: string) =>
    apiFetch<{ token: string; email: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: () => apiFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  updateCredentials: (currentPassword: string, newEmail: string, newPassword?: string) =>
    apiFetch<{ email: string }>('/api/auth/credentials', {
      method: 'PUT',
      body: JSON.stringify({ currentPassword, newEmail, newPassword }),
    }),

  getStatus: () => apiFetch<WorkspaceStatus>('/api/status'),
  updateSettings: (editorialTone: WorkspaceStatus['editorialTone']) =>
    apiFetch<{ editorialTone: WorkspaceStatus['editorialTone'] }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ editorialTone }),
    }),
  testAi: () =>
    apiFetch<{ ok: boolean; model: string; latencyMs: number; message: string }>('/api/settings/test-ai', {
      method: 'POST',
    }),

  getSites: () => apiFetch<{ sites: WordPressSite[] }>('/api/sites'),
  createSite: (payload: {
    name: string;
    url: string;
    username: string;
    appPassword: string;
    language: string;
    targetWordsPerPage: number;
    minTotalWords: number;
  }) =>
    apiFetch<{ site: WordPressSite }>('/api/sites', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateSite: (
    id: string,
    payload: Partial<{
      name: string;
      url: string;
      username: string;
      appPassword: string;
      language: string;
      targetWordsPerPage: number;
      minTotalWords: number;
    }>
  ) =>
    apiFetch<{ site: WordPressSite }>(`/api/sites/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteSite: (id: string) => apiFetch<{ ok: boolean }>(`/api/sites/${id}`, { method: 'DELETE' }),
  testSite: (payload: { siteId?: string; url?: string; username?: string; appPassword?: string }) =>
    apiFetch<{ ok: boolean; message: string; wpUser?: string }>('/api/sites/test', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getJobs: () => apiFetch<{ jobs: EditorialJob[] }>('/api/jobs'),
  updateJob: (id: string, payload: Partial<EditorialJob>) =>
    apiFetch<{ job: EditorialJob }>(`/api/jobs/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteJob: (id: string) => apiFetch<{ ok: boolean }>(`/api/jobs/${id}`, { method: 'DELETE' }),

  streamGenerate: (url: string, siteId: string, aiRewrite: boolean, callbacks: SseCallbacks) =>
    streamSsePost('/api/studio/generate', { url, siteId, aiRewrite }, callbacks),

  streamPublish: (
    payload: {
      jobId: string;
      publishStatus: 'publish' | 'draft';
      title: string;
      pages: EditorialJob['pages'];
      images: EditorialJob['images'];
      seo: EditorialJob['seo'];
      facebook: EditorialJob['facebook'];
      extractionConfirmed?: boolean;
    },
    callbacks: SseCallbacks
  ) => streamSsePost('/api/studio/publish', payload, callbacks),
};
