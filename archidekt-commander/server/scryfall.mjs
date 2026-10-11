// Scryfall API client (official, free). Streams bulk JSONL.gz files line by line; never buffers them whole.

import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import zlib from 'node:zlib';
import { envInt, fetchWithTimeout, sleep, Throttle, ToolError, USER_AGENT } from './store.mjs';

const base = () => (process.env.SCRYFALL_API_BASE || 'https://api.scryfall.com').replace(/\/+$/, '');
const throttle = new Throttle(() => envInt('SCRYFALL_MIN_INTERVAL_MS', 100));
const HEADERS = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

function abs(pathOrUrl) {
  return /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : base() + pathOrUrl;
}

/** GET JSON. Returns {status, body}; network errors throw ToolError. */
export async function getJson(pathOrUrl, { timeoutMs = 30_000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await throttle.run(async () => {
      const res = await fetchWithTimeout(abs(pathOrUrl), { headers: HEADERS, timeoutMs, label: 'Scryfall' });
      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { status: res.status, body, retryAfter: Number(res.headers.get('retry-after')) };
    });
    // Rate limited: back off (Retry-After, capped at 10 s) and try at most twice more.
    if (r.status === 429 && attempt < 2) {
      await sleep(Math.min(10, Number.isFinite(r.retryAfter) && r.retryAfter > 0 ? r.retryAfter : 1) * 1000);
      continue;
    }
    return { status: r.status, body: r.body };
  }
}

/** /cards/named?fuzzy= → card object or null (404 / ambiguous). */
export async function named(name, { exact = false, timeoutMs = 15_000 } = {}) {
  const r = await getJson(`/cards/named?${exact ? 'exact' : 'fuzzy'}=${encodeURIComponent(name)}`, { timeoutMs });
  if (r.status === 200 && r.body?.object === 'card') return r.body;
  if (r.status === 404 || r.body?.object === 'error') return null;
  throw new ToolError('http', `Scryfall respondeu HTTP ${r.status} em /cards/named.`, r.status);
}

/** Printed Portuguese name of an English card (first PT printing), or null. */
export async function portugueseName(enName, { timeoutMs = 15_000 } = {}) {
  const q = `!"${String(enName).replace(/"/g, '')}" lang:pt`;
  const r = await getJson(`/cards/search?q=${encodeURIComponent(q)}&unique=prints&include_multilingual=true`, { timeoutMs });
  if (r.status !== 200 || !Array.isArray(r.body?.data)) return null;
  for (const c of r.body.data) {
    const pt = c.printed_name || (c.card_faces || []).map((f) => f.printed_name).filter(Boolean).join(' // ');
    if (pt) return pt;
  }
  return null;
}

/** GET /bulk-data → list of entries. */
export async function bulkData() {
  const r = await getJson('/bulk-data');
  if (r.status !== 200 || !Array.isArray(r.body?.data)) throw new ToolError('http', `Scryfall /bulk-data falhou (HTTP ${r.status}).`, r.status);
  return r.body.data;
}

/**
 * Async generator over the lines of a (possibly gzipped) byte stream.
 * fetch() already decodes Content-Encoding: gzip; a .gz payload served as application/gzip is still
 * compressed, so the gzip magic bytes are sniffed and only then gunzipped. Uses pipeline() so a network
 * error, an abort/timeout or a truncated/corrupt gzip REJECTS (readline would silently end or hang) and
 * backpressure is kept (the consumer is awaited before the next chunk is pulled).
 */
export async function* bulkLines(source) {
  const it = source[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) return;
  const head = Buffer.from(first.value);
  const replay = Readable.from(
    (async function* () {
      yield head;
      for (;;) {
        const n = await it.next();
        if (n.done) return;
        yield Buffer.from(n.value);
      }
    })(),
    { objectMode: false },
  );
  const gz = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
  const pass = new PassThrough({ highWaterMark: 1 << 20 });
  const done = gz ? pipeline(replay, zlib.createGunzip(), pass) : pipeline(replay, pass);
  done.catch(() => {}); // surfaced below through the iterator / awaited at the end
  const decoder = new StringDecoder('utf8');
  let buf = '';
  try {
    for await (const chunk of pass) {
      buf += decoder.write(chunk);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        yield line;
      }
    }
    await done;
  } finally {
    if (!pass.destroyed) pass.destroy();
    if (!replay.destroyed) replay.destroy();
    it.return?.().catch?.(() => {}); // release the HTTP body (cancels the download on early exit/error)
  }
  buf += decoder.end();
  if (buf) yield buf;
}

/**
 * Stream a bulk file and call onObject(obj) per card/tag. Handles gzipped JSONL (jsonl_download_uri)
 * and the legacy plain JSON array (download_uri, one object per line). Returns count of objects.
 * Throws on network errors, truncated gzip or when too many lines are unparseable (corrupt download).
 */
export async function streamBulk(url, onObject, { timeoutMs = 15 * 60_000 } = {}) {
  const res = await throttle.run(() => fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }, timeoutMs, label: 'download Scryfall' }));
  if (res.status !== 200 || !res.body) throw new ToolError('http', `Download ${url} falhou (HTTP ${res.status}).`, res.status);
  let n = 0;
  let bad = 0;
  try {
    for await (let line of bulkLines(Readable.fromWeb(res.body))) {
      line = line.trim();
      if (!line || line === '[' || line === ']') continue;
      if (line.startsWith('[')) line = line.slice(1);
      if (line.endsWith(',')) line = line.slice(0, -1);
      if (line.endsWith(']')) line = line.slice(0, -1);
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        bad++; // tolerate a few malformed lines rather than losing the whole file
        continue;
      }
      n++;
      await onObject(obj);
    }
  } catch (e) {
    if (e instanceof ToolError) throw e;
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw new ToolError(timeout ? 'timeout' : 'network', `Download ${url} interrompido${timeout ? ' (tempo esgotado)' : ''}: ${e?.message || e}`);
  }
  if (bad > Math.max(5, n * 0.01)) throw new ToolError('contract', `Download ${url} corrompido: ${bad} linhas inválidas (${n} válidas).`);
  return n;
}

/** Paginated search; calls onPage(body, pageNo) and follows next_page. Returns pages fetched. */
export async function searchAll(query, params, onPage, { maxPages = 400, retries = 2, retryDelayMs = envInt('SCRYFALL_RETRY_DELAY_MS', 1000) } = {}) {
  const qs = new URLSearchParams({ q: query, ...params });
  let url = `/cards/search?${qs}`;
  let page = 0;
  while (url && page < maxPages) {
    // One flaky page out of ~230 must not cost the rest of the list: retry 5xx/network errors twice.
    let r;
    for (let attempt = 0; ; attempt++) {
      try {
        r = await getJson(url);
        if (r.status < 500 || attempt >= retries) break;
      } catch (e) {
        if (attempt >= retries) throw e;
      }
      await sleep(retryDelayMs * (attempt + 1));
    }
    if (r.status === 404) return page; // no results
    if (r.status !== 200) throw new ToolError('http', `Scryfall /cards/search falhou na página ${page + 1} (HTTP ${r.status}).`, r.status);
    page++;
    await onPage(r.body, page);
    url = r.body?.has_more && r.body.next_page ? r.body.next_page : null;
  }
  return page;
}
