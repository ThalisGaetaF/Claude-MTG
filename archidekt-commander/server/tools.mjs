// MCP tool definitions for Archidekt. Each handler returns a string or a JSON-able object.

import crypto from 'node:crypto';
import { ArchidektError } from './client.mjs';
import { buildInsightTools } from './tools-insight.mjs';
import { buildOptimizeTools } from './tools-optimize.mjs';
import { buildMatchupTools } from './tools-matchups.mjs';
import { toEnglish } from './translate.mjs';
import {
  cardSummary, deckUrl, descriptionText, finishToModifier, fold, formatId, formatName, frontFace,
  ciLetters, deckIdentityOf, nameMatches, normColors, oracleText, parseDeck, renderDeck, validateCommander, withinIdentity,
} from './commander.mjs';
import { findCard } from './cache.mjs';

const RO = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

const patchId = () => crypto.randomUUID().replace(/-/g, '');
const inputError = (msg) => new ArchidektError('input', msg);

function posInt(v, field, { min = 1, max = Infinity, optional = false } = {}) {
  if (v === undefined || v === null) {
    if (optional) return undefined;
    throw inputError(`"${field}" é obrigatório.`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw inputError(`"${field}" deve ser inteiro entre ${min} e ${max === Infinity ? '∞' : max}.`);
  return n;
}

function str(v, field, { optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return undefined;
    throw inputError(`"${field}" é obrigatório.`);
  }
  if (typeof v !== 'string') throw inputError(`"${field}" deve ser texto.`);
  return v.trim();
}

const SINGLETON_FORMATS = new Set([3, 14, 17, 20, 23]); // commander, oathbreaker, paupercommander, brawl, predh
// Archidekt stores condition and language as integers (from the site's JS bundle, verified 2026-10-11).
const CONDITION_CODES = { NM: 1, LP: 2, MP: 3, HP: 4, D: 5 };
const CONDITION_ALIASES = { M: 'NM', MINT: 'NM', 'NEAR MINT': 'NM', 'LIGHTLY PLAYED': 'LP', 'MODERATELY PLAYED': 'MP', 'HEAVILY PLAYED': 'HP', DAMAGED: 'D', DMG: 'D', SP: 'LP', PL: 'MP' };
const CONDITIONS = Object.keys(CONDITION_CODES);
const LANGUAGE_CODES = { EN: 1, CT: 2, DE: 3, FR: 4, IT: 5, JP: 6, KR: 7, PT: 8, RU: 9, CS: 10, SP: 11 };
const LANGUAGE_ALIASES = { ZHT: 'CT', JA: 'JP', KO: 'KR', ZHS: 'CS', ES: 'SP', 'PT-BR': 'PT', PTBR: 'PT', ENGLISH: 'EN', PORTUGUESE: 'PT', PORTUGUES: 'PT', 'PORTUGUÊS': 'PT', INGLES: 'EN', 'INGLÊS': 'EN', JAPANESE: 'JP', SPANISH: 'SP', GERMAN: 'DE', FRENCH: 'FR', ITALIAN: 'IT', RUSSIAN: 'RU', KOREAN: 'KR' };
const LANGUAGES = Object.keys(LANGUAGE_CODES);
const codeName = (map, n) => Object.keys(map).find((k) => map[k] === n) ?? n;

function toConditionCode(v) {
  if (typeof v === 'number' && Object.values(CONDITION_CODES).includes(v)) return v;
  let k = String(v ?? 'NM').trim().toUpperCase();
  k = CONDITION_ALIASES[k] ?? k;
  if (!(k in CONDITION_CODES)) throw inputError(`condition deve ser um de ${CONDITIONS.join(', ')}.`);
  return CONDITION_CODES[k];
}

function toLanguageCode(v) {
  if (typeof v === 'number' && Object.values(LANGUAGE_CODES).includes(v)) return v;
  let k = String(v ?? 'EN').trim().toUpperCase();
  k = LANGUAGE_ALIASES[k] ?? k;
  if (!(k in LANGUAGE_CODES)) throw inputError(`language deve ser um de ${LANGUAGES.join(', ')}.`);
  return LANGUAGE_CODES[k];
}

export function buildTools(client) {
  // ---------- shared helpers ----------

  async function cardSearch(name, { exact = false, set, number, pageSize = 25 } = {}) {
    const body = await client.request('GET', '/cards/v2/', {
      auth: 'none',
      params: {
        name,
        exact: exact ? 'true' : undefined,
        edition: set ? String(set).toLowerCase() : undefined,
        collectorNumber: number,
        pageSize,
      },
    });
    if (!body || !Array.isArray(body.results)) throw new ArchidektError('contract', 'Resposta inesperada de /cards/v2/.');
    return body.results;
  }

  /**
   * Resolve a card name (or cardid) to a printing object {id, edition, oracleCard, options}.
   * Accepts Portuguese names: an exact PT hit in the local cache is translated up front; any other
   * miss on Archidekt is translated (cache → Scryfall → LigaMagic) and retried once.
   * The result carries `translation` when a translation was used.
   */
  async function resolveCard(args) {
    if (args.cardid != null || !args.cardName) return resolveCardRaw(args);
    const name = str(args.cardName, 'cardName');
    const pre = await toEnglish(name, { remote: false }).catch(() => null);
    if (pre?.alternatives?.length > 1) {
      // The same PT printed name belongs to different cards: never guess on a write.
      throw inputError(`"${name}" é o nome em português de mais de uma carta: ${pre.alternatives.join(', ')}. Informe o nome em inglês.`);
    }
    if (pre && pre.how === 'exact') {
      const card = await resolveCardRaw({ ...args, cardName: pre.en });
      return Object.assign(card, { translation: { input: name, en: pre.en, source: pre.source } });
    }
    try {
      return await resolveCardRaw(args);
    } catch (e) {
      if (e.kind !== 'not_found') throw e;
      const t = await toEnglish(name).catch(() => null);
      if (!t || nameMatches(t.en, name)) throw e;
      const card = await resolveCardRaw({ ...args, cardName: t.en }).catch(() => {
        throw e;
      });
      return Object.assign(card, { translation: { input: name, en: t.en, source: t.source, confidence: t.confidence } });
    }
  }

  async function resolveCardRaw({ cardName, cardid, set, number, finish }) {
    if (cardid != null) {
      const id = posInt(cardid, 'cardid');
      return { id, oracleCard: cardName ? { name: cardName } : null, edition: set ? { editioncode: set } : null, byId: true };
    }
    const name = str(cardName, 'cardName');
    const filterHits = (list) => list.filter((c) => nameMatches(c.oracleCard?.name, name));
    let hits = [];
    if (set) {
      hits = filterHits(await cardSearch(name, { exact: true, set, number }));
      if (!hits.length) hits = filterHits(await cardSearch(frontFace(name), { set, number, pageSize: 50 }));
    }
    if (!hits.length) hits = filterHits(await cardSearch(name, { exact: true }));
    if (!hits.length) hits = filterHits(await cardSearch(frontFace(name), { pageSize: 50 }));
    if (!hits.length) {
      const loose = await cardSearch(frontFace(name).split(/[\s,]+/)[0] || name, { pageSize: 20 }).catch(() => []);
      const sugg = [...new Set(loose.map((c) => c.oracleCard?.name).filter(Boolean))].slice(0, 8);
      throw new ArchidektError('not_found', `Carta não encontrada: "${name}"${set ? ` (set ${set})` : ''}.${sugg.length ? ` Parecidas: ${sugg.join('; ')}` : ''}`);
    }
    const score = (c) => {
      let s = 0;
      if (set && fold(c.edition?.editioncode) === fold(set)) s += 4;
      if (number && String(c.collectorNumber) === String(number)) s += 2;
      if (finish && (c.options || []).includes(finishToModifier(finish))) s += 1;
      return s;
    };
    return [...hits].sort((a, b) => score(b) - score(a))[0];
  }

  async function getDeckRaw(deckId) {
    const raw = await client.request('GET', `/decks/${deckId}/`, { auth: 'optional' });
    if (!raw || !Array.isArray(raw.cards)) throw new ArchidektError('contract', 'Resposta inesperada de /decks/{id}/.');
    return raw;
  }
  const getDeck = async (deckId) => parseDeck(await getDeckRaw(deckId));

  /**
   * Apply a list of card changes to a deck, re-read and verify. Nothing is saved on disk: the result carries
   * `undo`, the list of changes that reverts what was applied (computed from the before/after decks).
   */
  async function applyDeckChanges(id, changes) {
    await client.ensureAuth();
    const before = await getDeck(id);
    let deck = before;
    const applied = [];
    const translations = [];
    const expects = [];
    const touched = new Set();
    let failure = null;
    for (let i = 0; i < changes.length; i++) {
      const ch = changes[i] || {};
      const key = ch.deckRelationId != null ? `rel:${ch.deckRelationId}` : ch.cardName ? fold(frontFace(ch.cardName)) : `id:${ch.cardid}`;
      try {
        if (touched.has(key)) deck = await getDeck(id); // same card twice → plan against fresh state
        const plan = await planChange(deck, ch);
        if (plan.translation) translations.push({ index: i, ...plan.translation });
        await modifyCards(id, plan.entry);
        applied.push({ index: i, change: plan.label });
        // a later change to the same card supersedes the earlier expectation
        for (let j = expects.length - 1; j >= 0; j--) if (expects[j].key === key) expects.splice(j, 1);
        expects.push({ ...plan, key });
        touched.add(key);
      } catch (e) {
        failure = { index: i, change: ch, error: e.message };
        break;
      }
    }
    let after = null;
    let readError = null;
    try {
      after = applied.length ? await getDeck(id) : before;
    } catch (e) {
      readError = e.message;
    }
    const failedChecks = after ? expects.filter((p) => !p.expect(after)).map((p) => p.label) : expects.map((p) => p.label);
    const result = {
      deckId: id,
      applied,
      ...(failure ? { stoppedAt: failure, notAttempted: changes.length - failure.index - 1 } : {}),
      diff: after ? diffDecks(before, after) : [],
      cardCountBefore: before.mainCount,
      cardCountAfter: after?.mainCount ?? null,
      verification: verification(!readError && failedChecks.length === 0, readError ? `releitura falhou: ${readError}` : failedChecks.length ? `não confirmadas: ${failedChecks.join('; ')}` : ''),
      ...(translations.length ? { translations } : {}),
    };
    const undo = after ? undoChanges(before, after) : [];
    if (undo.length) result.undo = undo;
    return result;
  }

  const modifyCards = (deckId, entry) =>
    client.request('PATCH', `/decks/${deckId}/modifyCards/v2/`, { auth: 'required', body: { cards: [entry] } });

  function deckListRow(d) {
    return {
      id: d.id,
      name: d.name,
      format: formatName(d.deckFormat),
      size: d.size ?? null,
      colors: normColors(d.colors),
      bracket: d.edhBracket ?? null,
      private: !!d.private,
      updatedAt: d.updatedAt ?? null,
      owner: d.owner?.username ?? null,
      url: deckUrl(d.id),
    };
  }

  function recordSummary(r) {
    const c = r.card || {};
    return {
      recordId: r.id,
      qty: r.quantity,
      name: c.oracleCard?.name ?? null,
      set: c.edition?.editioncode ?? null,
      number: c.collectorNumber ?? null,
      cardid: c.id ?? null,
      finish: r.modifier ?? 'Normal',
      condition: r.condition == null ? null : codeName(CONDITION_CODES, r.condition),
      language: r.language == null ? null : codeName(LANGUAGE_CODES, r.language),
    };
  }

  async function collectionPage(userId, { page = 1, pageSize = 100, cardName } = {}) {
    const body = await client.request('GET', `/collection/${userId}/v2/`, {
      auth: 'required',
      params: { page, pageSize, cardName },
    });
    if (!body || !Array.isArray(body.results)) throw new ArchidektError('contract', 'Resposta inesperada da coleção.');
    return body;
  }

  /** All records whose oracle name matches `name` (paged lookup by cardName). */
  async function ownedRecords(userId, name, maxPages = 10) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const body = await collectionPage(userId, { page, pageSize: 500, cardName: name });
      out.push(...body.results.filter((r) => nameMatches(r.card?.oracleCard?.name, name)));
      const total = body.totalPages ?? (body.next ? page + 1 : page);
      if (page >= total) break;
    }
    return out;
  }

  /** Find collection records by id. Uses a name hint if given, else scans pages. */
  async function findRecords(userId, ids, cardName) {
    const want = new Set(ids.map(Number));
    const found = new Map();
    if (cardName) {
      for (const r of await ownedRecords(userId, cardName)) if (want.has(r.id)) found.set(r.id, r);
      if (found.size === want.size) return found;
    }
    for (let page = 1; page <= 40 && found.size < want.size; page++) {
      const body = await collectionPage(userId, { page, pageSize: 500 });
      for (const r of body.results) if (want.has(r.id)) found.set(r.id, r);
      const total = body.totalPages ?? (body.next ? page + 1 : page);
      if (page >= total) break;
    }
    return found;
  }

  const verification = (ok, reason) => (ok ? 'verified' : `not verified${reason ? ` (${reason})` : ''}`);

  // ---------- deck card changes ----------

  function findRow(deck, ch, { filterCategory }) {
    if (ch.deckRelationId != null) {
      const r = deck.rows.find((x) => x.relId === Number(ch.deckRelationId));
      if (!r) throw inputError(`deckRelationId ${ch.deckRelationId} não está no deck.`);
      return r;
    }
    let rows = deck.rows.filter((r) =>
      ch.cardid != null ? r.cardid === Number(ch.cardid) : nameMatches(r.name, str(ch.cardName, 'cardName')),
    );
    if (filterCategory && ch.category) rows = rows.filter((r) => fold(r.category) === fold(ch.category));
    if (!rows.length) throw new ArchidektError('not_found', `"${ch.cardName ?? ch.cardid}" não está no deck${filterCategory && ch.category ? ` na categoria ${ch.category}` : ''}.`);
    if (rows.length > 1) {
      const inDeck = rows.filter((r) => r.included);
      if (inDeck.length === 1) return inDeck[0];
      throw inputError(`"${ch.cardName ?? ch.cardid}" aparece em várias linhas: ${rows.map((r) => `rel=${r.relId} [${r.category}] x${r.qty}`).join(', ')}. Informe deckRelationId ou category.`);
    }
    return rows[0];
  }

  /** findRow that retries with the English name when a PT (or misspelled) name is not in the deck. */
  async function findRowT(deck, ch, opts) {
    try {
      return { row: findRow(deck, ch, opts) };
    } catch (e) {
      if (e.kind !== 'not_found' || !ch.cardName || ch.cardid != null || ch.deckRelationId != null) throw e;
      const t = await toEnglish(ch.cardName).catch(() => null);
      if (!t) throw e;
      // Ambiguous PT name: use the alternative that is actually in the deck.
      for (const en of t.alternatives?.length > 1 ? t.alternatives : [t.en]) {
        try {
          return { row: findRow(deck, { ...ch, cardName: en }, opts), translation: { input: ch.cardName, en, source: t.source } };
        } catch (e2) {
          if (e2.kind !== 'not_found') throw e2;
        }
      }
      throw e;
    }
  }

  const modifyEntry = (row, { quantity, categories, modifier }) => ({
    action: 'modify',
    cardid: row.cardid,
    deckRelationId: row.relId,
    patchId: patchId(),
    categories: categories ?? row.categories,
    modifications: { quantity, companion: row.companion, flippedDefault: row.flippedDefault, modifier: modifier ?? row.modifier },
  });
  const removeEntry = (row) => ({
    action: 'remove',
    cardid: row.cardid,
    deckRelationId: row.relId,
    patchId: patchId(),
    categories: row.categories,
    modifications: { quantity: 0, companion: row.companion, flippedDefault: row.flippedDefault, modifier: row.modifier },
  });

  const unlimited = (o = {}) =>
    ((o.superTypes || []).some((t) => fold(t) === 'basic') && (o.types || []).some((t) => fold(t) === 'land')) || /a deck can have (any number|up to \w+) cards named/i.test(oracleText(o));

  /** Plan one change → {entry, label, expect(afterDeck) → bool}. */
  async function planChange(deck, ch) {
    const action = ch.action;
    if (action === 'add') {
      const qty = posInt(ch.quantity ?? 1, 'quantity', { max: 250 });
      const card = await resolveCard({ cardName: ch.cardName, cardid: ch.cardid, set: ch.set, finish: ch.finish });
      const translation = card.translation;
      const name = card.oracleCard?.name ?? ch.cardName ?? `cardid ${card.id}`;
      const category = ch.category ?? card.oracleCard?.defaultCategory ?? null;
      const matches = (r) => (card.byId && !ch.cardName ? r.cardid === card.id : nameMatches(r.name, name));
      const withT = (plan) => (translation ? { ...plan, translation } : plan);
      const existing = deck.rows.find((r) => matches(r) && (category ? fold(r.category) === fold(category) : r.included));
      if (existing) {
        if (!unlimited(existing.oracle)) {
          throw inputError(`${existing.name} já está no deck (rel=${existing.relId}, ${existing.category}, x${existing.qty}). Use set_quantity ou move_category.`);
        }
        const target = existing.qty + qty;
        return withT({
          entry: modifyEntry(existing, { quantity: target }),
          label: `add ${qty}x ${name} → ${existing.category} (agora ${target})`,
          expect: (after) => after.rows.some((r) => r.relId === existing.relId && r.qty === target),
        });
      }
      // Singleton: refuse a second main-deck row of the same card under another included category.
      const catInfo = category ? deck.categories.find((c) => fold(c.name) === fold(category)) : null;
      const targetIncluded = !category || (catInfo ? catInfo.included : !/^(maybeboard|sideboard)$/i.test(category));
      // Color identity is a hard Commander rule: never put an off-color card in the main deck.
      if (targetIncluded && deck.commanders?.length) {
        const ident = deckIdentityOf(deck, findCard);
        const oc = card.oracleCard?.colorIdentity;
        const cardCi = oc != null && (!Array.isArray(oc) || oc.length) ? ciLetters(oc) : findCard(name)?.ci ?? (Array.isArray(oc) ? '' : null);
        if (cardCi != null && !withinIdentity(cardCi, ident)) {
          throw inputError(`${name} [${cardCi || 'C'}] está fora da identidade de cor do comandante (${ident}). No Commander só entram cartas dentro da identidade — escolha outra carta (ou use a categoria Maybeboard).`);
        }
      }
      const inMain = targetIncluded && SINGLETON_FORMATS.has(deck.deckFormat) && deck.rows.find((r) => r.included && matches(r) && !unlimited(r.oracle));
      if (inMain) {
        throw inputError(`${inMain.name} já está no deck (rel=${inMain.relId}, ${inMain.category}, x${inMain.qty}) — Commander é singleton. Use move_category para trocar a categoria.`);
      }
      const prevTotal = deck.rows.filter(matches).reduce((s, r) => s + r.qty, 0);
      return withT({
        entry: {
          action: 'add',
          cardid: card.id,
          patchId: patchId(),
          categories: category ? [category] : [],
          modifications: { quantity: qty, companion: false, flippedDefault: false, modifier: finishToModifier(ch.finish) },
        },
        label: `add ${qty}x ${name}${card.edition?.editioncode ? ` (${card.edition.editioncode})` : ''} → ${category ?? '(categoria padrão)'}`,
        expect: (after) => {
          const rows = after.rows.filter((r) => (card.byId ? r.cardid === card.id : nameMatches(r.name, name)));
          const okCat = !category || rows.some((r) => fold(r.category) === fold(category));
          return okCat && rows.reduce((s, r) => s + r.qty, 0) >= prevTotal + qty;
        },
      });
    }
    if (action === 'remove') {
      const { row, translation } = await findRowT(deck, ch, { filterCategory: true });
      const withT = (plan) => (translation ? { ...plan, translation } : plan);
      const q = ch.quantity == null ? row.qty : posInt(ch.quantity, 'quantity');
      if (q < row.qty) {
        const target = row.qty - q;
        return withT({
          entry: modifyEntry(row, { quantity: target }),
          label: `remove ${q}x ${row.name} de ${row.category} (fica ${target})`,
          expect: (after) => after.rows.some((r) => r.relId === row.relId && r.qty === target),
        });
      }
      return withT({
        entry: removeEntry(row),
        label: `remove ${row.qty}x ${row.name} de ${row.category}`,
        expect: (after) => !after.rows.some((r) => r.relId === row.relId),
      });
    }
    if (action === 'set_quantity') {
      const { row, translation } = await findRowT(deck, ch, { filterCategory: true });
      const withT = (plan) => (translation ? { ...plan, translation } : plan);
      const q = posInt(ch.quantity, 'quantity', { min: 0, max: 250 });
      if (q === 0) {
        return withT({ entry: removeEntry(row), label: `remove ${row.name} (quantidade 0)`, expect: (after) => !after.rows.some((r) => r.relId === row.relId) });
      }
      const modifier = ch.finish ? finishToModifier(ch.finish) : undefined;
      return withT({
        entry: modifyEntry(row, { quantity: q, modifier }),
        label: `set ${row.name} ${row.qty} → ${q}${modifier ? ` (${modifier})` : ''}`,
        expect: (after) => after.rows.some((r) => r.relId === row.relId && r.qty === q),
      });
    }
    if (action === 'move_category') {
      const category = str(ch.category, 'category');
      const { row, translation } = await findRowT(deck, ch, { filterCategory: false });
      const rest = row.categories.slice(1).filter((c) => fold(c) !== fold(category));
      const plan = {
        entry: modifyEntry(row, { quantity: row.qty, categories: [category, ...rest] }),
        label: `move ${row.name}: ${row.category} → ${category}`,
        expect: (after) => after.rows.some((r) => nameMatches(r.name, row.name) && fold(r.category) === fold(category)),
      };
      return translation ? { ...plan, translation } : plan;
    }
    throw inputError(`Ação desconhecida: ${action}. Use add, remove, set_quantity ou move_category.`);
  }

  /** Changes that turn `after` back into `before` (by card name and category; quantities only). */
  function undoChanges(before, after) {
    const tally = (d) => {
      const m = new Map();
      for (const r of d.rows) {
        const k = `${fold(r.name)}|${r.category}`;
        const cur = m.get(k) || { name: r.name, category: r.category, qty: 0 };
        cur.qty += r.qty;
        m.set(k, cur);
      }
      return m;
    };
    const b = tally(before);
    const a = tally(after);
    const out = [];
    for (const [k, r] of b) {
      const now = a.get(k)?.qty ?? 0;
      if (now < r.qty) out.push({ action: 'add', cardName: r.name, quantity: r.qty - now, category: r.category });
    }
    for (const [k, r] of a) {
      const then = b.get(k)?.qty ?? 0;
      if (r.qty > then) out.push({ action: 'remove', cardName: r.name, quantity: r.qty - then, category: r.category });
    }
    return out;
  }

  function diffDecks(before, after) {
    const b = new Map(before.rows.map((r) => [r.relId, r]));
    const a = new Map(after.rows.map((r) => [r.relId, r]));
    const out = [];
    for (const [id, r] of a) {
      const old = b.get(id);
      if (!old) out.push(`+ ${r.qty} ${r.name} [${r.category}]`);
      else {
        if (old.qty !== r.qty) out.push(`~ ${r.name} [${r.category}] ${old.qty} → ${r.qty}`);
        if (old.category !== r.category) out.push(`> ${r.name}: ${old.category} → ${r.category}`);
        if (old.modifier !== r.modifier) out.push(`* ${r.name}: ${old.modifier} → ${r.modifier}`);
      }
    }
    for (const [id, r] of b) if (!a.has(id)) out.push(`- ${r.qty} ${r.name} [${r.category}]`);
    return out;
  }

  // ---------- tool list ----------

  const pageProp = { type: 'integer', minimum: 1, description: 'Página (1 = primeira).' };

  const archidektTools = [
    {
      name: 'archidekt_whoami',
      description: 'Mostra o usuário Archidekt logado (id e username). Útil para checar se as credenciais estão configuradas.',
      inputSchema: { type: 'object', properties: {} },
      annotations: RO,
      handler: async () => {
        const u = await client.me();
        return { id: u.id, username: u.username, credentialsSource: client.credentials.source };
      },
    },
    {
      name: 'archidekt_list_my_decks',
      description: 'Lista os decks do usuário logado (inclui privados), do mais recente ao mais antigo: id, nome, formato, tamanho, cores, privado, updatedAt, url.',
      inputSchema: { type: 'object', properties: { page: pageProp } },
      annotations: RO,
      handler: async ({ page }) => {
        const me = await client.me();
        const p = posInt(page ?? 1, 'page');
        const body = await client.request('GET', '/decks/v3/', {
          auth: 'required',
          params: { ownerId: me.id, orderBy: '-updatedAt', pageSize: 50, page: p },
        });
        const results = (body?.results || []).filter((d) => d.owner?.id == null || String(d.owner.id) === String(me.id));
        return { count: body?.count ?? results.length, page: p, hasMore: !!body?.next, decks: results.map(deckListRow) };
      },
    },
    {
      name: 'archidekt_search_decks',
      description: 'Busca decks públicos no Archidekt por nome do deck, nome do comandante e/ou username do dono (60 por página).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Parte do nome do deck.' },
          commanderName: { type: 'string', description: 'Nome do comandante (filtra formato commander).' },
          ownerUsername: { type: 'string', description: 'Username exato do dono.' },
          page: pageProp,
        },
      },
      annotations: RO,
      handler: async ({ name, commanderName, ownerUsername, page }) => {
        if (!name && !commanderName && !ownerUsername) throw inputError('Informe ao menos name, commanderName ou ownerUsername.');
        const p = posInt(page ?? 1, 'page');
        const body = await client.request('GET', '/decks/v3/', {
          auth: 'none',
          params: {
            name: name?.slice(0, 120),
            commanderName: commanderName?.slice(0, 120),
            deckFormat: commanderName ? 3 : undefined,
            ownerUsername: ownerUsername?.slice(0, 120),
            orderBy: '-updatedAt',
            page: p,
          },
        });
        return { count: body?.count ?? 0, page: p, hasMore: !!body?.next, decks: (body?.results || []).map(deckListRow) };
      },
    },
    {
      name: 'archidekt_get_deck',
      description:
        'Lê um deck: nome, formato, comandante(s), contagens, identidade de cor e cartas agrupadas por categoria (qtd, nome, MV, tipo, deckRelationId, cardid, set, owned). Use antes de propor qualquer mudança.',
      inputSchema: {
        type: 'object',
        properties: {
          deckId: { type: 'integer', description: 'Id do deck (número na URL archidekt.com/decks/<id>).' },
          includeMaybeboard: { type: 'boolean', default: true },
        },
        required: ['deckId'],
      },
      annotations: RO,
      handler: async ({ deckId, includeMaybeboard = true }) => renderDeck(await getDeck(posInt(deckId, 'deckId')), { includeMaybeboard }),
    },
    {
      name: 'archidekt_search_cards',
      description: 'Busca cartas (impressões) no banco do Archidekt: cardid, nome, set, número, acabamentos, tipo, MV, identidade de cor, legalidade em Commander, game changer.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nome em inglês (ou parte dele); nome em português também funciona (é traduzido).' },
          exact: { type: 'boolean', description: 'Somente nome exato.' },
          set: { type: 'string', description: 'Código do set, ex: "cmm".' },
          collectorNumber: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        },
        required: ['name'],
      },
      annotations: RO,
      handler: async ({ name, exact, set, collectorNumber, limit }) => {
        const n = str(name, 'name');
        const lim = posInt(limit ?? 10, 'limit', { max: 50 });
        let res = await cardSearch(n, { exact: !!exact, set, number: collectorNumber, pageSize: Math.max(lim, 25) });
        if (exact) {
          res = res.filter((c) => nameMatches(c.oracleCard?.name, n));
          if (!res.length) {
            // exact=true misses double-faced front faces: fall back to substring + filter
            res = (await cardSearch(frontFace(n), { set, number: collectorNumber, pageSize: 50 })).filter((c) => nameMatches(c.oracleCard?.name, n));
          }
        }
        let translation;
        if (!res.length) {
          const t = await toEnglish(n).catch(() => null);
          if (t) {
            translation = { input: n, en: t.en, source: t.source, confidence: t.confidence };
            res = await cardSearch(t.en, { exact: !!exact, set, number: collectorNumber, pageSize: Math.max(lim, 25) });
            if (exact) res = res.filter((c) => nameMatches(c.oracleCard?.name, t.en));
            if (!res.length) res = (await cardSearch(frontFace(t.en), { set, number: collectorNumber, pageSize: 50 })).filter((c) => nameMatches(c.oracleCard?.name, t.en));
          }
        }
        return { count: res.length, cards: res.slice(0, lim).map(cardSummary), ...(translation ? { translation } : {}) };
      },
    },
    {
      name: 'archidekt_get_collection',
      description: 'Lista a coleção do usuário logado (paginada): recordId, qtd, nome, set, acabamento, condição, idioma. Filtro opcional por nome.',
      inputSchema: {
        type: 'object',
        properties: {
          page: pageProp,
          pageSize: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          cardName: { type: 'string', description: 'Filtrar por nome da carta.' },
        },
      },
      annotations: RO,
      handler: async ({ page, pageSize, cardName }) => {
        const me = await client.me();
        const p = posInt(page ?? 1, 'page');
        const body = await collectionPage(me.id, { page: p, pageSize: posInt(pageSize ?? 100, 'pageSize', { max: 500 }), cardName });
        return {
          count: body.count ?? null,
          page: body.page ?? p,
          totalPages: body.totalPages ?? null,
          records: body.results.map(recordSummary),
        };
      },
    },
    {
      name: 'archidekt_search_collection',
      description: 'Verifica quantas cópias o usuário possui de cada carta (por nome exato) e em quais registros da coleção. Máx. 40 nomes por chamada.',
      inputSchema: {
        type: 'object',
        properties: { cardNames: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 40 } },
        required: ['cardNames'],
      },
      annotations: RO,
      handler: async ({ cardNames }) => {
        if (!Array.isArray(cardNames) || !cardNames.length) throw inputError('"cardNames" deve ser uma lista não vazia.');
        if (cardNames.length > 40) throw inputError('Máximo de 40 nomes por chamada.');
        const me = await client.me();
        const out = [];
        for (const raw of cardNames) {
          const input = str(raw, 'cardNames[]');
          let name = input;
          let translation;
          const pre = await toEnglish(input, { remote: false }).catch(() => null);
          if (pre && pre.how === 'exact') {
            name = pre.en;
            translation = { input, en: pre.en, source: pre.source };
          }
          let recs = await ownedRecords(me.id, name);
          if (!recs.length && !translation) {
            const t = await toEnglish(input).catch(() => null);
            if (t) {
              name = t.en;
              translation = { input, en: t.en, source: t.source, confidence: t.confidence };
              recs = await ownedRecords(me.id, name);
            }
          }
          out.push({ name, totalOwned: recs.reduce((s, r) => s + (Number(r.quantity) || 0), 0), records: recs.map(recordSummary), ...(translation ? { translation } : {}) });
        }
        return { results: out };
      },
    },
    {
      name: 'archidekt_validate_deck',
      description: 'Valida um deck de Commander: 100 cartas (só categorias incluídas no deck), singleton, identidade de cor, legalidade (banidas), comandante presente, e conta Game Changers.',
      inputSchema: { type: 'object', properties: { deckId: { type: 'integer' } }, required: ['deckId'] },
      annotations: RO,
      handler: async ({ deckId }) => validateCommander(await getDeck(posInt(deckId, 'deckId'))),
    },

    // ---------- writes ----------
    {
      name: 'archidekt_create_deck',
      description: 'Cria um deck novo (privado por padrão) e, se informado, adiciona o comandante na categoria "Commander". Relê e confirma (verified/not verified).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          private: { type: 'boolean', default: true },
          commander: { type: 'string', description: 'Nome da carta do comandante (inglês ou português).' },
          format: { type: 'string', default: 'commander' },
        },
        required: ['name'],
      },
      annotations: WRITE,
      handler: async (args) => {
        const name = str(args.name, 'name');
        const deckFormat = formatId(args.format ?? 'commander');
        await client.ensureAuth();
        // Resolve the commander first so we don't leave an empty deck behind on a typo.
        const cmd = args.commander ? await resolveCard({ cardName: args.commander }) : null;
        const created = await client.request('POST', '/decks/v2/', {
          auth: 'required',
          body: {
            name,
            description: args.description ?? '',
            deckFormat,
            edhBracket: null,
            parentFolder: null,
            private: args.private !== false,
            unlisted: false,
            theorycrafted: false,
            game: null,
            cardPackage: null,
            extras: { decksToInclude: [], commandersToAdd: [], forceCardsToSingleton: false, ignoreCardsOutOfCommanderIdentity: true },
          },
        });
        const id = created?.id;
        if (!id) throw new ArchidektError('contract', 'Deck criado mas a resposta não trouxe o id — confira em archidekt.com antes de tentar de novo.');
        let commanderError = null;
        if (cmd) {
          try {
            await modifyCards(id, {
              action: 'add', cardid: cmd.id, patchId: patchId(), categories: ['Commander'],
              modifications: { quantity: 1, companion: false, flippedDefault: false, modifier: 'Normal' },
            });
          } catch (e) {
            commanderError = e.message;
          }
        }
        const after = await getDeck(id);
        const okName = after.name === name;
        const okCmd = !cmd || after.commanders.some((c) => nameMatches(c.name, cmd.oracleCard.name));
        return {
          deckId: id,
          url: deckUrl(id),
          name: after.name,
          format: after.format,
          private: after.private,
          commanders: after.commanders.map((c) => c.name),
          ...(cmd?.translation ? { commanderTranslation: cmd.translation } : {}),
          ...(commanderError ? { commanderError } : {}),
          verification: verification(okName && okCmd, !okName ? 'nome difere' : !okCmd ? 'comandante não aparece no deck' : ''),
        };
      },
    },
    {
      name: 'archidekt_update_deck_cards',
      description:
        'Altera cartas de um deck. changes: lista de {action: add|remove|set_quantity|move_category, cardName|cardid|deckRelationId, quantity, category, set, finish}. cardName pode ser em português (é traduzido; a tradução usada volta em "translations"). Não salva nada em disco: a resposta traz "undo" (as mudanças que desfazem o que foi aplicado). Uma requisição por mudança; para na primeira falha; relê o deck e mostra o diff (verified/not verified). Peça confirmação do usuário antes.',
      inputSchema: {
        type: 'object',
        properties: {
          deckId: { type: 'integer' },
          changes: {
            type: 'array',
            minItems: 1,
            maxItems: 60,
            items: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['add', 'remove', 'set_quantity', 'move_category'] },
                cardName: { type: 'string' },
                cardid: { type: 'integer', description: 'Id da impressão (Archidekt).' },
                deckRelationId: { type: 'integer', description: 'Linha específica do deck (rel= no get_deck).' },
                quantity: { type: 'integer', minimum: 0 },
                category: { type: 'string', description: 'add: categoria destino; remove/set_quantity: filtra a linha; move_category: destino.' },
                set: { type: 'string' },
                finish: { type: 'string', enum: ['normal', 'foil', 'etched'] },
              },
              required: ['action'],
            },
          },
        },
        required: ['deckId', 'changes'],
      },
      annotations: WRITE,
      handler: async ({ deckId, changes }) => {
        const id = posInt(deckId, 'deckId');
        if (!Array.isArray(changes) || !changes.length) throw inputError('"changes" deve ser uma lista não vazia.');
        if (changes.length > 60) throw inputError('Máximo de 60 mudanças por chamada.');
        return applyDeckChanges(id, changes);
      },
    },
    {
      name: 'archidekt_update_deck_info',
      description: 'Altera dados do deck: nome, descrição, privado/público, bracket EDH (1–5). Relê e confirma.',
      inputSchema: {
        type: 'object',
        properties: {
          deckId: { type: 'integer' },
          name: { type: 'string' },
          description: { type: 'string' },
          private: { type: 'boolean' },
          edhBracket: { type: ['integer', 'null'], minimum: 1, maximum: 5 },
        },
        required: ['deckId'],
      },
      annotations: WRITE,
      handler: async (args) => {
        const id = posInt(args.deckId, 'deckId');
        const body = {};
        if (args.name !== undefined) body.name = str(args.name, 'name');
        if (args.description !== undefined) body.description = String(args.description);
        if (args.private !== undefined) body.private = !!args.private;
        if (args.edhBracket !== undefined) body.edhBracket = args.edhBracket === null ? null : posInt(args.edhBracket, 'edhBracket', { max: 5 });
        if (!Object.keys(body).length) throw inputError('Nada para alterar: informe name, description, private ou edhBracket.');
        await client.request('PATCH', `/decks/${id}/update/`, { auth: 'required', body });
        const after = await getDeck(id);
        const bad = [];
        if ('name' in body && after.name !== body.name) bad.push('name');
        if ('private' in body && after.private !== body.private) bad.push('private');
        if ('edhBracket' in body && (after.edhBracket ?? null) !== body.edhBracket) bad.push('edhBracket');
        if ('description' in body && descriptionText(after.description).trim() !== descriptionText(body.description).trim()) bad.push('description');
        return {
          deckId: id,
          now: { name: after.name, private: after.private, edhBracket: after.edhBracket, description: after.description.slice(0, 200) },
          verification: verification(!bad.length, bad.length ? `campos diferentes: ${bad.join(', ')}` : ''),
        };
      },
    },
    {
      name: 'archidekt_delete_deck',
      description: 'APAGA um deck permanentemente. Exige confirm: true — só use depois de um "sim" explícito do usuário.',
      inputSchema: {
        type: 'object',
        properties: { deckId: { type: 'integer' }, confirm: { type: 'boolean', description: 'Precisa ser true.' } },
        required: ['deckId', 'confirm'],
      },
      annotations: DESTRUCTIVE,
      handler: async ({ deckId, confirm }) => {
        const id = posInt(deckId, 'deckId');
        if (confirm !== true) throw inputError('Exclusão não confirmada. Peça um "sim" explícito ao usuário e chame de novo com confirm: true.');
        await client.ensureAuth();
        const before = await getDeck(id);
        await client.request('DELETE', `/decks/${id}/`, { auth: 'required' });
        let gone = false;
        try {
          const raw = await getDeckRaw(id);
          gone = !!raw.deletedAt;
        } catch (e) {
          gone = e.status === 404 || e.status === 400;
        }
        return { deleted: { id, name: before.name }, verification: verification(gone, gone ? '' : 'o deck ainda pode ser lido') };
      },
    },
    {
      name: 'archidekt_collection_add',
      description: 'Adiciona cópias de uma carta à coleção (condition padrão NM, idioma EN). Relê a coleção e confirma.',
      inputSchema: {
        type: 'object',
        properties: {
          cardName: { type: 'string' },
          cardid: { type: 'integer' },
          quantity: { type: 'integer', minimum: 1 },
          set: { type: 'string' },
          finish: { type: 'string', enum: ['normal', 'foil', 'etched'] },
          condition: { type: 'string', enum: CONDITIONS, default: 'NM', description: 'NM, LP, MP, HP ou D.' },
          language: { type: 'string', enum: LANGUAGES, default: 'EN', description: 'EN, PT, JP, SP, DE, FR, IT, KR, RU, CS (chinês simpl.), CT (chinês trad.).' },
        },
        required: ['quantity'],
      },
      annotations: WRITE,
      handler: async (args) => {
        if (!args.cardName && args.cardid == null) throw inputError('Informe cardName ou cardid.');
        const qty = posInt(args.quantity, 'quantity', { max: 999 });
        const condition = toConditionCode(args.condition ?? 'NM');
        const language = toLanguageCode(args.language ?? 'EN');
        const me = await client.me();
        const card = await resolveCard({ cardName: args.cardName, cardid: args.cardid, set: args.set, finish: args.finish });
        const name = card.oracleCard?.name ?? null;
        const beforeTotal = name ? (await ownedRecords(me.id, name)).reduce((s, r) => s + r.quantity, 0) : null;
        const resp = await client.request('POST', '/collection/v2/', {
          auth: 'required',
          body: { game: 1, quantity: qty, card: card.id, modifier: finishToModifier(args.finish), condition, language },
        });
        let ok = false;
        let reason = '';
        let afterTotal = null;
        if (name) {
          afterTotal = (await ownedRecords(me.id, name)).reduce((s, r) => s + r.quantity, 0);
          ok = afterTotal === beforeTotal + qty;
          if (!ok) reason = `total era ${beforeTotal}, agora ${afterTotal}`;
        } else if (resp?.id) {
          const found = await findRecords(me.id, [resp.id]);
          ok = found.has(resp.id);
          if (!ok) reason = 'registro novo não encontrado';
        } else reason = 'resposta sem id e sem nome para conferir';
        return {
          added: { name: name ?? `cardid ${card.id}`, cardid: card.id, set: card.edition?.editioncode ?? null, quantity: qty, recordId: resp?.id ?? null },
          ...(card.translation ? { translation: card.translation } : {}),
          totalOwnedBefore: beforeTotal,
          totalOwnedAfter: afterTotal,
          verification: verification(ok, reason),
        };
      },
    },
    {
      name: 'archidekt_collection_update',
      description: 'Altera um registro da coleção (quantidade, condição, idioma, acabamento). cardName opcional acelera a busca do registro. Relê e confirma.',
      inputSchema: {
        type: 'object',
        properties: {
          recordId: { type: 'integer' },
          quantity: { type: 'integer', minimum: 1 },
          condition: { type: 'string', enum: CONDITIONS },
          language: { type: 'string', enum: LANGUAGES },
          finish: { type: 'string', enum: ['normal', 'foil', 'etched'] },
          cardName: { type: 'string', description: 'Nome da carta do registro (opcional, acelera).' },
        },
        required: ['recordId'],
      },
      annotations: WRITE,
      handler: async (args) => {
        const rid = posInt(args.recordId, 'recordId');
        if (args.quantity == null && !args.condition && !args.language && !args.finish) throw inputError('Nada para alterar: informe quantity, condition, language ou finish.');
        const me = await client.me();
        const rec = (await findRecords(me.id, [rid], args.cardName)).get(rid);
        if (!rec) throw new ArchidektError('not_found', `Registro ${rid} não encontrado na coleção.`);
        const want = {
          quantity: args.quantity != null ? posInt(args.quantity, 'quantity', { max: 999 }) : rec.quantity,
          condition: args.condition ? toConditionCode(args.condition) : rec.condition,
          language: args.language ? toLanguageCode(args.language) : rec.language,
          modifier: args.finish ? finishToModifier(args.finish) : rec.modifier,
        };
        const tags = Array.isArray(rec.tags) ? rec.tags.map((t) => (t && typeof t === 'object' ? t.id : t)).filter((t) => t != null) : [];
        await client.request('PATCH', `/collection/v2/${rid}/`, {
          auth: 'required',
          body: {
            game: rec.game ?? 1, id: rid, quantity: want.quantity, card: rec.card?.id, modifier: want.modifier,
            language: want.language, condition: want.condition, tags, purchasePrice: rec.purchasePrice ?? null,
          },
        });
        const name = rec.card?.oracleCard?.name;
        const after = (await findRecords(me.id, [rid], name)).get(rid);
        const ok = !!after && after.quantity === want.quantity && after.condition === want.condition && after.language === want.language && (after.modifier ?? 'Normal') === want.modifier;
        return {
          before: recordSummary(rec),
          after: after ? recordSummary(after) : null,
          verification: verification(ok, after ? 'valores relidos diferem' : 'registro não encontrado na releitura'),
        };
      },
    },
    {
      name: 'archidekt_collection_remove',
      description: 'REMOVE registros inteiros da coleção. Exige confirm: true — só depois de um "sim" explícito do usuário. Relê e confirma.',
      inputSchema: {
        type: 'object',
        properties: {
          recordIds: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 100 },
          confirm: { type: 'boolean', description: 'Precisa ser true.' },
        },
        required: ['recordIds', 'confirm'],
      },
      annotations: DESTRUCTIVE,
      handler: async ({ recordIds, confirm }) => {
        if (!Array.isArray(recordIds) || !recordIds.length) throw inputError('"recordIds" deve ser uma lista não vazia.');
        const ids = [...new Set(recordIds.map((x) => posInt(x, 'recordIds[]')))];
        if (confirm !== true) throw inputError('Remoção não confirmada. Mostre ao usuário o que será removido, peça um "sim" explícito e chame de novo com confirm: true.');
        const me = await client.me();
        const found = await findRecords(me.id, ids);
        const missing = ids.filter((i) => !found.has(i));
        if (missing.length) throw new ArchidektError('not_found', `Registros não encontrados (nada foi removido): ${missing.join(', ')}.`);
        await client.request('DELETE', '/collection/bulk/', { auth: 'required', body: { ids } });
        const names = [...new Set([...found.values()].map((r) => r.card?.oracleCard?.name).filter(Boolean))];
        const still = new Set();
        for (const n of names) for (const r of await ownedRecords(me.id, n)) if (found.has(r.id)) still.add(r.id);
        return {
          removed: [...found.values()].map(recordSummary),
          verification: verification(still.size === 0, still.size ? `ainda presentes: ${[...still].join(', ')}` : ''),
        };
      },
    },
  ];

  const shared = { client, getDeck, ownedRecords, applyDeckChanges };
  return [...archidektTools, ...buildInsightTools(shared), ...buildOptimizeTools(shared), ...buildMatchupTools(shared)];
}
