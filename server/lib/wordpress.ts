import type { ArticleImage, WordPressSite } from '../types.ts';
import { safeFetch } from './ssrf.ts';

function normalizeSiteUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl.trim());
  return parsed.origin + parsed.pathname.replace(/\/+$/, '');
}

function buildAuthHeader(username: string, appPassword: string): string {
  const token = Buffer.from(`${username}:${appPassword}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

export async function testWordPressConnection(site: {
  url: string;
  username: string;
  appPassword: string;
}): Promise<{ ok: boolean; message: string; wpUser?: string }> {
  try {
    const baseUrl = normalizeSiteUrl(site.url);
    const endpoint = `${baseUrl}/wp-json/wp/v2/users/me?context=edit`;
    const { response } = await safeFetch(endpoint, {
      headers: {
        Authorization: buildAuthHeader(site.username, site.appPassword),
        Accept: 'application/json',
      },
      timeoutMs: 15000,
    });

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        message: 'Authentication failed. Check your WordPress username and Application Password.',
      };
    }
    if (response.status === 404) {
      return {
        ok: false,
        message: 'WordPress REST API (/wp-json/wp/v2) was not found at this URL.',
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        message: `WordPress returned HTTP ${response.status}.`,
      };
    }

    const user = (await response.json()) as { name?: string; slug?: string };
    const displayName = user.name || user.slug || site.username;
    return {
      ok: true,
      wpUser: displayName,
      message: `Connected to ${new URL(baseUrl).hostname} as ${displayName}.`,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Unable to reach WordPress site.',
    };
  }
}

export async function uploadImageToWordPress(
  site: WordPressSite,
  image: ArticleImage,
  slugPrefix: string,
  index: number
): Promise<{ id: number; sourceUrl: string }> {
  const baseUrl = normalizeSiteUrl(site.url);

  let contentType = 'image/jpeg';
  let buffer: Buffer;

  const dataUrlMatch = image.sourceUrl.match(/^data:(image\/(?:jpeg|jpg|png|webp|gif|avif));base64,([A-Za-z0-9+/=]+)$/i);
  if (dataUrlMatch) {
    contentType = dataUrlMatch[1].toLowerCase();
    buffer = Buffer.from(dataUrlMatch[2], 'base64');
  } else {
    const { response: imgRes } = await safeFetch(image.sourceUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; S7wariEditorial/1.0)',
        Accept: 'image/*,*/*;q=0.8',
      },
      timeoutMs: 20000,
    });

    if (!imgRes.ok) {
      throw new Error(`Image download failed (HTTP ${imgRes.status}).`);
    }

    contentType = (imgRes.headers.get('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/')) {
      throw new Error(`Source did not return an image (${contentType}).`);
    }

    const arrayBuffer = await imgRes.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
  }

  if (buffer.byteLength === 0) {
    throw new Error('Image data was empty.');
  }
  if (buffer.byteLength > 10 * 1024 * 1024) {
    throw new Error('Image exceeds 10MB upload limit.');
  }

  const extMap: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
  };
  const ext = extMap[contentType] ?? 'jpg';
  const safeSlug = slugPrefix.replace(/[^a-z0-9-]/gi, '-').slice(0, 40) || 'article';
  const filename = `${safeSlug}-${index + 1}.${ext}`;

  const { response: uploadRes } = await safeFetch(`${baseUrl}/wp-json/wp/v2/media`, {
    method: 'POST',
    headers: {
      Authorization: buildAuthHeader(site.username, site.appPassword),
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Type': contentType,
      Accept: 'application/json',
    },
    body: new Uint8Array(buffer),
    timeoutMs: 30000,
  });

  if (!uploadRes.ok) {
    const text = await uploadRes.text();
    throw new Error(`WordPress Media upload failed (${uploadRes.status}): ${text.slice(0, 180)}`);
  }

  const uploaded = (await uploadRes.json()) as { id: number; source_url: string };

  // Update alt text cleanly on the uploaded media item
  if (image.alt) {
    try {
      await safeFetch(`${baseUrl}/wp-json/wp/v2/media/${uploaded.id}`, {
        method: 'POST',
        headers: {
          Authorization: buildAuthHeader(site.username, site.appPassword),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ alt_text: image.alt }),
        timeoutMs: 10000,
      });
    } catch {
      // non-fatal
    }
  }

  return { id: uploaded.id, sourceUrl: uploaded.source_url };
}

async function resolveOrCreateTerm(
  site: WordPressSite,
  taxonomy: 'categories' | 'tags',
  name: string
): Promise<number | null> {
  const cleanName = name.trim();
  if (!cleanName) return null;
  const baseUrl = normalizeSiteUrl(site.url);
  const authHeader = buildAuthHeader(site.username, site.appPassword);

  try {
    const searchUrl = `${baseUrl}/wp-json/wp/v2/${taxonomy}?search=${encodeURIComponent(cleanName)}&per_page=5`;
    const { response: searchRes } = await safeFetch(searchUrl, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
      timeoutMs: 10000,
    });
    if (searchRes.ok) {
      const items = (await searchRes.json()) as Array<{ id: number; name: string }>;
      const exact = items.find((item) => item.name.toLowerCase() === cleanName.toLowerCase());
      if (exact) return exact.id;
      if (items[0] && taxonomy === 'categories') return items[0].id;
    }

    const { response: createRes } = await safeFetch(`${baseUrl}/wp-json/wp/v2/${taxonomy}`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ name: cleanName }),
      timeoutMs: 10000,
    });

    if (createRes.ok) {
      const created = (await createRes.json()) as { id: number };
      return created.id;
    }
  } catch {
    // non-fatal if user lacks term creation rights
  }
  return null;
}

export async function publishPostToWordPress(
  site: WordPressSite,
  params: {
    title: string;
    content: string;
    slug: string;
    excerpt: string;
    status: 'publish' | 'draft';
    featuredMediaId?: number;
    categoryName: string;
    tagNames: string[];
  }
): Promise<{ id: number; link: string; status: 'publish' | 'draft' }> {
  const baseUrl = normalizeSiteUrl(site.url);
  const authHeader = buildAuthHeader(site.username, site.appPassword);

  const categoryId = await resolveOrCreateTerm(site, 'categories', params.categoryName);
  const tagIds: number[] = [];
  for (const tag of params.tagNames.slice(0, 6)) {
    const id = await resolveOrCreateTerm(site, 'tags', tag);
    if (id !== null) tagIds.push(id);
  }

  const bodyPayload: Record<string, unknown> = {
    title: params.title,
    content: params.content,
    slug: params.slug,
    excerpt: params.excerpt,
    status: params.status,
  };

  if (params.featuredMediaId) {
    bodyPayload.featured_media = params.featuredMediaId;
  }
  if (categoryId !== null) {
    bodyPayload.categories = [categoryId];
  }
  if (tagIds.length > 0) {
    bodyPayload.tags = tagIds;
  }

  const { response } = await safeFetch(`${baseUrl}/wp-json/wp/v2/posts`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(bodyPayload),
    timeoutMs: 25000,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`WordPress post creation failed (HTTP ${response.status}): ${errText.slice(0, 220)}`);
  }

  const created = (await response.json()) as { id: number; link: string; status: string };
  return {
    id: created.id,
    link: created.link,
    status: created.status === 'publish' ? 'publish' : 'draft',
  };
}
