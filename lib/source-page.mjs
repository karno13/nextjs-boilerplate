import {timingSafeEqual} from 'node:crypto';

export const SOURCE_HOSTS = Object.freeze({
  poznan: 'antykwariat.pl', nws: 'antykwariatnws.pl', kwadryga: 'kwadryga.com', tania: 'taniaksiazka.pl',
  adumaru: 'adumaru.pl', battlecult: 'battlecult.pl', graal: 'sklep-graal.pl',
  kulturawraca: 'kulturawraca.pl', megaksiazki: 'megaksiazki.pl',
  mepel: 'mepel.pl', osnowa: 'osnowa.pl', zagrajnik: 'zagrajnik.shop',
  panmysza: 'panmysza.pl', hegemon: 'hegemonshop.com', lokalnie: 'allegrolokalnie.pl',
});
export const MAX_PAGE_BYTES = 4_000_000;
const REQUEST_HEADERS = {Accept: 'text/html', 'User-Agent': 'Archiwum40K/1.0 (book price comparison)'};
let active = 0;

export function allowedSourceUrl(source, value) {
  const host = SOURCE_HOSTS[source];
  if (!host || typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        ![host, 'www.' + host].includes(url.hostname)) return null;
    const path = url.pathname;
    const shoper = /^\/pl\/(?:p\/[^/]+\/\d+|searchquery\/[^/]+\/\d+(?:\/(?:full|default|desc|phot)\/\d+)?|c\/[^/]+\/\d+(?:\/\d+(?:\/default\/\d+)?)?)\/?$/;
    const slug = /^\/(?!admin\/?$|login\/?$|koszyk\/?$|pl\/?$|szukaj\/?$)[^/]+\/?$/;
    const valid = source === 'nws' ? /^\/(?:oferta-\d+-\d+-[^/]+\.html|szukaj_w_antykwariat-[^/]+\.html)$/.test(path) || path === '/index.php' && url.searchParams.get('action') === 'antykwariat_wyszukiwarka' && url.searchParams.has('tekst')
      : source === 'kwadryga' ? /^\/produkt\/[^/]+\/$/.test(path) || /^\/sklep(?:\/page\/\d+)?\/$/.test(path) && url.searchParams.has('woos')
      : source === 'tania' ? path === '/Search' && url.searchParams.has('q') || /^\/[^/]+-p-\d+\.html$/.test(path)
      : source === 'lokalnie' ? /^\/(?:oferty\/q\/[^/]+|oferta\/[^/]+)\/?$/.test(path)
      : source === 'hegemon' ? /^\/pl\/(?:\d+-[^/]+|[^/]+\/\d+-[^/]+\.html|szukaj)\/?$/.test(path)
      : source === 'megaksiazki'
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

export async function sourcePageResponse(request, {token = process.env.ARCHIWUM_FETCH_TOKEN, fetchPage = fetch} = {}) {
  if (typeof token !== 'string' || token.length < 32) return failure('Source reader is not configured.', 503);
  const supplied = request.headers.get('authorization') || '';
  const expected = 'Bearer ' + token;
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return failure('Unauthorized.', 401);
  let input;
  try {
    const text = await request.text();
    if (text.length > 2500) return failure('Request is too large.', 413);
    input = JSON.parse(text);
  } catch { return failure('Invalid JSON.', 400); }
  let url = allowedSourceUrl(input?.source, input?.url);
  if (!url) return failure('Unsupported source URL.', 400);
  if (active >= 16) return failure('Source reader is busy.', 429, {'Retry-After': '30'});
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
      if (!/^text\/html\b|^application\/xhtml\+xml\b/i.test(contentType)) {
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
