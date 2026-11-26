import fs from 'node:fs/promises';
import path from 'node:path';
import type { PublicWordPressSite, StoreSchema, WordPressSite } from '../types.ts';

const DATA_DIR = process.env.DATA_DIR?.trim()
  ? path.resolve(process.env.DATA_DIR.trim())
  : path.resolve(process.cwd(), 'data');
const STORE_PATH = path.resolve(DATA_DIR, 's7wari.json');

const DEFAULT_STORE: StoreSchema = {
  owner: null,
  users: [],
  sites: [],
  jobs: [],
  settings: {
    editorialTone: 'editorial',
  },
};

let writeChain: Promise<void> = Promise.resolve();

async function ensureStoreFile(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(STORE_PATH);
  } catch {
    await fs.writeFile(STORE_PATH, JSON.stringify(DEFAULT_STORE, null, 2), { encoding: 'utf8', mode: 0o600 });
  }
}

export async function readStore(): Promise<StoreSchema> {
  await ensureStoreFile();
  const raw = await fs.readFile(STORE_PATH, 'utf8');
  try {
    const parsed = JSON.parse(raw) as Partial<StoreSchema>;
    return {
      owner: parsed.owner ?? null,
      users: Array.isArray(parsed.users) ? parsed.users : [],
      sites: Array.isArray(parsed.sites) ? parsed.sites : [],
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      settings: {
        editorialTone: parsed.settings?.editorialTone ?? 'editorial',
      },
    };
  } catch {
    return structuredClone(DEFAULT_STORE);
  }
}

export async function updateStore<T>(mutator: (draft: StoreSchema) => Promise<T> | T): Promise<T> {
  let result!: T;
  const task = writeChain.then(async () => {
    const current = await readStore();
    result = await mutator(current);
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmpPath = path.resolve(DATA_DIR, `s7wari.${process.pid}.${Date.now()}.tmp`);
    await fs.writeFile(tmpPath, JSON.stringify(current, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmpPath, STORE_PATH);
  });
  writeChain = task.catch(() => {});
  await task;
  return result;
}

export function toPublicSite(site: WordPressSite): PublicWordPressSite {
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
    updatedAt: site.updatedAt,
  };
}
