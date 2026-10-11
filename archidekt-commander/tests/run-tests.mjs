// End-to-end tests: spawns the MCP server against the local mock API and drives it over stdio.
// Run: node tests/run-tests.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, MOCK_USER } from './mock-server.mjs';
import { startExternalMock } from './mock-external.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', 'server', 'index.mjs');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${extra !== undefined ? `\n       ${String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 800)}` : ''}`);
  }
}

class McpProc {
  constructor(env) {
    this.proc = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.seq = 0;
    this.stderr = '';
    this.stdoutAll = '';
    this.badLines = [];
    this.msgs = [];
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      this.stdoutAll += d;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          this.badLines.push(line);
          continue;
        }
        this.msgs.push(msg);
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p(msg);
        }
      }
    });
    this.proc.stderr.on('data', (d) => (this.stderr += d));
  }
  rpc(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30000);
      this.pending.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  async call(name, args = {}) {
    const m = await this.rpc('tools/call', { name, arguments: args });
    if (m.error) return { rpcError: m.error, text: '', isError: true };
    const text = m.result.content.map((c) => c.text).join('\n');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* text output */
    }
    return { text, json, isError: !!m.result.isError };
  }
  async init() {
    const r = await this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    this.notify('notifications/initialized');
    return r;
  }
  close() {
    this.proc.stdin.end();
    return new Promise((r) => this.proc.on('exit', r));
  }
}

const ext = await startExternalMock(0);

function baseEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('ARCHIDEKT_') && !/^(SCRYFALL|LIGAMAGIC|EDHREC)_/.test(k)) env[k] = v;
  return { ...env, ARCHIDEKT_MIN_INTERVAL_MS: '0', ARCHIDEKT_NO_AUTO_CACHE: '1', ...ext.env, ...extra };
}

async function hook(base, name) {
  await fetch(`${base}/__test/${name}`, { method: 'POST' });
}

const mock = await startMock(0);
const { state, base } = mock;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'archidekt-test-home-'));
const logSince = (n) => state.log.slice(n);

// ======================= main run (env credentials) =======================
console.log('\n# Main run (env credentials)');
const s = new McpProc(baseEnv({ ARCHIDEKT_API_BASE: base, ARCHIDEKT_EMAIL: MOCK_USER.email, ARCHIDEKT_PASSWORD: MOCK_USER.password, HOME: tmpHome, USERPROFILE: tmpHome }));
const outputs = [];
const call = async (name, args) => {
  const r = await s.call(name, args);
  outputs.push(r.text);
  return r;
};

try {
  const init = await s.init();
  check('initialize echoes protocolVersion', init.result?.protocolVersion === '2025-03-26', init);
  check('initialize has tools capability + serverInfo', init.result?.capabilities?.tools && init.result?.serverInfo?.name === 'archidekt-commander');
  const ping = await s.rpc('ping');
  check('ping', ping.result && !ping.error);
  const list = await s.rpc('tools/list');
  const names = list.result.tools.map((t) => t.name);
  const expected = [
    'archidekt_whoami', 'archidekt_list_my_decks', 'archidekt_search_decks', 'archidekt_get_deck', 'archidekt_search_cards',
    'archidekt_get_collection', 'archidekt_search_collection', 'archidekt_validate_deck', 'archidekt_create_deck',
    'archidekt_update_deck_cards', 'archidekt_update_deck_info', 'archidekt_delete_deck', 'archidekt_collection_add',
    'archidekt_collection_update', 'archidekt_collection_remove',
    'cards_cache_update', 'cards_cache_status', 'card_translate', 'card_lookup', 'card_search_local', 'card_price_br',
    'deck_analyze', 'deck_cut_candidates', 'deck_upgrade_candidates',
    'wiki_list', 'wiki_read', 'wiki_write', 'wiki_search',
    'deck_triangulate', 'deck_optimize', 'deck_optimize_apply', 'deck_simulate',
  ];
  check('tools/list exposes all 32 tools (no snapshot tools)', expected.every((n) => names.includes(n)) && names.length === expected.length, names);
  check('tool names are unique', new Set(names).size === names.length);
  check('initialize reports version 0.7.0', init.result?.serverInfo?.version === '0.7.0', init.result?.serverInfo);
  check('every tool has an object inputSchema', list.result.tools.every((t) => t.inputSchema?.type === 'object'));
  // Structural JSON Schema check (draft 2020-12 subset used by MCP clients).
  const schemaErrors = [];
  const TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);
  const KEYS = new Set(['type', 'properties', 'required', 'items', 'enum', 'default', 'description', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'additionalProperties', 'oneOf', 'anyOf', 'pattern', 'title']);
  const okType = (v, t) => (t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' : t === 'array' ? Array.isArray(v) : t === 'object' ? v && typeof v === 'object' && !Array.isArray(v) : typeof v === t);
  const walkSchema = (sch, where) => {
    if (!sch || typeof sch !== 'object' || Array.isArray(sch)) return schemaErrors.push(`${where}: not an object`);
    for (const k of Object.keys(sch)) if (!KEYS.has(k)) schemaErrors.push(`${where}: unknown keyword ${k}`);
    const types = sch.type === undefined ? [] : [].concat(sch.type);
    if (sch.type !== undefined && !types.every((t) => TYPES.has(t))) schemaErrors.push(`${where}: bad type ${sch.type}`);
    if (sch.properties) for (const [k, v] of Object.entries(sch.properties)) walkSchema(v, `${where}.${k}`);
    if (sch.required && (!Array.isArray(sch.required) || sch.required.some((r) => !sch.properties || !(r in sch.properties)))) schemaErrors.push(`${where}: required not in properties`);
    if (types.includes('array') && sch.items) walkSchema(sch.items, `${where}[]`);
    if (sch.enum && (!Array.isArray(sch.enum) || !sch.enum.length)) schemaErrors.push(`${where}: empty enum`);
    if (sch.default !== undefined && types.length && !types.some((t) => okType(sch.default, t))) schemaErrors.push(`${where}: default type`);
    if (sch.default !== undefined && sch.enum && !sch.enum.includes(sch.default)) schemaErrors.push(`${where}: default not in enum`);
    if (sch.minimum !== undefined && sch.maximum !== undefined && sch.minimum > sch.maximum) schemaErrors.push(`${where}: min > max`);
    if (sch.default !== undefined && typeof sch.default === 'number' && ((sch.minimum !== undefined && sch.default < sch.minimum) || (sch.maximum !== undefined && sch.default > sch.maximum))) schemaErrors.push(`${where}: default out of range`);
  };
  for (const t of list.result.tools) {
    walkSchema(t.inputSchema, t.name);
    if (typeof t.description !== 'string' || !t.description.trim()) schemaErrors.push(`${t.name}: no description`);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) schemaErrors.push(`${t.name}: bad name`);
  }
  check('all tool inputSchemas are structurally valid JSON Schema', schemaErrors.length === 0, schemaErrors);
  const unk = await s.rpc('tools/call', { name: 'archidekt_nope', arguments: {} });
  check('unknown tool → JSON-RPC error', !!unk.error);
  const unkMethod = await s.rpc('foo/bar');
  check('unknown method → -32601', unkMethod.error?.code === -32601);

  // ---- protocol robustness ----
  const v2 = await s.rpc('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  check('initialize with unsupported version → server default', v2.result?.protocolVersion === '2025-06-18', v2);
  const before0 = s.msgs.length;
  s.proc.stdin.write('null\n42\n{"jsonrpc":"2.0","id":77}\n{"jsonrpc":"2.0","method":"ping"}\n');
  const pAfter = await s.rpc('ping');
  check('invalid messages do not crash the server', pAfter.result && s.proc.exitCode === null, s.stderr.slice(-500));
  const extra = s.msgs.slice(before0).filter((m) => m.id !== pAfter.id);
  check('invalid messages → -32600, notifications get no response', extra.length === 3 && extra.every((m) => m.error?.code === -32600) && extra.some((m) => m.id === 77), extra);
  const crlf = await new Promise((resolve) => {
    s.pending.set('crlf-1', resolve);
    s.proc.stdin.write('\uFEFF{"jsonrpc":"2.0","id":"crlf-1","method":"ping"}\r\n');
  });
  check('BOM + CRLF framed request accepted', crlf.result && !crlf.error, crlf);

  // ---- reads ----
  let r = await call('archidekt_whoami');
  check('whoami', r.json?.id === 42 && r.json?.username === 'thalis', r.text);

  r = await call('archidekt_list_my_decks', {});
  const ids = r.json?.decks?.map((d) => d.id) || [];
  check('list_my_decks includes private deck, excludes others', ids.includes(1001) && ids.includes(1002) && !ids.includes(2001), r.text);
  check('list_my_decks normalizes colors', r.json?.decks?.find((d) => d.id === 1001)?.colors === 'URG', r.text);

  r = await call('archidekt_search_decks', { commanderName: 'Atraxa' });
  check('search_decks by commander', r.json?.decks?.length === 1 && r.json.decks[0].id === 2001, r.text);
  r = await call('archidekt_search_decks', { ownerUsername: 'thalis' });
  check('search_decks by owner returns only public decks', r.json?.decks?.map((d) => d.id).join() === '1002', r.text);
  r = await call('archidekt_search_decks', {});
  check('search_decks without filters → error', r.isError, r.text);

  r = await call('archidekt_get_deck', { deckId: 1001 });
  check('get_deck renders commander + categories', r.text.includes('Comandante(s): Omnath, Locus of Rage') && r.text.includes('## Land') && /rel=\d+ card=\d+/.test(r.text), r.text);
  check('get_deck skips deleted rows', !r.text.includes('Lightning Bolt'), r.text);
  check('get_deck counts', r.text.includes('Cartas no deck: 46') && r.text.includes('Fora do deck (maybe/side): 1'), r.text);
  check('get_deck includes maybeboard by default', r.text.includes('Cultivate'));
  r = await call('archidekt_get_deck', { deckId: 1001, includeMaybeboard: false });
  check('get_deck includeMaybeboard=false', !r.text.includes('Cultivate'), r.text);
  r = await call('archidekt_get_deck', { deckId: 999999 });
  check('get_deck missing deck → error', r.isError && r.text.includes('404'), r.text);
  r = await call('archidekt_get_deck', {});
  check('get_deck missing deckId → error', r.isError, r.text);

  r = await call('archidekt_validate_deck', { deckId: 1001 });
  const v = r.json || {};
  const errs = (v.errors || []).join('\n');
  check('validate: invalid deck flagged', v.valid === false, r.text);
  check('validate: count error', errs.includes('46 cartas'), errs);
  check('validate: singleton Sol Ring', errs.includes('2x Sol Ring'), errs);
  check("validate: Dragon's Approach exempt from singleton", !errs.includes("Dragon's Approach"), errs);
  check('validate: color identity (Island)', /identidade de cor.*Island/.test(errs), errs);
  check('validate: banned Mana Crypt', /banned.*Mana Crypt/.test(errs), errs);
  check('validate: game changers counted', v.gameChangers?.count === 2, v.gameChangers);
  r = await call('archidekt_validate_deck', { deckId: 1002 });
  check('validate: legal 100-card deck passes', r.json?.valid === true && r.json?.cardCount === 100, r.text);

  r = await call('archidekt_search_cards', { name: 'Sol Ring' });
  check('search_cards substring', r.json?.count === 2 && r.json.cards[0].commanderLegal === 'legal', r.text);
  r = await call('archidekt_search_cards', { name: 'Valakut Awakening', exact: true });
  check('search_cards exact DFC front face fallback', r.json?.count === 1 && r.json.cards[0].name.startsWith('Valakut Awakening //'), r.text);
  r = await call('archidekt_search_cards', { name: 'Sol Ring', set: 'cmm' });
  check('search_cards by set', r.json?.count === 1 && r.json.cards[0].finishes.includes('Etched'), r.text);
  r = await call('archidekt_search_cards', { name: 'Totally Unknown Card Xyz' });
  check('search_cards unknown → empty', r.json?.count === 0, r.text);

  r = await call('archidekt_get_collection', {});
  check('get_collection', r.json?.records?.length === 4 && r.json.records[0].recordId === 9001, r.text);
  r = await call('archidekt_get_collection', { cardName: 'Sol' });
  check('get_collection filter', r.json?.records?.length === 2, r.text);
  r = await call('archidekt_search_collection', { cardNames: ['Sol Ring', 'Black Lotus'] });
  check('search_collection totals', r.json?.results?.[0]?.totalOwned === 3 && r.json.results[1].totalOwned === 0, r.text);

  // ---- 401 refresh / re-login ----
  let n = state.log.length;
  await hook(base, 'expire-access');
  r = await call('archidekt_get_collection', { pageSize: 1 });
  let lg = logSince(n).map((x) => x.path);
  check('401 → refresh → retry succeeds', !r.isError && lg.includes('/rest-auth/token/refresh/') && !lg.includes('/rest-auth/login/'), lg);
  n = state.log.length;
  await hook(base, 'expire-all');
  r = await call('archidekt_get_collection', { pageSize: 1 });
  lg = logSince(n).map((x) => x.path);
  check('401 + refresh rejected → re-login succeeds', !r.isError && lg.includes('/rest-auth/token/refresh/') && lg.includes('/rest-auth/login/'), lg);

  // ---- 429 on GET ----
  n = state.log.length;
  await hook(base, 'next429');
  r = await call('archidekt_search_cards', { name: 'Cultivate' });
  check('429 on GET honored and retried', !r.isError && logSince(n).filter((x) => x.path === '/cards/v2/').length === 2, r.text);

  // ---- create deck ----
  const before = state.decks.size;
  r = await call('archidekt_create_deck', { name: 'Teste Omnath', commander: 'Totally Unknown Card Xyz' });
  check('create_deck with unknown commander → error, no deck created', r.isError && state.decks.size === before, r.text);
  r = await call('archidekt_create_deck', { name: 'Teste Omnath', commander: 'omnath, locus of rage', description: 'oi' });
  check('create_deck + commander verified', r.json?.verification === 'verified' && r.json.commanders?.[0] === 'Omnath, Locus of Rage' && r.json.private === true, r.text);
  const newDeck = r.json?.deckId;
  const createBody = state.log.find((x) => x.method === 'POST' && x.path === '/decks/v2/')?.body;
  check('create_deck body: deckFormat 3, private true', createBody?.deckFormat === 3 && createBody?.private === true);

  // ---- update deck cards ----
  n = state.log.length;
  r = await call('archidekt_update_deck_cards', {
    deckId: 1001,
    changes: [
      { action: 'add', cardName: 'Rampant Growth', category: 'Ramp' },
      { action: 'set_quantity', cardName: 'Sol Ring', quantity: 1 },
      { action: 'move_category', cardName: 'Cultivate', category: 'Ramp' },
      { action: 'remove', cardName: 'Island' },
      { action: 'add', cardName: 'Forest', quantity: 2 },
      { action: 'remove', cardName: 'Forest', quantity: 1 },
      { action: 'add', cardName: 'Lightning Bolt', set: '2xm', finish: 'foil' },
    ],
  });
  const patches = logSince(n).filter((x) => x.method === 'PATCH' && x.path.includes('modifyCards'));
  check('update_deck_cards verified', r.json?.verification === 'verified' && r.json.applied.length === 7, r.text);
  check('one modifyCards request per change, each with one entry + hex patchId', patches.length === 7 && patches.every((p) => p.body.cards.length === 1 && /^[0-9a-f]{32}$/.test(p.body.cards[0].patchId)), patches.map((p) => p.body));
  check('diff lists changes', ['+ 1 Rampant Growth [Ramp]', '~ Sol Ring [Ramp] 2 → 1', '> Cultivate: Maybeboard → Ramp', '- 1 Island [Land]', '~ Forest [Land] 30 → 31'].every((l) => r.json?.diff?.includes(l)), r.json?.diff);
  check('foil modifier sent', patches[6]?.body.cards[0].modifications.modifier === 'Foil' && patches[6].body.cards[0].cardid === 901, patches[6]?.body);
  check('card count updated 46 → 48', r.json?.cardCountAfter === 48, r.json);
  check('7 changes → no snapshot on disk; undo list returned instead', !('snapshot' in (r.json || {})) && Array.isArray(r.json?.undo) && r.json.undo.some((u) => u.action === 'remove' && u.cardName === 'Rampant Growth') && r.json.undo.some((u) => u.action === 'add' && u.cardName === 'Island'), r.json?.undo);

  r = await call('archidekt_update_deck_cards', { deckId: 1001, changes: [{ action: 'add', cardName: 'Sol Ring' }] });
  check('add duplicate non-basic → stopped, nothing applied', r.json?.applied?.length === 0 && /já está no deck/.test(r.json?.stoppedAt?.error), r.text);
  r = await call('archidekt_update_deck_cards', { deckId: 1001, changes: [{ action: 'add', cardName: 'Sol Ring', category: 'Draw' }] });
  check('add duplicate non-basic into another included category → refused (singleton)', r.json?.applied?.length === 0 && /singleton/.test(r.json?.stoppedAt?.error), r.text);

  r = await call('archidekt_update_deck_cards', {
    deckId: 1001,
    changes: [
      { action: 'add', cardName: 'Counterspell', category: 'Maybeboard' },
      { action: 'add', cardName: 'Totally Unknown Card Xyz' },
      { action: 'remove', cardName: 'Mountain' },
    ],
  });
  check('unknown card → stops at first failure, reports applied', r.json?.applied?.length === 1 && r.json.stoppedAt?.index === 1 && r.json.notAttempted === 1 && /não encontrada/.test(r.json.stoppedAt.error) && r.json.verification === 'verified', r.text);

  n = state.log.length;
  await hook(base, 'fail-next-modify');
  r = await call('archidekt_update_deck_cards', { deckId: 1001, changes: [{ action: 'remove', cardName: 'Mountain' }] });
  check('500 on write → not retried, reported', r.json?.applied?.length === 0 && /HTTP 500/.test(r.json?.stoppedAt?.error) && logSince(n).filter((x) => x.path.includes('modifyCards')).length === 1, r.text);

  n = state.log.length;
  await hook(base, 'expire-access');
  r = await call('archidekt_update_deck_cards', { deckId: 1001, changes: [{ action: 'remove', cardName: 'Mana Crypt' }] });
  const mp = logSince(n).filter((x) => x.path.includes('modifyCards')).length;
  check('write after token expiry: refresh then one retry', r.json?.verification === 'verified' && r.json.applied.length === 1, r.text);
  check('write 401 retried exactly once', mp <= 2, mp);

  r = await call('archidekt_update_deck_cards', { deckId: 2001, changes: [{ action: 'remove', cardName: 'Forest' }] });
  check("editing someone else's deck → 403 reported", /HTTP 403/.test(r.json?.stoppedAt?.error || ''), r.text);
  r = await call('archidekt_update_deck_cards', { deckId: 1001, changes: [{ action: 'explode', cardName: 'Forest' }] });
  check('unknown action → stopped', /Ação desconhecida/.test(r.json?.stoppedAt?.error || ''), r.text);

  // ---- deck info ----
  r = await call('archidekt_update_deck_info', { deckId: 1001, name: 'Omnath Renomeado', edhBracket: 4, description: 'Nova descrição', private: false });
  check('update_deck_info verified', r.json?.verification === 'verified' && r.json.now.name === 'Omnath Renomeado' && r.json.now.description === 'Nova descrição', r.text);
  r = await call('archidekt_update_deck_info', { deckId: 1001 });
  check('update_deck_info with nothing → error', r.isError, r.text);

  // ---- delete deck ----
  n = state.log.length;
  r = await call('archidekt_delete_deck', { deckId: newDeck });
  check('delete_deck without confirm → refused, no DELETE sent', r.isError && /confirm/.test(r.text) && !logSince(n).some((x) => x.method === 'DELETE'), r.text);
  r = await call('archidekt_delete_deck', { deckId: newDeck, confirm: 'yes' });
  check('delete_deck confirm must be boolean true', r.isError, r.text);
  r = await call('archidekt_delete_deck', { deckId: newDeck, confirm: true });
  check('delete_deck verified', r.json?.verification === 'verified' && r.json.deleted.name === 'Teste Omnath', r.text);

  // ---- collection writes ----
  r = await call('archidekt_collection_add', { cardName: 'Lightning Bolt', quantity: 3, set: 'm10', finish: 'foil' });
  check('collection_add verified', r.json?.verification === 'verified' && r.json.totalOwnedAfter === 3 && r.json.added.set === 'm10', r.text);
  const addBody = state.log.filter((x) => x.method === 'POST' && x.path === '/collection/v2/').at(-1)?.body;
  check('collection_add body', addBody?.game === 1 && addBody.card === 902 && addBody.modifier === 'Foil' && addBody.condition === 1 && addBody.language === 1, addBody);
  r = await call('archidekt_collection_add', { cardName: 'Lightning Bolt', quantity: 1, condition: 'HP', language: 'pt-br' });
  const addBody2 = state.log.filter((x) => x.method === 'POST' && x.path === '/collection/v2/').at(-1)?.body;
  check('collection_add maps HP→4 and pt-br→8', r.json?.verification === 'verified' && addBody2?.condition === 4 && addBody2?.language === 8, r.text);
  r = await call('archidekt_collection_add', { cardName: 'Lightning Bolt', quantity: 1, condition: 'Mint' });
  const addBody3 = state.log.filter((x) => x.method === 'POST' && x.path === '/collection/v2/').at(-1)?.body;
  check('collection_add maps Mint→NM (1)', addBody3?.condition === 1, addBody3);
  r = await call('archidekt_collection_add', { cardName: 'Lightning Bolt', quantity: 1, condition: 'XX' });
  check('collection_add bad condition → error, no POST', r.isError && /condition/.test(r.text), r.text);
  r = await call('archidekt_collection_add', { cardName: 'Lightning Bolt', quantity: 1, language: 'klingon' });
  check('collection_add bad language → error', r.isError && /language/.test(r.text), r.text);
  r = await call('archidekt_collection_add', { cardName: 'Totally Unknown Card Xyz', quantity: 1 });
  check('collection_add unknown card → error', r.isError && /não encontrada/.test(r.text), r.text);
  r = await call('archidekt_collection_add', { quantity: 1 });
  check('collection_add without card → error', r.isError, r.text);

  r = await call('archidekt_collection_update', { recordId: 9001, quantity: 5, condition: 'LP' });
  check('collection_update verified', r.json?.verification === 'verified' && r.json.after.qty === 5 && r.json.after.condition === 'LP', r.text);
  const upd = state.log.filter((x) => x.method === 'PATCH' && x.path === '/collection/v2/9001/').at(-1)?.body;
  check('collection_update sends integer codes', upd && upd.condition === 2 && upd.language === 1, upd);
  r = await call('archidekt_collection_update', { recordId: 9001, language: 'PT' });
  check('collection_update language PT → 8, shown as PT', r.json?.verification === 'verified' && r.json.after.language === 'PT', r.text);
  check('collection_update sends full record', upd && ['game', 'id', 'quantity', 'card', 'modifier', 'language', 'condition', 'tags', 'purchasePrice'].every((k) => k in upd), upd);
  r = await call('archidekt_collection_update', { recordId: 123456, quantity: 1 });
  check('collection_update missing record → error', r.isError, r.text);

  n = state.log.length;
  r = await call('archidekt_collection_remove', { recordIds: [9004] });
  check('collection_remove without confirm → refused', r.isError && !logSince(n).some((x) => x.method === 'DELETE'), r.text);
  r = await call('archidekt_collection_remove', { recordIds: [9004, 123456], confirm: true });
  check('collection_remove with unknown id → nothing removed', r.isError && state.collection.has(9004), r.text);
  r = await call('archidekt_collection_remove', { recordIds: [9004], confirm: true });
  check('collection_remove verified', r.json?.verification === 'verified' && !state.collection.has(9004), r.text);

  // ---- hygiene ----
  check('every request uses honest User-Agent', state.log.every((x) => x.ua === 'archidekt-commander-mcp/0.7'));
  check('auth header scheme is JWT', state.log.filter((x) => x.auth).every((x) => x.auth === 'JWT'));
  check('password never in tool output', outputs.every((t) => !t.includes(MOCK_USER.password)));
  check('password/token never in stderr', !s.stderr.includes(MOCK_USER.password) && !/eyJ[A-Za-z0-9_-]{10,}/.test(s.stderr), s.stderr);
  check('stdout carries only JSON-RPC lines', s.badLines.length === 0, s.badLines);
} catch (e) {
  check('main run crashed', false, e.stack);
} finally {
  await s.close();
}

// ======================= no credentials =======================
console.log('\n# No credentials');
const anon = new McpProc(baseEnv({ ARCHIDEKT_API_BASE: base, HOME: tmpHome, USERPROFILE: tmpHome }));
try {
  await anon.init();
  let r = await anon.call('archidekt_whoami');
  check('whoami explains how to configure', r.isError && r.text.includes('credentials.json') && r.text.includes('ARCHIDEKT_EMAIL'), r.text);
  r = await anon.call('archidekt_list_my_decks', {});
  check('list_my_decks needs credentials', r.isError && r.text.includes('credentials.json'), r.text);
  r = await anon.call('archidekt_search_cards', { name: 'Sol Ring' });
  check('public search_cards works anonymously', r.json?.count === 2, r.text);
  r = await anon.call('archidekt_get_deck', { deckId: 1002 });
  check('public deck readable anonymously', r.text.includes('Omnath Legal 100'), r.text);
  r = await anon.call('archidekt_get_deck', { deckId: 2001 });
  check('other public deck readable', r.text.includes('Atraxa'), r.text);
  r = await anon.call('archidekt_update_deck_cards', { deckId: 1002, changes: [{ action: 'remove', cardName: 'Forest' }] });
  check('write without credentials → config message', r.isError && r.text.includes('credentials.json'), r.text);
} catch (e) {
  check('anon run crashed', false, e.stack);
} finally {
  await anon.close();
}

// ======================= credentials file (username + BOM) =======================
console.log('\n# Credentials file');
const credFile = path.join(tmpHome, 'creds-test.json');
fs.writeFileSync(credFile, '﻿' + JSON.stringify({ username: MOCK_USER.username, password: MOCK_USER.password }));
const fileRun = new McpProc(baseEnv({ ARCHIDEKT_API_BASE: base, ARCHIDEKT_CREDENTIALS_FILE: credFile, HOME: tmpHome, USERPROFILE: tmpHome }));
try {
  await fileRun.init();
  const n = state.log.length;
  const r = await fileRun.call('archidekt_whoami');
  const loginBody = logSince(n).find((x) => x.path === '/rest-auth/login/')?.body;
  check('credentials file with username + BOM', r.json?.username === 'thalis' && loginBody?.username === 'thalis' && !('email' in loginBody), r.text);
} finally {
  await fileRun.close();
}

// default location ~/.archidekt/credentials.json with a wrong password
fs.mkdirSync(path.join(tmpHome, '.archidekt'), { recursive: true });
fs.writeFileSync(path.join(tmpHome, '.archidekt', 'credentials.json'), JSON.stringify({ email: MOCK_USER.email, password: 'wrong-pass-zzz' }));
const badRun = new McpProc(baseEnv({ ARCHIDEKT_API_BASE: base, HOME: tmpHome, USERPROFILE: tmpHome }));
try {
  await badRun.init();
  const r = await badRun.call('archidekt_whoami');
  check('default ~/.archidekt file found; wrong password → clear error', r.isError && /Login no Archidekt falhou/.test(r.text) && !r.text.includes('wrong-pass-zzz'), r.text);
  check('wrong password not in stderr', !badRun.stderr.includes('wrong-pass-zzz'), badRun.stderr);
} finally {
  await badRun.close();
}

// MCPB extension: credentials from user_config env, optional fields left as "${user_config.x}" placeholders
{
  const extRun = new McpProc(baseEnv({ ARCHIDEKT_API_BASE: base, HOME: tmpHome, USERPROFILE: tmpHome,
    ARCHIDEKT_EMAIL: MOCK_USER.email, ARCHIDEKT_PASSWORD: MOCK_USER.password, ARCHIDEKT_HOME: '${user_config.data_dir}' }));
  try {
    await extRun.init();
    const r = await extRun.call('archidekt_whoami');
    check('MCPB env credentials work; placeholder ARCHIDEKT_HOME ignored', r.json?.username === 'thalis' && /environment/.test(r.json?.credentialsSource || ''), r.text);
    check('placeholder data dir not used', !extRun.stderr.includes('user_config'), extRun.stderr);
  } finally {
    await extRun.close();
  }
  const phRun = new McpProc(baseEnv({ ARCHIDEKT_API_BASE: base, HOME: tmpHome, USERPROFILE: tmpHome,
    ARCHIDEKT_EMAIL: '${user_config.email}', ARCHIDEKT_PASSWORD: '${user_config.password}' }));
  try {
    await phRun.init();
    const r = await phRun.call('archidekt_whoami');
    check('unreplaced placeholder credentials ignored → falls back to file', r.isError && /Login no Archidekt falhou/.test(r.text), r.text);
  } finally {
    await phRun.close();
  }
}

// ======================= stdin close with in-flight call =======================
console.log('\n# Graceful shutdown');
{
  const g = new McpProc(baseEnv({ ARCHIDEKT_API_BASE: base, HOME: tmpHome, USERPROFILE: tmpHome }));
  await g.init();
  const pending = g.call('archidekt_search_cards', { name: 'Sol Ring' }).catch((e) => ({ err: e.message }));
  g.proc.stdin.end();
  const r = await Promise.race([pending, new Promise((res) => setTimeout(() => res({ err: 'no response' }), 10000))]);
  check('in-flight tool call answered after stdin closes', r.json?.count === 2, r);
  await new Promise((res) => (g.proc.exitCode !== null ? res() : g.proc.on('exit', res)));
  check('server exits after draining', g.proc.exitCode === 0, g.proc.exitCode);
}

// ======================= Commander rules (pure) =======================
console.log('\n# Commander rules');
{
  const { parseDeck, validateCommander } = await import('../server/commander.mjs');
  let rel = 1;
  const card = (name, o = {}) => ({
    name, cmc: 0, colorIdentity: o.ci ?? [], types: o.types ?? [], subTypes: o.sub ?? [], superTypes: o.sup ?? [],
    text: o.text ?? '', legalities: { commander: o.legal ?? 'legal' }, gameChanger: false,
  });
  const row = (oc, qty, cats, extra = {}) => ({ id: rel++, quantity: qty, categories: cats, modifier: 'Normal', companion: false, deletedAt: null, card: { id: rel, oracleCard: oc }, ...extra });
  const deck = (cards, extraCats = []) => ({
    id: 1, name: 't', deckFormat: 3, categories: [
      { name: 'Commander', isPremier: true, includedInDeck: true }, { name: 'Land', isPremier: false, includedInDeck: true },
      { name: 'Maybeboard', isPremier: false, includedInDeck: false }, { name: 'Sideboard', isPremier: false, includedInDeck: false }, ...extraCats,
    ], cards,
  });
  const legCreature = (name, ci, text = '', sub = []) => card(name, { ci, types: ['Creature'], sup: ['Legendary'], text, sub });
  const forest = card('Forest', { ci: ['Green'], types: ['Land'], sup: ['Basic'] });
  const snowForest = card('Snow-Covered Forest', { ci: ['Green'], types: ['Land'], sup: ['Basic', 'Snow'] });
  const wastes = card('Wastes', { types: ['Land'], sup: ['Basic'] });
  const v = (cards, cats) => validateCommander(parseDeck(deck(cards, cats)));

  const g = legCreature('Gruul Guy', ['Red', 'Green']);
  let res = v([row(g, 1, ['Commander']), row(forest, 50, ['Land']), row(snowForest, 30, ['Land']), row(wastes, 19, ['Land'])]);
  check('snow basics + Wastes exempt from singleton; 100 valid', res.valid && res.cardCount === 100, res);

  res = v([row(g, 1, ['Commander']), row(forest, 98, ['Land']), row(card('Sol Ring', { types: ['Artifact'] }), 1, ['Maybeboard', 'Land'])]);
  check('first category decides inclusion (Maybeboard first → not counted)', res.cardCount === 99, res);

  const lurrus = card('Lurrus of the Dream-Den', { ci: ['White', 'Black'], types: ['Creature'], sup: ['Legendary'], text: 'Companion — Each permanent card in your starting deck has mana value 2 or less.' });
  res = v([row(g, 1, ['Commander']), row(forest, 99, ['Land']), row(lurrus, 1, ['Land'], { companion: true })]);
  check('companion not counted toward 100', res.cardCount === 100, res);
  check('companion outside commander identity → error', !res.valid && res.errors.some((e) => /identidade.*Lurrus/.test(e)), res.errors);

  const tymna = legCreature('Tymna the Weaver', ['White', 'Black'], 'Lifelink\nPartner (You can have two commanders if both have partner.)');
  const thrasios = legCreature('Thrasios, Triton Hero', ['Green', 'Blue'], '{4}: Scry 1.\nPartner (You can have two commanders if both have partner.)');
  const plains = card('Plains', { ci: ['White'], types: ['Land'], sup: ['Basic'] });
  res = v([row(tymna, 1, ['Commander']), row(thrasios, 1, ['Commander']), row(plains, 98, ['Land'])]);
  check('Partner + Partner valid; identity is union', res.valid && res.colorIdentity === 'WUBG', res);

  const pw1 = legCreature('Pir, Imaginative Rascal', ['Green'], 'Partner with Toothy, Imaginary Friend (When this creature enters...)');
  const pw2 = legCreature('Toothy, Imaginary Friend', ['Blue'], 'Partner with Pir, Imaginative Rascal (When this creature enters...)');
  res = v([row(pw1, 1, ['Commander']), row(pw2, 1, ['Commander']), row(forest, 98, ['Land'])]);
  check('Partner with (named pair) valid', res.valid, res);
  res = v([row(pw1, 1, ['Commander']), row(thrasios, 1, ['Commander']), row(forest, 98, ['Land'])]);
  check('Partner with X + generic Partner → error', !res.valid && res.errors.some((e) => /dupla/.test(e)), res.errors);

  const chooser = legCreature('Wilson, Refined Grizzly', ['Green'], 'Choose a Background (You can have a Background as a second commander.)');
  const bg = card('Raised by Giants', { ci: ['Green'], types: ['Enchantment'], sup: ['Legendary'], sub: ['Background'] });
  res = v([row(chooser, 1, ['Commander']), row(bg, 1, ['Commander']), row(forest, 98, ['Land'])]);
  check('Choose a Background + Background valid', res.valid, res);
  res = v([row(bg, 1, ['Commander']), row(forest, 99, ['Land'])]);
  check('lone Background commander → error', !res.valid && res.errors.some((e) => /Background/.test(e)), res.errors);
  res = v([row(g, 1, ['Commander']), row(legCreature('Other Guy', ['Green']), 1, ['Commander']), row(forest, 98, ['Land'])]);
  check('two commanders without partner → error', !res.valid && res.errors.some((e) => /dupla/.test(e)), res.errors);
  const doc = legCreature('The Tenth Doctor', ['Red'], 'Allons-y!', ['Time Lord', 'Doctor']);
  const comp = legCreature('Rose Tyler', ['Green'], "Doctor's companion (You can have two commanders if the other is the Doctor.)", ['Human']);
  res = v([row(doc, 1, ['Commander']), row(comp, 1, ['Commander']), row(forest, 98, ['Land'])]);
  check("Doctor's companion + Time Lord Doctor valid", res.valid, res);
}

// ======================= rate limiter (in-process) =======================
console.log('\n# Rate limiter');
{
  const { ArchidektClient } = await import('../server/client.mjs');
  const c = new ArchidektClient({ base, minIntervalMs: 300, credentials: null });
  const t0 = Date.now();
  await Promise.all([1, 2, 3].map(() => c.request('GET', '/cards/v2/', { auth: 'none', params: { name: 'Forest' } })));
  const dt = Date.now() - t0;
  check('concurrent requests are serialized and spaced (3 req ≥ 600 ms)', dt >= 590, dt);
  const d = new ArchidektClient({ credentials: null });
  check('default interval is 1500 ms when env unset', (process.env.ARCHIDEKT_MIN_INTERVAL_MS ? true : d.minIntervalMs === 1500), d.minIntervalMs);
}

// ======================= Phase 2 (cache, prices, analysis, wiki) =======================
{
  const { runPhase2 } = await import('./phase2-tests.mjs');
  try {
    await runPhase2({ McpProc, baseEnv, check, ext, mockState: state, archBase: base, MOCK_USER });
    const { runReviewFixes } = await import('./phase2-tests.mjs');
    await runReviewFixes({ McpProc, baseEnv, check, ext, archBase: base, MOCK_USER });
  } catch (e) {
    check('phase 2 crashed', false, e.stack);
  }
}

// ======================= Phase 3 (triangulation, optimizer, simulation) =======================
{
  const { runPhase3 } = await import('./phase3-tests.mjs');
  try {
    await runPhase3({ McpProc, baseEnv, check, ext, mockState: state, archBase: base, MOCK_USER });
  } catch (e) {
    check('phase 3 crashed', false, e.stack);
  }
}

// ======================= v0.5 (LigaMagic card links) =======================
{
  const liga = await import('../server/ligamagic.mjs');
  const u = liga.cardUrl("Urza's Saga");
  check('cardUrl encodes apostrophe (Markdown-safe)', /card=Urza%27s%20Saga$/.test(u) && !/[()' ]/.test(u.split('card=')[1]), u);
  check('cardUrl uses front face of split/DFC', /card=Fire$/.test(liga.cardUrl('Fire // Ice')), liga.cardUrl('Fire // Ice'));
  check('cardUrl empty → null', liga.cardUrl('') === null);
}

fs.rmSync(tmpHome, { recursive: true, force: true });
await mock.close();
await ext.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
