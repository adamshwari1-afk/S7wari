export type JobStatus = 'ready' | 'draft' | 'published' | 'error';

export type ProcessingMode = 'copy' | 'ai';

export type PipelineStage =
  | 'fetching'
  | 'rewriting'
  | 'splitting'
  | 'uploading_images'
  | 'publishing'
  | 'facebook_package'
  | 'saved';

export interface WordPressSite {
  id: string;
  name: string;
  url: string;
  username: string;
  appPassword: string;
  language: string;
  targetWordsPerPage: number;
  minTotalWords: number;
  lastTestedAt?: string;
  lastTestOk?: boolean;
  lastTestMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicWordPressSite {
  id: string;
  name: string;
  url: string;
  username: string;
  hasAppPassword: boolean;
  language: string;
  targetWordsPerPage: number;
  minTotalWords: number;
  lastTestedAt?: string;
  lastTestOk?: boolean;
  lastTestMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArticleBlock {
  type: 'h2' | 'h3' | 'p' | 'ul' | 'ol' | 'img' | 'source';
  text?: string;
  items?: string[];
  imageUrl?: string;
  alt?: string;
  caption?: string;
  keepTogether?: boolean;
}

export interface ArticleImage {
  id: string;
  sourceUrl: string;
  alt: string;
  caption?: string;
  included: boolean;
  isFeatured?: boolean;
  assignedPage: number;
  wpMediaId?: number;
  wpSourceUrl?: string;
  uploadError?: string;
}

export interface ArticlePage {
  pageNumber: number;
  hook: string;
  html: string;
  plainText: string;
  wordCount: number;
}

export interface SeoMetadata {
  metaTitle: string;
  metaDescription: string;
  slug: string;
  category: string;
  tags: string[];
}

export interface FacebookPackage {
  caption: string;
  hashtags: string[];
  postUrl: string;
}

export interface EditorialJob {
  id: string;
  mode?: ProcessingMode;
  siteId: string;
  siteName: string;
  language: string;
  originalInputUrl: string;
  resolvedUrl: string;
  wasFacebookRedirect: boolean;
  sourceTitle: string;
  title: string;
  intro: string;
  hasRecipeData?: boolean;
  recipeNotice?: string;
  extractionIncomplete?: boolean;
  extractionConfirmed?: boolean;
  pages: ArticlePage[];
  totalWords: number;
  images: ArticleImage[];
  seo: SeoMetadata;
  facebook: FacebookPackage;
  status: JobStatus;
  wpPostId?: number;
  wpPostUrl?: string;
  wpPostStatus?: 'publish' | 'draft';
  expansionAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface OwnerCredentials {
  email: string;
  passwordHash: string;
  salt: string;
  updatedAt: string;
}

export interface AppSettings {
  editorialTone: 'editorial' | 'engaging' | 'informative';
}

export interface StoreSchema {
  owner: OwnerCredentials | null;
  users?: OwnerCredentials[];
  sites: WordPressSite[];
  jobs: EditorialJob[];
  settings: AppSettings;
}
