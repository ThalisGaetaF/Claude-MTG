// LigaMagic (Brazilian marketplace) price scraper. No public API: parses the server-rendered search page.
// Gentle by design: ≥2 s between requests, 24 h disk cache, stops on the first sign of blocking.

import { dataDir, envInt, fetchWithTimeout, normName, readJson, Throttle, ToolError, USER_AGENT, writeJson } from './store.mjs';

const base = () => (process.env.LIGAMAGIC_BASE || 'https://www.ligamagic.com.br').replace(/\/+$/, '');
const throttle = new Throttle(() => envInt('LIGAMAGIC_MIN_INTERVAL_MS', 2000));
const CACHE_TTL_MS = 24 * 3600 * 1000;
const cacheFile = () => dataDir('ligamagic-prices.json');
let blockedUntil = 0;
let blockedMsg = '';

export const BLOCKED_MESSAGE = 'LigaMagic bloqueou acesso automatizado (HTTP {status}). Não vou insistir — confira o preço direto no site ligamagic.com.br.';

export const searchUrl = (name) => `${base()}/?view=cards/search&card=${encodeURIComponent(name)}`;

/**
 * Link to the card page on LigaMagic (EN or PT name both work). Split/DFC cards use the front face.
 * Encodes characters that break Markdown links too: ' ( ) → %27 %28 %29.
 */
export function cardUrl(name) {
  const n = String(name ?? '').split(' // ')[0].trim();
  if (!n) return null;
  const q = encodeURIComponent(n).replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
  return `${base()}/?view=cards/card&card=${q}`;
}

/** "R$ 7.499,00" → 7499; "R$ 0,00" or garbage → null. */
export function parseBRL(s) {
  // Thousands separator only when present ("7.499,00"); otherwise all digits ("1499,00" → 1499, not 149).
  const m = String(s ?? '').replace(/\s+/g, ' ').match(/(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?/);
  if (!m) return null;
  const v = Number(m[1].replace(/\./g, '') + '.' + (m[2] || '0'));
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decodeHtml(s) {
  return String(s ?? '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

const stripTags = (s) => decodeHtml(String(s ?? '').replace(/<[^>]*>/g, ' '));

function divText(block, cls) {
  const re = new RegExp(`<div[^>]*class="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"[^>]*>([\\s\\S]*?)</div>`, 'i');
  const m = block.match(re);
  return m ? stripTags(m[1]) : null;
}

function linkOf(block, cls) {
  const re = new RegExp(`<div[^>]*class="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"[^>]*>\\s*<a[^>]*href="([^"]+)"`, 'i');
  const m = block.match(re);
  return m ? decodeHtml(m[1]) : null;
}

/** Split "Anel Solar (#249)" → {base: "Anel Solar", suffix: "#249"}. */
function splitSuffix(name) {
  const m = String(name || '').match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  return m ? { base: m[1].trim(), suffix: m[2].trim() } : { base: String(name || '').trim(), suffix: null };
}

/** Parse the search page into rows [{name, aux, base, auxBase, variant, min, avg, max, url}]. */
export function parseSearch(html) {
  const rows = [];
  const parts = String(html || '').split(/<div[^>]*class="[^"]*\bmtg-single\b/i).slice(1);
  for (const part of parts) {
    if (!/mtg-names/.test(part)) continue; // deck boxes, playmats...
    const name = divText(part, 'mtg-name');
    if (!name) continue;
    const aux = divText(part, 'mtg-name-aux');
    const a = splitSuffix(name);
    const b = aux ? splitSuffix(aux) : { base: null, suffix: null };
    const variant = a.suffix || b.suffix || null;
    if (variant && /art card/i.test(variant)) continue;
    const href = linkOf(part, 'mtg-name');
    rows.push({
      name,
      aux: aux || null,
      base: a.base,
      auxBase: b.base,
      variant,
      min: parseBRL(divText(part, 'price-min')),
      avg: parseBRL(divText(part, 'price-avg')),
      max: parseBRL(divText(part, 'price-max')),
      url: href ? (href.startsWith('http') ? href : `${base()}/${href.replace(/^\//, '')}`) : null,
    });
  }
  return rows;
}

export function looksBlocked(status, body) {
  if (status === 403 || status === 429 || status === 503) return true;
  // Only challenge-page markers: a normal page may mention (re)captcha in its login form, and an empty
  // search result has no mtg-single either — neither is a block.
  const head = String(body).slice(0, 20000);
  if (/mtg-single/.test(body)) return false;
  return /cf-chl|challenge-platform|cf-browser-verification|<title>\s*just a moment\.\.\.|attention required!? \| cloudflare|<h1[^>]*>\s*attention required/i.test(head);
}

/** Raw search (throttled). Throws ToolError('blocked') on blocking. */
export async function fetchSearch(name, { timeoutMs = 20_000, deadline = null } = {}) {
  if (Date.now() < blockedUntil) throw new ToolError('blocked', blockedMsg);
  return throttle.run(async () => {
    if (Date.now() < blockedUntil) throw new ToolError('blocked', blockedMsg);
    // Time budget of the calling tool: the throttle wait may have used it up.
    if (deadline != null && deadline - Date.now() < 1500) throw new ToolError('budget', 'não consultado (limite de tempo da chamada)');
    const res = await fetchWithTimeout(searchUrl(name), {
      headers: { 'User-Agent': `${USER_AGENT} (uso pessoal; consulta de preços)`, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'pt-BR,pt;q=0.9' },
      timeoutMs: deadline != null ? Math.max(1000, Math.min(timeoutMs, deadline - Date.now())) : timeoutMs,
      label: 'LigaMagic',
    });
    const body = await res.text();
    if (looksBlocked(res.status, body)) {
      blockedMsg = BLOCKED_MESSAGE.replace('{status}', String(res.status));
      blockedUntil = Date.now() + envInt('LIGAMAGIC_BLOCK_COOLDOWN_MS', 15 * 60_000);
      throw new ToolError('blocked', blockedMsg, res.status);
    }
    if (res.status !== 200) throw new ToolError('http', `LigaMagic respondeu HTTP ${res.status}.`, res.status);
    return parseSearch(body);
  });
}

/** Rows matching a card by EN or PT name (base name, without the variant suffix). */
export function rowsFor(rows, names) {
  const want = new Set();
  for (const n of names.filter(Boolean)) {
    want.add(normName(n));
    // DFC/split: LigaMagic may list only the front face, or "Front / Back".
    const front = String(n).split(/\s+\/\/?\s+/)[0];
    if (front !== n) want.add(normName(front));
  }
  want.delete('');
  return rows.filter((r) => want.has(normName(r.base)) || (r.auxBase && want.has(normName(r.auxBase))));
}

/** Aggregate price info from matching rows. */
export function summarize(rows, { en, pt }) {
  const plain = rows.find((r) => !r.variant);
  const variants = rows.filter((r) => r.variant);
  let min, avg, max, aggregate;
  if (plain) {
    ({ min, avg, max } = plain);
    aggregate = 'linha agregada';
  } else if (variants.length) {
    const nums = (k) => variants.map((v) => v[k]).filter((x) => x != null);
    min = nums('min').length ? Math.min(...nums('min')) : null;
    avg = nums('avg').length ? Math.round((nums('avg').reduce((s, x) => s + x, 0) / nums('avg').length) * 100) / 100 : null;
    max = nums('max').length ? Math.max(...nums('max')) : null;
    aggregate = 'calculado das variantes';
  }
  const first = plain || variants[0];
  return {
    en: en ?? (first?.aux ? first.auxBase : first?.base) ?? null,
    pt: pt ?? (first?.aux ? first.base : null),
    min: min ?? null,
    avg: avg ?? null,
    max: max ?? null,
    aggregate,
    variants: variants
      .slice()
      .sort((a, b) => (a.min ?? Infinity) - (b.min ?? Infinity))
      .slice(0, 5)
      .map((v) => ({ variant: v.variant, min: v.min, avg: v.avg, url: v.url })),
    url: plain?.url || first?.url || null,
  };
}

/**
 * Price for one card. `names` = {en, pt} (either may be null); `query` is what to search for.
 * Uses the 24 h disk cache. Returns {en, pt, min, avg, max, variants, url, fetchedAt, source, cached}.
 */
export function cachedPrice({ en, pt, query }) {
  const key = normName(en || pt || query);
  const cache = readJson(cacheFile(), {}) || {};
  const hit = cache[key];
  const age = hit ? Date.now() - Date.parse(hit.fetchedAt) : NaN;
  return age >= 0 && age < CACHE_TTL_MS ? withLink({ ...hit, cached: true }) : null;
}

export async function priceFor({ en, pt, query }, { deadline = null } = {}) {
  const key = normName(en || pt || query);
  if (!key) return { en: null, pt: null, found: false, error: 'nome vazio' };
  const hit = cachedPrice({ en, pt, query });
  if (hit) return withLink(hit);
  const rows = await fetchSearch(query || pt || en, { deadline });
  const matched = rowsFor(rows, [en, pt, query]);
  // "Not found" is cached too (24 h): asking again would only spend LigaMagic requests.
  const info = matched.length
    ? { ...summarize(matched, { en, pt }), found: true, fetchedAt: new Date().toISOString(), source: 'LigaMagic' }
    : { en: en ?? null, pt: pt ?? null, found: false, searchUrl: searchUrl(query || pt || en), fetchedAt: new Date().toISOString(), source: 'LigaMagic' };
  const fresh = readJson(cacheFile(), {}) || {};
  for (const [k, v] of Object.entries(fresh)) if (!v?.fetchedAt || Date.now() - Date.parse(v.fetchedAt) > CACHE_TTL_MS * 7) delete fresh[k];
  fresh[key] = info;
  writeJson(cacheFile(), fresh);
  return withLink({ ...info, cached: false });
}

/** Adds `ligamagicUrl` (card page) to a price result. */
function withLink(r) {
  const url = cardUrl(r?.en || r?.pt);
  return url ? { ...r, ligamagicUrl: url } : r;
}

/** Translation help: find the EN/PT pair for a name on LigaMagic. Returns {en, pt} or null. */
export async function namePair(name, { deadline = null } = {}) {
  const rows = await fetchSearch(name, { deadline });
  const k = normName(name);
  const r = rows.find((x) => normName(x.base) === k || (x.auxBase && normName(x.auxBase) === k));
  if (!r) return null;
  return r.aux ? { en: r.auxBase, pt: r.base } : { en: r.base, pt: null };
}
