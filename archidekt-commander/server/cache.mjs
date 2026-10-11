// Local card cache built from Scryfall bulk data: compact card records, functional roles, PT names.
// Built by a background job; loaded lazily with name indexes.

import fs from 'node:fs';
import { bulkData, searchAll, streamBulk } from './scryfall.mjs';
import { log } from './client.mjs';
import { resolveTagRoles, textRoles } from './roles.mjs';
import { dataDir, ensureDir, levenshtein, normName, readJson, writeJson } from './store.mjs';

export const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
// A cache built with a failed step (tags or PT names) is retried sooner.
export const PARTIAL_MAX_AGE_MS = 24 * 3600 * 1000;
// Auto-start does not retry a failed attempt more often than this (manual updates always may).
export const AUTO_RETRY_MS = 3600 * 1000;
const LOCK_STALE_MS = 2 * 3600 * 1000;
const SKIP_LAYOUTS = new Set(['token', 'double_faced_token', 'emblem', 'art_series', 'vanguard', 'planar', 'scheme', 'augment', 'host']);
const MAX_RAW_TAGS = 8;

const files = {
  cards: () => dataDir('cards.json'),
  pt: () => dataDir('pt-names.json'),
  meta: () => dataDir('cache-meta.json'),
};
const lockFile = () => dataDir('cache-job.lock');

export const readMeta = () => readJson(files.meta(), null);

// ---------------- background job ----------------

const job = { running: false, step: null, progress: {}, startedAt: null, finishedAt: null, lastResult: null, promise: null };

export function jobStatus() {
  const out = { running: job.running, step: job.step, progress: { ...job.progress }, startedAt: job.startedAt, finishedAt: job.finishedAt };
  if (!job.running && job.lastResult?.errors?.length) out.lastErrors = job.lastResult.errors;
  return out;
}

export function isFresh(meta = readMeta()) {
  if (!meta?.updatedAt || !fs.existsSync(files.cards())) return false;
  const age = Date.now() - Date.parse(meta.updatedAt);
  return age >= 0 && age < (meta.partial ? PARTIAL_MAX_AGE_MS : MAX_AGE_MS);
}

/** Should the server start an update on its own? Not when fresh, nor right after a failed attempt. */
export function shouldAutoUpdate(meta = readMeta()) {
  if (isFresh(meta)) return false;
  const last = Date.parse(meta?.lastAttemptAt || '');
  return !(Number.isFinite(last) && Date.now() - last < AUTO_RETRY_MS && meta?.errors?.length);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Cross-process single-flight (two MCP server instances share the data folder). Returns true when acquired. */
function acquireLock() {
  ensureDir(dataDir());
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(lockFile(), 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return true; // lock not supported here: fall back to in-process single-flight
      const cur = readJson(lockFile(), null);
      const age = Date.now() - Date.parse(cur?.at || 0);
      if (cur?.pid && cur.pid !== process.pid && pidAlive(cur.pid) && age < LOCK_STALE_MS) return false;
      try {
        fs.unlinkSync(lockFile()); // stale (crashed process): take over
      } catch {
        /* raced */
      }
    }
  }
  return false;
}

function releaseLock() {
  try {
    const cur = readJson(lockFile(), null);
    if (!cur || cur.pid === process.pid) fs.unlinkSync(lockFile());
  } catch {
    /* already gone */
  }
}

/**
 * Start the update in the background. Returns {started, message, ...} immediately.
 * The job's promise is kept on `job.promise` (tests and the status tool can observe it).
 */
export function startUpdate({ force = false, reason = 'manual' } = {}) {
  if (job.running) return { started: false, status: 'em andamento', ...jobStatus() };
  const meta = readMeta();
  if (!force && isFresh(meta)) {
    return { started: false, status: `já atualizado em ${meta.updatedAt}`, updatedAt: meta.updatedAt, counts: meta.counts };
  }
  if (!acquireLock()) return { started: false, status: 'em andamento em outro processo do servidor (aguarde e confira cards_cache_status)' };
  job.running = true;
  job.step = 'bulk-data';
  job.progress = {};
  job.startedAt = new Date().toISOString();
  job.finishedAt = null;
  log(`card cache update started (${reason})`);
  job.promise = runJob()
    .catch((e) => {
      log(`card cache job crashed: ${e?.message || e}`);
      return { errors: [String(e?.message || e)] };
    })
    .then((res) => {
      releaseLock();
      job.lastResult = res;
      job.running = false;
      job.step = 'done';
      job.finishedAt = new Date().toISOString();
      log(`card cache update finished${res?.errors?.length ? ` with ${res.errors.length} error(s)` : ''}`);
      return res;
    });
  return { started: true, status: 'iniciado', startedAt: job.startedAt };
}

export const waitForJob = () => job.promise ?? Promise.resolve(null);

function letters(arr) {
  const set = new Set((arr || []).map((c) => String(c).toUpperCase()));
  return ['W', 'U', 'B', 'R', 'G'].filter((c) => set.has(c)).join('');
}

/** Compact record for one Scryfall oracle card (or null to skip). */
export function compactCard(c) {
  if (!c || !c.oracle_id || !c.name) return null;
  if (Array.isArray(c.games) && !c.games.includes('paper')) return null;
  if (c.digital === true && !(c.games || []).includes('paper')) return null;
  if (SKIP_LAYOUTS.has(c.layout)) return null;
  const faces = Array.isArray(c.card_faces) && c.card_faces.length > 1 ? c.card_faces : null;
  const text = c.oracle_text ?? (faces ? faces.map((f) => f.oracle_text || '').join('\n//\n') : '');
  const cost = c.mana_cost ?? (faces ? faces.map((f) => f.mana_cost || '').join(' // ') : '');
  const type = c.type_line ?? (faces ? faces.map((f) => f.type_line || '').join(' // ') : '');
  const colors = c.colors ?? (faces ? faces.flatMap((f) => f.colors || []) : []);
  const rec = {
    oid: c.oracle_id,
    name: c.name,
    mv: Number(c.cmc) || 0,
    cost,
    type,
    text,
    colors: letters(colors),
    ci: letters(c.color_identity),
    kw: (c.keywords || []).slice(0, 12),
    legal: c.legalities?.commander ?? 'unknown',
    gc: !!c.game_changer,
    rank: Number.isFinite(c.edhrec_rank) ? c.edhrec_rank : null,
    usd: c.prices?.usd ? Number(c.prices.usd) : null,
    roles: textRoles(text, type, c.name),
  };
  if (faces) rec.faces = faces.map((f) => f.name).filter(Boolean);
  if (c.power != null) rec.pt = `${c.power}/${c.toughness}`;
  return rec;
}

async function runJob() {
  const t0 = Date.now();
  const errors = [];
  const old = readMeta() || {};
  const sources = {};
  const counts = {};
  let cardsOk = false;

  // 1. bulk-data index
  let entries = [];
  try {
    entries = await bulkData();
  } catch (e) {
    errors.push(`bulk-data: ${e.message}`);
  }
  const entry = (type) => entries.find((x) => x.type === type);
  const uriOf = (e) => e?.jsonl_download_uri || e?.download_uri || null;

  // 2. oracle cards
  const cards = new Map();
  const oc = entry('oracle_cards');
  if (uriOf(oc)) {
    job.step = 'oracle_cards';
    job.progress.cards = 0;
    try {
      await streamBulk(uriOf(oc), (obj) => {
        const rec = compactCard(obj);
        if (rec) {
          cards.set(rec.oid, rec);
          job.progress.cards = cards.size;
        }
      });
      sources.oracle_cards = { updatedAt: oc.updated_at ?? null, uri: uriOf(oc) };
      if (!cards.size) errors.push('oracle_cards: arquivo vazio');
    } catch (e) {
      errors.push(`oracle_cards: ${e.message}`);
      cards.clear();
    }
  } else if (entries.length) errors.push('oracle_cards: entrada não encontrada em /bulk-data');

  // 3. oracle tags → roles
  if (cards.size) {
    const ot = entry('oracle_tags');
    if (uriOf(ot)) {
      job.step = 'oracle_tags';
      job.progress.tags = 0;
      try {
        const idx = new Map([...cards.keys()].map((k, i) => [k, i]));
        const recs = [...cards.values()];
        const tags = [];
        await streamBulk(uriOf(ot), (t) => {
          if (!t || (t.type && t.type !== 'oracle') || !t.id) return;
          const ids = [];
          for (const g of t.taggings || []) {
            const i = idx.get(g.oracle_id);
            if (i !== undefined) ids.push(i);
          }
          tags.push({ id: t.id, slug: t.slug || t.label, parent_ids: t.parent_ids || [], taggings: Int32Array.from(ids) });
          job.progress.tags = tags.length;
        });
        const roleTags = resolveTagRoles(tags);
        let tagged = 0;
        for (const t of tags) {
          const info = roleTags.get(t.id);
          if (!info) continue;
          for (const i of t.taggings) {
            const rec = recs[i];
            if (!rec.tags) {
              rec.tags = [];
              tagged++;
            }
            for (const r of info.roles) if (!rec.roles.includes(r)) rec.roles.push(r);
            if (rec.tags.length < MAX_RAW_TAGS && !rec.tags.includes(info.slug)) rec.tags.push(info.slug);
          }
        }
        counts.tagsRead = tags.length;
        counts.roleTags = roleTags.size;
        counts.cardsTagged = tagged;
        sources.oracle_tags = { updatedAt: ot.updated_at ?? null, uri: uriOf(ot) };
      } catch (e) {
        errors.push(`oracle_tags: ${e.message}`);
      }
    } else errors.push('oracle_tags: entrada não encontrada em /bulk-data');

    job.step = 'saving cards';
    writeJson(files.cards(), { v: 1, updatedAt: new Date().toISOString(), cards: [...cards.values()] });
    counts.cards = cards.size;
    cardsOk = true;
  }

  // 4. Portuguese names
  job.step = 'pt-names';
  job.progress.ptPages = 0;
  const pt = {};
  const ptTally = new Map(); // normalized PT → Map(EN → n): the same PT name may exist for different cards
  const tally = new Map(); // EN → Map(PT → n)
  let ptError = null;
  try {
    await searchAll('lang:pt game:paper', { unique: 'prints', include_multilingual: 'true' }, (body, page) => {
      for (const c of body?.data || []) {
        const en = c.name;
        if (!en) continue;
        const faceNames = (c.card_faces || []).map((f) => f.printed_name).filter(Boolean);
        const full = c.printed_name || (faceNames.length ? faceNames.join(' // ') : null);
        if (!full) continue;
        for (const n of new Set([full, ...faceNames])) {
          const k = normName(n);
          if (!k) continue;
          if (!ptTally.has(k)) ptTally.set(k, new Map());
          const m = ptTally.get(k);
          m.set(en, (m.get(en) || 0) + 1);
        }
        if (!tally.has(en)) tally.set(en, new Map());
        const m = tally.get(en);
        m.set(full, (m.get(full) || 0) + 1);
      }
      job.progress.ptPages = page;
      job.progress.ptTotal = body?.total_cards ?? job.progress.ptTotal;
    });
  } catch (e) {
    ptError = e.message;
    errors.push(`pt-names: ${e.message} (páginas lidas: ${job.progress.ptPages})`);
  }
  const ptAmbiguous = {};
  for (const [k, m] of ptTally) {
    const ranked = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    pt[k] = ranked[0][0];
    if (ranked.length > 1) ptAmbiguous[k] = ranked.map((x) => x[0]).slice(0, 6);
  }
  const en = {};
  for (const [name, m] of tally) en[name] = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  const oldPt = readJson(files.pt(), null);
  const oldSize = oldPt?.pt ? Object.keys(oldPt.pt).length : 0;
  if (Object.keys(pt).length && (!ptError || Object.keys(pt).length >= oldSize)) {
    writeJson(files.pt(), { v: 1, updatedAt: new Date().toISOString(), partial: !!ptError, pt, en, ambiguous: ptAmbiguous });
    sources.ptNames = { query: 'lang:pt game:paper', pages: job.progress.ptPages, partial: !!ptError };
  }
  counts.ptNames = Object.keys(pt).length || oldSize;
  counts.enWithPt = Object.keys(en).length || (oldPt?.en ? Object.keys(oldPt.en).length : 0);

  const meta = {
    updatedAt: cardsOk ? new Date().toISOString() : old.updatedAt ?? null,
    lastAttemptAt: new Date().toISOString(),
    counts: cardsOk ? counts : { ...(old.counts || {}), ...(counts.ptNames ? { ptNames: counts.ptNames, enWithPt: counts.enWithPt } : {}) },
    sources: { ...(old.sources || {}), ...sources },
    durationMs: Date.now() - t0,
    partial: cardsOk && errors.length > 0,
    errors,
  };
  writeJson(files.meta(), meta, { pretty: true });
  loaded = null; // force reload on next use
  return meta;
}

// ---------------- loading + indexes ----------------

let loaded = null; // {mtimeCards, mtimePt, list, byNorm, pt, en, names}

function mtime(f) {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}

/** Load the cache (lazily, reloading when files change). Returns null when there is no cache. */
export function getCache() {
  const mc = mtime(files.cards());
  const mp = mtime(files.pt());
  if (!mc && !mp) return null;
  if (loaded && loaded.mtimeCards === mc && loaded.mtimePt === mp) return loaded;
  const data = mc ? readJson(files.cards(), null) : null;
  const ptData = mp ? readJson(files.pt(), null) : null;
  const list = Array.isArray(data?.cards) ? data.cards : [];
  const byNorm = new Map();
  for (const c of list) {
    const k = normName(c.name);
    if (!byNorm.has(k)) byNorm.set(k, c);
  }
  for (const c of list) {
    for (const f of c.faces || []) {
      const k = normName(f);
      if (!byNorm.has(k)) byNorm.set(k, c);
    }
  }
  const pt = new Map(Object.entries(ptData?.pt || {}));
  const en = new Map(Object.entries(ptData?.en || {}));
  const ptAmbiguous = new Map(Object.entries(ptData?.ambiguous || {}));
  loaded = { mtimeCards: mc, mtimePt: mp, list, byNorm, pt, en, ptAmbiguous, hasCards: list.length > 0, names: null };
  return loaded;
}

/** EN card record by English (or face) name. */
export function findCard(name) {
  const c = getCache();
  if (!c) return null;
  return c.byNorm.get(normName(name)) || null;
}

/** Most common PT name for an English name. */
export function ptNameOf(enName) {
  const c = getCache();
  if (!c) return null;
  if (c.en.has(enName)) return c.en.get(enName);
  const rec = findCard(enName);
  return rec && c.en.has(rec.name) ? c.en.get(rec.name) : null;
}

function nameList(c) {
  if (c.names) return c.names;
  const arr = [];
  for (const [k, rec] of c.byNorm) arr.push({ k, en: rec.name, lang: 'en' });
  for (const [k, en] of c.pt) arr.push({ k, en, lang: 'pt' });
  c.names = arr;
  return arr;
}

/**
 * Local resolution of an EN or PT name. Returns {en, lang, how, confidence} or null.
 * how: exact | close | prefix
 */
export function resolveLocal(name) {
  const c = getCache();
  if (!c) return null;
  const k = normName(name);
  if (!k) return null;
  const en = c.byNorm.get(k);
  if (en) return { en: en.name, lang: 'en', how: 'exact', confidence: 1 };
  if (c.pt.has(k)) {
    const alts = c.ptAmbiguous?.get(k);
    // Same PT printed name used by different cards: best guess (most printings) + the alternatives.
    if (alts?.length > 1) return { en: c.pt.get(k), lang: 'pt', how: 'exact', confidence: 0.6, alternatives: alts };
    return { en: c.pt.get(k), lang: 'pt', how: 'exact', confidence: 1 };
  }
  if (k.length < 4) return null;
  const maxD = k.length < 8 ? 1 : 2;
  let best = maxD + 1;
  let hits = new Map();
  const prefix = new Map();
  for (const n of nameList(c)) {
    if (n.k.startsWith(k)) prefix.set(n.en, n.lang);
    if (Math.abs(n.k.length - k.length) > maxD) continue;
    const d = levenshtein(k, n.k, maxD);
    if (d < best) {
      best = d;
      hits = new Map([[n.en, n.lang]]);
    } else if (d === best && d <= maxD) hits.set(n.en, n.lang);
  }
  if (best <= maxD && hits.size === 1) {
    const [[enName, lang]] = [...hits];
    return { en: enName, lang, how: 'close', distance: best, confidence: best === 1 ? 0.85 : 0.7 };
  }
  if (prefix.size === 1) {
    const [[enName, lang]] = [...prefix];
    return { en: enName, lang, how: 'prefix', confidence: 0.75 };
  }
  if (best <= maxD && hits.size > 1) return { ambiguous: [...hits.keys()].slice(0, 6) };
  return null;
}

export function cacheSummary() {
  const meta = readMeta();
  const sizes = {};
  for (const [k, f] of Object.entries(files)) {
    try {
      sizes[k] = Math.round((fs.statSync(f()).size / 1048576) * 10) / 10;
    } catch {
      sizes[k] = null;
    }
  }
  return { location: dataDir(), fresh: isFresh(meta), meta, sizesMB: sizes };
}
