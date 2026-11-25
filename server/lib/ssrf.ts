import dns from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata',
]);

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) {
    const mappedV4 = normalized.slice(7);
    if (net.isIPv4(mappedV4)) return isPrivateIPv4(mappedV4);
  }
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // fc00::/7 unique local
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return true; // fe80::/10 link-local
  }
  return false;
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true;
}

export async function assertSafeExternalUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Please enter a valid URL starting with http:// or https://.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs are supported.');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) {
    throw new Error('URL is missing a hostname.');
  }

  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('Requests to local or internal network addresses are not allowed.');
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error('Requests to private or loopback IP addresses are not allowed.');
    }
    return parsed;
  }

  try {
    const records = await dns.lookup(hostname, { all: true });
    if (!records.length) {
      throw new Error(`Could not resolve host "${hostname}".`);
    }
    for (const rec of records) {
      if (isPrivateIp(rec.address)) {
        throw new Error(`Host "${hostname}" resolves to a private network address and cannot be accessed.`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('private network')) {
      throw err;
    }
    throw new Error(`Unable to reach "${hostname}". Please verify the URL is correct and publicly accessible.`);
  }

  return parsed;
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  timeoutMs?: number;
  maxRedirects?: number;
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<{ response: globalThis.Response; finalUrl: string }> {
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 20000;
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertSafeExternalUrl(currentUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: globalThis.Response;
    try {
      res = await fetch(currentUrl, {
        method: options.method ?? 'GET',
        headers: options.headers,
        body: options.body,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s while connecting to ${new URL(currentUrl).hostname}.`);
      }
      throw new Error(`Network error reaching ${new URL(currentUrl).hostname}: ${err instanceof Error ? err.message : 'Connection failed'}`);
    }
    clearTimeout(timer);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        return { response: res, finalUrl: currentUrl };
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return { response: res, finalUrl: currentUrl };
  }

  throw new Error('Too many redirects while fetching the URL.');
}
