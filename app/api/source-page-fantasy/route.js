export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

import {createHash, timingSafeEqual} from 'node:crypto';

const SOURCE_HOSTS = Object.freeze({
  adumaru: 'adumaru.pl', battlecult: 'battlecult.pl', graal: 'sklep-graal.pl',
  kulturawraca: 'kulturawraca.pl', megaksiazki: 'megaksiazki.pl',
  mepel: 'mepel.pl', osnowa: 'osnowa.pl', zagrajnik: 'zagrajnik.shop',
  panmysza: 'panmysza.pl', hegemon: 'hegemonshop.com', lokalnie: 'allegrolokalnie.pl',
  empik: 'empik.com', tantis: 'tantis.pl', tania: 'taniaksiazka.pl',
  blackbooks: 'blackbooks.pl', jaskiniatrolla: 'jaskiniatrolla.pl', sobieski: 'antyksobieski.pl',
});
const MAX_PAGE_BYTES = 4_000_000;
const REQUEST_HEADERS = {Accept: 'text/html', 'User-Agent': 'ArchiwumFantasy/1.0 (book price comparison)'};
let active = 0;

function allowedSourceUrl(source, value) {
  const host = SOURCE_HOSTS[source];
  if (!host || typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        ![host, 'www.' + host].includes(url.hostname)) return null;
    const path = url.pathname;
    const shoper = /^\/pl\/(?:p\/[^/]+\/\d+|searchquery\/[^/]+\/\d+(?:\/(?:full|default|desc|phot)\/\d+)?|c\/[^/]+\/\d+(?:\/\d+(?:\/default\/\d+)?)?)\/?$/;
    const slug = /^\/(?!admin\/?$|login\/?$|koszyk\/?$|pl\/?$|szukaj\/?$)[^/]+\/?$/;
    const extraPaths = {
      lokalnie: /^\/(?:oferty\/q\/[^/]+|oferta\/[^/]+)\/?$/,
      hegemon: /^\/pl\/(?:\d+-[^/]+|[^/]+\/\d+-[^/]+\.html|szukaj)\/?$/,
      empik: /^\/(?:szukaj\/produkt|[^/]+,(?:p\d+|prod\d+),ksiazka-p)$/,
      tantis: /^\/(?:szukaj|[^/]+-p\d+)$/,
      tania: /^\/(?:Search|[^/]+-p-\d+\.html)$/,
      blackbooks: /^\/(?:module\/iqitsearch\/searchiqit|[^/]+\/\d+-[^/]+\.html)$/,
      jaskiniatrolla: /^\/(?:[^/]+-c\d+|[^/]+-p\d+|category|szukaj|search)\/?$/,
      sobieski: /^\/(?:product\/search|[^/]+\.html)$/,
    };
    const valid = extraPaths[source] ? extraPaths[source].test(path) : source === 'megaksiazki'
      ? path === '/wyszukiwanie' || /^\/(?:[^/]+\/)?\d+-[^/]+\.html$/.test(path)
      : shoper.test(path) || ['mepel', 'osnowa'].includes(source) && slug.test(path);
    if (!valid) return null;
    url.hash = '';
    return url;
  } catch { return null; }
}

const failure = (message, status, headers = {}) => Response.json({error: message}, {
  status, headers: {'Cache-Control': 'no-store', ...headers},
});

export async function POST(request) {
  const supplied = (request.headers.get('authorization') || '').match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!supplied) return failure('Unauthorized.', 401);
  // Only the SHA-256 verifier is public; the random credential lives in the Fantasy server secret.
  const a = createHash('sha256').update(supplied).digest();
  const b = Buffer.from('df9b5f47c33fb886072216303e4e9351aa7014cfc55fe227f23e608877eeda56', 'hex');
  if (!timingSafeEqual(a, b)) return failure('Unauthorized.', 401);
  const fetchPage = fetch;
  let input;
  try {
    const text = await request.text();
    if (text.length > 2500) return failure('Request is too large.', 413);
    input = JSON.parse(text);
  } catch { return failure('Invalid JSON.', 400); }
  let url = allowedSourceUrl(input?.source, input?.url);
  if (!url) return failure('Unsupported source URL.', 400);
  if (active >= 6) return failure('Source reader is busy.', 429, {'Retry-After': '30'});
  active++;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15000)]);
  try {
    const seen = new Set();
    for (let hop = 0; hop <= 4; hop++) {
      if (seen.has(url.href)) return failure('Upstream redirect loop.', 502);
      seen.add(url.href);
      const response = await fetchPage(url.href, {headers: REQUEST_HEADERS, redirect: 'manual', cache: 'no-store', signal});
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        const next = location && allowedSourceUrl(input.source, new URL(location, url).href);
        if (!next) return failure('Unsupported upstream redirect.', 502);
        url = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        return failure('Upstream HTTP ' + response.status + '.', response.status, {
          'X-Source-Upstream-Status': String(response.status),
          ...(response.status === 429 ? {'Retry-After': '30'} : {}),
        });
      }
      const contentType = response.headers.get('content-type') || '';
      if (!/^text\/html\b|^application\/xhtml\+xml\b|^application\/json\b/i.test(contentType)) {
        await response.body?.cancel();
        return failure('Upstream did not return HTML.', 502);
      }
      const reader = response.body?.getReader();
      if (!reader) return failure('Upstream returned no body.', 502);
      const chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_PAGE_BYTES) return failure('Upstream page exceeds the response limit.', 413);
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      return new Response(Buffer.concat(chunks, bytes), {headers: {
        'Content-Type': contentType, 'Cache-Control': 'no-store',
        'X-Source-Fetched-At': new Date().toISOString(),
      }});
    }
    return failure('Too many upstream redirects.', 502);
  } catch {
    return failure(signal.aborted ? 'Source request timed out or was canceled.' : 'Source connection failed.', signal.aborted ? 504 : 502);
  } finally { active--; }
}
