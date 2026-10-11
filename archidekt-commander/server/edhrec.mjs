// EDHREC (unofficial JSON) client — https://json.edhrec.com
// Pages used (formats verified live 2026-10-11):
//   /pages/commanders/<slug>.json              commander page (cardlists with synergy/num_decks/potential_decks,
//                                              type mix, panels.taglinks = themes, panels.mana_curve, bracket_counts)
//   /pages/commanders/<slug>/<variant>.json    same shape for a theme (landfall, lands-matter…), a bracket
//                                              (exhibition, core, upgraded, optimized, cedh) or budget/expensive
//   /pages/average-decks/<slug>[/<variant>].json  average deck: deck.cards = {Type: [[name, qty]…]}
//   /pages/combos/<slug>.json                  combos: cardlists[] = {combo:{count, percentage, results, comboVote}, cardviews}
//   /pages/cards/<card-slug>.json              card page: card {num_decks, potential_decks, salt}, "Top Commanders" list
// Missing pages answer 403/404. ≥1 s between requests. Pages about the commander/deck (commander, theme,
// bracket, average deck, combos) are always fetched live; CARD pages (data about a card, not about a deck)
// are kept on disk for 7 days (data/edhrec/cards/), 404s for 1 day.

import path from 'node:path';
import { callMemo, dataDir, envInt, fetchWithTimeout, normName, readJson, Throttle, ToolError, USER_AGENT, writeJson } from './store.mjs';

const CARD_TTL_MS = 7 * 24 * 3600 * 1000;
const CARD_NOT_FOUND_TTL_MS = 24 * 3600 * 1000;
const cardFile = (slug) => dataDir('edhrec', 'cards', `${slug}.json`);

const base = () => (process.env.EDHREC_BASE || 'https://json.edhrec.com').replace(/\/+$/, '');
const throttle = new Throttle(() => envInt('EDHREC_MIN_INTERVAL_MS', 1000));

export const BRACKET_SLUGS = { 1: 'exhibition', 2: 'core', 3: 'upgraded', 4: 'optimized', 5: 'cedh' };

/** EDHREC slug: lowercase, no accents/punctuation, spaces → '-'. Keeps every face unless frontOnly. */
export function slugOf(name, { frontOnly = true } = {}) {
  let s = String(name || '');
  s = frontOnly ? s.split(' // ')[0] : s.replace(/\s*\/\/\s*/g, ' ');
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/[,'’.!?:"()]/g, '')
    .replace(/&/g, ' ') // "Minsc & Boo, Timeless Heroes" → minsc-boo-timeless-heroes
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** EDHREC commander slug: front face. */
export const commanderSlug = (name) => slugOf(name);

/** Slug for one commander or a partner pair (alphabetical). */
export function pageSlug(commanders) {
  return commanders.map(commanderSlug).filter(Boolean).sort().join('-');
}

const safeVariant = (v) => (v ? slugOf(v) : '');
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const round3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

/**
 * GET one EDHREC page, always live (no disk cache: an analysis never reuses data from earlier calls).
 * Within one tool call the same URL is fetched only once (per-call memo). compact(page) turns the raw
 * JSON into what the analysis uses. Returns {found, data, fetchedAt} or {found:false}; redirects as {redirect}.
 */
async function getPage(rel, compact) {
  const memo = callMemo('edhrec');
  if (memo.has(rel)) return memo.get(rel);
  const p = fetchPage(rel, compact);
  memo.set(rel, p);
  try {
    return await p;
  } catch (e) {
    memo.delete(rel); // a failure is not remembered: a later step of the same call may retry
    throw e;
  }
}

async function fetchPage(rel, compact) {
  const url = `${base()}${rel}`;
  const res = await throttle.run(() => fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, timeoutMs: 20_000, label: 'EDHREC' }));
  const text = await res.text();
  if (res.status === 404 || res.status === 403) return { found: false };
  if (res.status !== 200) throw new ToolError('http', `EDHREC respondeu HTTP ${res.status} para ${rel}.`, res.status);
  let page;
  try {
    page = JSON.parse(text);
  } catch {
    throw new ToolError('contract', 'EDHREC devolveu algo que não é JSON.');
  }
  if (page?.redirect && typeof page.redirect === 'string') return { redirect: path.basename(page.redirect).replace(/\.json$/, '') };
  return { found: true, data: compact(page), fetchedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------- commander pages

/** Compact form of a commander (or theme/bracket) page. cards: [[name, synergy, inclusion, numDecks, lists[]]]. */
export function compactCommanderPage(j) {
  const dict = j?.container?.json_dict || {};
  const cards = new Map();
  for (const list of dict.cardlists || []) {
    for (const v of list.cardviews || []) {
      if (!v?.name) continue;
      const k = normName(v.name);
      let inclusion = null;
      if (v.potential_decks) {
        const n = v.inclusion != null && v.inclusion <= v.potential_decks ? v.inclusion : v.num_decks;
        if (n != null) inclusion = n / v.potential_decks;
      } else if (num(v.inclusion) != null && v.inclusion <= 1) inclusion = v.inclusion;
      const syn = Number(v.synergy);
      const prev = cards.get(k);
      const entry = prev || [v.name, v.synergy != null && Number.isFinite(syn) ? round3(syn) : null, inclusion != null && Number.isFinite(inclusion) ? round3(inclusion) : null, v.num_decks ?? null, [], num(v.lift) != null ? Math.round(v.lift * 100) / 100 : null];
      if (list.header && !entry[4].includes(list.header)) entry[4].push(list.header);
      cards.set(k, entry);
    }
  }
  const typeMix = {};
  for (const k of ['creature', 'instant', 'sorcery', 'artifact', 'enchantment', 'battle', 'planeswalker', 'land', 'basic', 'nonbasic']) {
    if (typeof j?.[k] === 'number') typeMix[k] = j[k];
  }
  const panels = j?.panels || {};
  const themes = (Array.isArray(panels.taglinks) ? panels.taglinks : [])
    .filter((t) => t?.slug)
    .map((t) => ({ slug: String(t.slug), name: String(t.value || t.slug), decks: num(t.count) }));
  const curve = {};
  if (panels.mana_curve && typeof panels.mana_curve === 'object') {
    for (const [mv, n] of Object.entries(panels.mana_curve)) if (num(n) != null) curve[mv] = n;
  }
  const brackets = {};
  if (j?.bracket_counts && typeof j.bracket_counts === 'object') for (const [b, n] of Object.entries(j.bracket_counts)) if (num(n) != null) brackets[b] = n;
  return {
    numDecks: dict.card?.num_decks ?? j?.num_decks_avg ?? null,
    name: dict.card?.name ?? null,
    typeMix,
    themes,
    curve,
    brackets,
    cards: [...cards.values()],
  };
}

function expandCommander(slug, variant, data, meta) {
  const cards = new Map();
  for (const [name, synergy, inclusion, numDecks, lists, lift] of data.cards || []) {
    cards.set(normName(name), { name, synergy, inclusion, numDecks, lists: lists || [], lift: lift ?? null });
  }
  return { slug, variant: variant || null, found: true, numDecks: data.numDecks, typeMix: data.typeMix || {}, themes: data.themes || [], curve: data.curve || {}, brackets: data.brackets || {}, cards, ...meta };
}

const emptyPage = (slug, variant = null, extra = {}) => ({ slug, variant, found: false, cards: new Map(), typeMix: {}, themes: [], curve: {}, brackets: {}, ...extra });

/**
 * Commander page (or a variant: theme slug, bracket slug, budget/expensive):
 * {slug, variant, found, numDecks, typeMix, themes[], curve{}, brackets{}, cards: Map(normName → {name, synergy, inclusion, numDecks, lists, lift})}.
 * found=false on 404/403. Network failures throw ToolError.
 */
export async function commanderPage(commanderNames, { variant = null } = {}, depth = 0) {
  const slug = pageSlug(commanderNames);
  const v = safeVariant(variant);
  if (!slug) return emptyPage(slug, v || null);
  const rel = `/pages/commanders/${slug}${v ? `/${v}` : ''}.json`;
  const r = await getPage(rel, compactCommanderPage);
  if (r.redirect) {
    // EDHREC answers a redirect object for renamed commanders: follow at most 2 (a loop must not recurse forever).
    if (depth >= 2) throw new ToolError('contract', `EDHREC: redirecionamentos demais para ${slug}.`);
    if (r.redirect === slug) return emptyPage(slug, v || null);
    return commanderPage([r.redirect.replace(/-/g, ' ')], { variant }, depth + 1);
  }
  if (!r.found) return emptyPage(slug, v || null);
  return expandCommander(slug, v, r.data, { fetchedAt: r.fetchedAt });
}

/** Same as commanderPage but never throws: returns {found:false, error} on failure. */
export async function commanderPageSafe(names, opts = {}) {
  try {
    return await commanderPage(names, opts);
  } catch (e) {
    return emptyPage(pageSlug(names), opts.variant ? safeVariant(opts.variant) : null, { error: e.message });
  }
}

// ---------------------------------------------------------------- average deck

export function compactAverageDeck(j) {
  const out = [];
  const byType = j?.deck?.cards;
  if (byType && typeof byType === 'object') {
    for (const [type, list] of Object.entries(byType)) {
      for (const it of Array.isArray(list) ? list : []) {
        if (Array.isArray(it) && it[0]) out.push([String(it[0]), Number(it[1]) || 1, type]);
      }
    }
  }
  if (!out.length) {
    // Fallback: the cardlists of the page hold the same names (no quantities).
    for (const list of j?.container?.json_dict?.cardlists || []) for (const v of list.cardviews || []) if (v?.name) out.push([v.name, 1, list.header || '']);
  }
  return { numDecks: j?.container?.json_dict?.card?.num_decks ?? null, cards: out };
}

/** Average deck: {found, cards: Map(normName → {name, qty, type})}. */
export async function averageDeck(commanderNames, { variant = null } = {}) {
  const slug = pageSlug(commanderNames);
  const v = safeVariant(variant);
  if (!slug) return { slug, found: false, cards: new Map() };
  try {
    const r = await getPage(`/pages/average-decks/${slug}${v ? `/${v}` : ''}.json`, compactAverageDeck);
    if (!r.found) return { slug, variant: v || null, found: false, cards: new Map() };
    const cards = new Map(r.data.cards.map(([name, qty, type]) => [normName(name), { name, qty, type }]));
    return { slug, variant: v || null, found: true, numDecks: r.data.numDecks, cards };
  } catch (e) {
    return { slug, variant: v || null, found: false, cards: new Map(), error: e.message };
  }
}

// ---------------------------------------------------------------- combos

export function compactCombos(j) {
  const out = [];
  const seen = new Set();
  for (const list of j?.container?.json_dict?.cardlists || []) {
    const names = (list.cardviews || []).map((v) => v?.name).filter(Boolean);
    if (names.length < 2) continue;
    const key = names.map(normName).sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const c = list.combo || {};
    out.push({
      cards: names,
      decks: num(c.count),
      percentage: num(c.percentage),
      results: Array.isArray(c.results) ? c.results.slice(0, 4).map(String) : [],
      bracket: c.comboVote?.bracket ? String(c.comboVote.bracket) : null,
    });
  }
  return { combos: out };
}

/** Combos seen in decks of this commander: {found, combos:[{cards[], decks, percentage, results[], bracket}]}. */
export async function combosFor(commanderNames) {
  const slug = pageSlug(commanderNames);
  if (!slug) return { slug, found: false, combos: [] };
  try {
    const r = await getPage(`/pages/combos/${slug}.json`, compactCombos);
    return r.found ? { slug, found: true, combos: r.data.combos } : { slug, found: false, combos: [] };
  } catch (e) {
    return { slug, found: false, combos: [], error: e.message };
  }
}

// ---------------------------------------------------------------- card pages

export function compactCardPage(j) {
  const dict = j?.container?.json_dict || {};
  const card = dict.card || {};
  const top = (dict.cardlists || []).find((l) => /top commanders/i.test(l.header || '') || l.tag === 'topcommanders');
  return {
    name: card.name ?? null,
    numDecks: num(card.num_decks),
    potentialDecks: num(card.potential_decks),
    salt: num(card.salt) != null ? Math.round(card.salt * 100) / 100 : null,
    topCommanders: (top?.cardviews || []).slice(0, 30).map((v) => [v.name, v.potential_decks ? round3((v.num_decks ?? 0) / v.potential_decks) : null]),
  };
}

function expandCard(d, slug) {
  const inclusion = d.numDecks != null && d.potentialDecks ? round3(d.numDecks / d.potentialDecks) : null;
  return {
    found: true,
    slug,
    name: d.name,
    numDecks: d.numDecks,
    potentialDecks: d.potentialDecks,
    inclusion,
    salt: d.salt,
    topCommanders: (d.topCommanders || []).map(([name, inc]) => ({ name, inclusion: inc })),
  };
}

/**
 * Card page: {found, name, numDecks, potentialDecks, inclusion (share of decks of its colors that play it),
 * salt, topCommanders:[{name, inclusion}]}. Tries the front face, then every face ("Fire // Ice" → fire-ice).
 */
export async function cardPage(name) {
  const tries = [...new Set([slugOf(name), slugOf(name, { frontOnly: false })].filter(Boolean))];
  for (const slug of tries) {
    const r = await cardPageCachedOrLive(slug);
    if (!r.found) continue;
    const want = normName(String(name).split(' // ')[0]);
    if (r.data.name && !normName(r.data.name).startsWith(want)) continue; // another card with the same slug
    return { ...expandCard(r.data, slug), fetchedAt: r.fetchedAt, cached: !!r.cached };
  }
  return { found: false, slug: tries[0] };
}

/** Card page from the 7-day disk cache, else live (and saved). */
async function cardPageCachedOrLive(slug) {
  const file = cardFile(slug);
  const c = readJson(file, null);
  if (c?.fetchedAt) {
    const age = Date.now() - Date.parse(c.fetchedAt);
    if (c.notFound && age >= 0 && age < CARD_NOT_FOUND_TTL_MS) return { found: false, cached: true };
    if (!c.notFound && c.data && age >= 0 && age < CARD_TTL_MS) return { found: true, data: c.data, fetchedAt: c.fetchedAt, cached: true };
  }
  const r = await getPage(`/pages/cards/${slug}.json`, compactCardPage);
  try {
    if (r.found) writeJson(file, { v: 2, fetchedAt: r.fetchedAt, data: r.data });
    else if (!r.redirect) writeJson(file, { fetchedAt: new Date().toISOString(), notFound: true });
  } catch {
    /* cache is best-effort */
  }
  return r;
}

/** True when the card page is on disk and fresh — callers spend their time budget on new pages only. */
export function cardPageCached(name) {
  for (const slug of [slugOf(name), slugOf(name, { frontOnly: false })]) {
    const c = readJson(cardFile(slug), null);
    if (c?.fetchedAt && !c.notFound && Date.now() - Date.parse(c.fetchedAt) < CARD_TTL_MS) return true;
  }
  return false;
}
