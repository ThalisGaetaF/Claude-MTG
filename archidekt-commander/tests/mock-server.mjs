// In-memory mock of the (unofficial) Archidekt API shapes described in API_SPEC.md.
// Usage: node tests/mock-server.mjs [port]   or   import { startMock } from './mock-server.mjs'

import http from 'node:http';
import crypto from 'node:crypto';

export const MOCK_USER = { id: 42, username: 'thalis', email: 'test@example.com', password: 'fake-password-123' };

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeJwt(userId, ttlSeconds = 3600) {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ user_id: userId, exp: Math.floor(Date.now() / 1000) + ttlSeconds, jti: crypto.randomUUID() })}.sig`;
}

function oracle(name, o = {}) {
  return {
    name,
    cmc: o.cmc ?? 0,
    manaCost: o.manaCost ?? '',
    colors: o.ci ?? [],
    colorIdentity: o.ci ?? [],
    types: o.types ?? [],
    subTypes: o.subTypes ?? [],
    superTypes: o.superTypes ?? [],
    text: o.text ?? '',
    faces: o.faces ?? [],
    legalities: { commander: o.legal ?? 'legal' },
    edhrecRank: o.rank ?? 1,
    salt: o.salt ?? 0,
    gameChanger: !!o.gc,
    defaultCategory: o.cat ?? null,
    oTags: o.oTags ?? [],
    twoCardComboIds: o.combos ?? [],
    keywords: o.kw ?? [],
  };
}

function buildCards() {
  const o = {
    omnath: oracle('Omnath, Locus of Rage', { cmc: 5, manaCost: '{3}{R}{R}{G}{G}', ci: ['Red', 'Green'], types: ['Creature'], superTypes: ['Legendary'], subTypes: ['Elemental'], text: 'Landfall — Whenever a land enters the battlefield under your control, create a 5/5 red and green Elemental creature token.' }),
    solring: oracle('Sol Ring', { cmc: 1, manaCost: '{1}', types: ['Artifact'], text: '{T}: Add {C}{C}.', cat: 'Ramp' }),
    forest: oracle('Forest', { types: ['Land'], superTypes: ['Basic'], subTypes: ['Forest'], ci: ['Green'], cat: 'Land' }),
    mountain: oracle('Mountain', { types: ['Land'], superTypes: ['Basic'], subTypes: ['Mountain'], ci: ['Red'], cat: 'Land' }),
    island: oracle('Island', { types: ['Land'], superTypes: ['Basic'], subTypes: ['Island'], ci: ['Blue'], cat: 'Land' }),
    approach: oracle("Dragon's Approach", { cmc: 3, manaCost: '{2}{R}', ci: ['Red'], types: ['Sorcery'], text: "Dragon's Approach deals 3 damage to each opponent. A deck can have any number of cards named Dragon's Approach.", cat: 'Removal' }),
    crypt: oracle('Mana Crypt', { cmc: 0, manaCost: '{0}', types: ['Artifact'], legal: 'banned', gc: true, cat: 'Ramp' }),
    ring: oracle('The One Ring', { cmc: 4, manaCost: '{4}', types: ['Artifact'], superTypes: ['Legendary'], gc: true, cat: 'Draw' }),
    valakut: oracle('Valakut Awakening // Valakut Stoneforge', { cmc: 3, ci: ['Red'], types: ['Instant'], faces: [{ name: 'Valakut Awakening', text: 'Put any number of cards from your hand on the bottom of your library, then draw that many cards plus one.' }, { name: 'Valakut Stoneforge', text: '{T}: Add {R}.' }], cat: 'Draw' }),
    rampant: oracle('Rampant Growth', { cmc: 2, manaCost: '{1}{G}', ci: ['Green'], types: ['Sorcery'], cat: 'Ramp' }),
    cultivate: oracle('Cultivate', { cmc: 3, manaCost: '{2}{G}', ci: ['Green'], types: ['Sorcery'], cat: 'Ramp' }),
    bolt: oracle('Lightning Bolt', { cmc: 1, manaCost: '{R}', ci: ['Red'], types: ['Instant'], cat: 'Removal' }),
    counterspell: oracle('Counterspell', { cmc: 2, manaCost: '{U}{U}', ci: ['Blue'], types: ['Instant'] }),
    atraxa: oracle("Atraxa, Praetors' Voice", { cmc: 4, ci: ['White', 'Blue', 'Black', 'Green'], types: ['Creature'], superTypes: ['Legendary'], subTypes: ['Phyrexian', 'Angel', 'Horror'] }),
    cobra: oracle('Lotus Cobra', { cmc: 2, manaCost: '{1}{G}', ci: ['Green'], types: ['Creature'], subTypes: ['Snake'], text: 'Landfall — Whenever a land you control enters, add one mana of any color.', oTags: ['Ramp', 'Landfall'], cat: 'Ramp', kw: ['Landfall'] }),
    beast: oracle('Beast Within', { cmc: 3, manaCost: '{2}{G}', ci: ['Green'], types: ['Instant'], text: 'Destroy target permanent. Its controller creates a 3/3 green Beast creature token.', oTags: ['Removal'], cat: 'Removal', combos: ['combo-test-1'] }),
    act: oracle('Blasphemous Act', { cmc: 9, manaCost: '{8}{R}', ci: ['Red'], types: ['Sorcery'], text: 'This spell costs {1} less to cast for each creature on the battlefield.\nBlasphemous Act deals 13 damage to each creature.', oTags: ['Board Wipe'], cat: 'Removal', salt: 1.2 }),
    witness: oracle('Eternal Witness', { cmc: 3, manaCost: '{1}{G}{G}', ci: ['Green'], types: ['Creature'], subTypes: ['Human', 'Shaman'], text: 'When this creature enters, return target card from your graveyard to your hand.', oTags: ['Recursion'], combos: ['combo-test-1'] }),
    dreadmaw: oracle('Colossal Dreadmaw', { cmc: 6, manaCost: '{4}{G}{G}', ci: ['Green'], types: ['Creature'], subTypes: ['Dinosaur'], text: 'Trample', kw: ['Trample'], rank: 15000 }),
    temple: oracle('Temple of Abandon', { ci: ['Red', 'Green'], types: ['Land'], text: 'This land enters tapped.\nWhen this land enters, scry 1.\n{T}: Add {R} or {G}.', cat: 'Land' }),
    ooze: oracle('Scavenging Ooze', { cmc: 2, manaCost: '{1}{G}', ci: ['Green'], types: ['Creature'], subTypes: ['Ooze'], text: '{G}: Exile target card from a graveyard. If it was a creature card, put a +1/+1 counter on this creature and you gain 1 life.' }),
    avenger: oracle('Avenger of Zendikar', { cmc: 7, manaCost: '{5}{G}{G}', ci: ['Green'], types: ['Creature'], subTypes: ['Elemental'], text: 'When this creature enters, create a 0/1 green Plant creature token for each land you control.' }),
    heroic: oracle('Heroic Intervention', { cmc: 2, manaCost: '{1}{G}', ci: ['Green'], types: ['Instant'], text: 'Permanents you control gain hexproof and indestructible until end of turn.' }),
    relic: oracle('Relic of Progenitus', { cmc: 1, manaCost: '{1}', types: ['Artifact'], text: '{T}: Target player exiles a card from their graveyard.' }),
    kodama: oracle("Kodama's Reach", { cmc: 3, manaCost: '{2}{G}', ci: ['Green'], types: ['Sorcery'], subTypes: ['Arcane'], text: 'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.', cat: 'Ramp' }),
  };
  const p = (id, key, set, number, options = ['Normal', 'Foil']) => ({
    id, uid: crypto.randomUUID(), collectorNumber: number, rarity: 'common', prices: { tcg: 1.0 }, options,
    edition: { editioncode: set, editionname: set.toUpperCase() }, oracleCard: o[key],
  });
  return [
    p(101, 'omnath', 'c13', '198'),
    p(201, 'solring', 'c21', '263'),
    p(202, 'solring', 'cmm', '400', ['Normal', 'Foil', 'Etched']),
    p(301, 'forest', 'blb', '280', ['Normal']),
    p(302, 'mountain', 'blb', '278', ['Normal']),
    p(303, 'island', 'blb', '274', ['Normal']),
    p(401, 'approach', 'stx', '130'),
    p(501, 'crypt', '2xm', '270'),
    p(601, 'ring', 'ltr', '246'),
    p(701, 'valakut', 'znr', '174'),
    p(801, 'rampant', 'c21', '200'),
    p(802, 'cultivate', 'c21', '201'),
    p(901, 'bolt', '2xm', '117'),
    p(902, 'bolt', 'm10', '146'),
    p(1001, 'counterspell', 'mh2', '267'),
    p(1101, 'atraxa', 'c16', '28'),
    p(1201, 'cobra', 'zen', '167'),
    p(1202, 'beast', 'm12', '190'),
    p(1203, 'act', 'c13', '144'),
    p(1204, 'witness', 'c21', '211'),
    p(1205, 'dreadmaw', 'm19', '176'),
    p(1206, 'temple', 'ths', '224', ['Normal']),
    p(1207, 'kodama', 'c21', '206'),
    p(1208, 'ooze', 'm12', '197'),
    p(1209, 'avenger', 'zen', '159'),
    p(1210, 'heroic', 'aer', '109'),
    p(1211, 'relic', 'a25', '226'),
  ];
}

export function createState() {
  const cards = buildCards();
  const byId = new Map(cards.map((c) => [c.id, c]));
  let relSeq = 5000;
  const row = (cardid, quantity, categories, extra = {}) => ({
    id: ++relSeq, quantity, categories, modifier: 'Normal', label: '', notes: '', companion: false, flippedDefault: false, deletedAt: null,
    card: { ...byId.get(cardid), owned: 0 },
    ...extra,
  });
  const cats = (...names) => names.map((n) => ({ name: n, isPremier: n === 'Commander', includedInDeck: n !== 'Maybeboard' }));
  const owner = { id: MOCK_USER.id, username: MOCK_USER.username };
  const quill = (t) => JSON.stringify({ ops: [{ insert: `${t}\n` }] });
  const decks = new Map();
  decks.set(1001, {
    id: 1001, name: 'Omnath Landfall', description: quill('Landfall test deck'), deckFormat: 3, edhBracket: 3, private: true, unlisted: false,
    owner, deckTags: [], updatedAt: '2026-10-01T10:00:00Z', createdAt: '2026-01-01T10:00:00Z', viewCount: 3,
    categories: cats('Commander', 'Land', 'Ramp', 'Removal', 'Draw', 'Maybeboard'),
    cards: [
      row(101, 1, ['Commander']),
      row(301, 30, ['Land']),
      row(302, 5, ['Land']),
      row(303, 1, ['Land']),
      row(202, 2, ['Ramp']),
      row(501, 1, ['Ramp']),
      row(601, 1, ['Draw']),
      row(401, 4, ['Removal']),
      row(701, 1, ['Draw']),
      row(802, 1, ['Maybeboard']),
      row(901, 1, ['Removal'], { deletedAt: '2026-09-01T00:00:00Z' }),
    ],
  });
  decks.set(1002, {
    id: 1002, name: 'Omnath Legal 100', description: '', deckFormat: 3, edhBracket: 2, private: false, unlisted: false,
    owner, deckTags: [], updatedAt: '2026-09-20T10:00:00Z', createdAt: '2026-01-02T10:00:00Z', viewCount: 1,
    categories: cats('Commander', 'Land', 'Removal'),
    cards: [row(101, 1, ['Commander']), row(301, 40, ['Land']), row(302, 30, ['Land']), row(401, 29, ['Removal'])],
  });
  decks.set(2001, {
    id: 2001, name: 'Atraxa Superfriends', description: '', deckFormat: 3, edhBracket: 4, private: false, unlisted: false,
    owner: { id: 77, username: 'someone' }, deckTags: [], updatedAt: '2026-08-01T10:00:00Z', createdAt: '2026-01-03T10:00:00Z', viewCount: 99,
    categories: cats('Commander', 'Land'),
    cards: [row(1101, 1, ['Commander']), row(301, 10, ['Land'])],
  });
  decks.set(1003, {
    id: 1003, name: 'Omnath Analise', description: '', deckFormat: 3, edhBracket: 2, private: true, unlisted: false,
    owner, deckTags: [], updatedAt: '2026-09-25T10:00:00Z', createdAt: '2026-01-04T10:00:00Z', viewCount: 0,
    categories: cats('Commander', 'Land', 'Ramp', 'Removal', 'Draw', 'Creatures', 'Maybeboard'),
    cards: [
      row(101, 1, ['Commander']), row(301, 30, ['Land']), row(302, 5, ['Land']), row(1206, 1, ['Land']),
      row(201, 1, ['Ramp']), row(801, 1, ['Ramp']), row(802, 1, ['Ramp']), row(1201, 1, ['Ramp']),
      row(1202, 1, ['Removal']), row(1203, 1, ['Removal']), row(1204, 1, ['Creatures']), row(1205, 1, ['Creatures']),
      row(601, 1, ['Draw']), row(701, 1, ['Draw']),
    ],
  });
  const rec = (id, cardid, quantity, modifier = 'Normal') => ({
    id, quantity, modifier, language: 1, condition: 1, tags: [], purchasePrice: 0, createdAt: '2026-01-01T00:00:00Z', game: 1,
    card: byId.get(cardid),
  });
  const collection = new Map([
    [9001, rec(9001, 201, 2)],
    [9002, rec(9002, 202, 1, 'Foil')],
    [9003, rec(9003, 301, 10)],
    [9004, rec(9004, 802, 1)],
  ]);
  return {
    cards, byId, decks, collection, row,
    nextDeckId: 3000, nextRecordId: 9100,
    access: new Set(), refresh: new Set(),
    log: [],
    flags: { next429: false, failNextModify: false },
    quill,
  };
}

function send(res, status, body, headers = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(text);
}

function colorsOf(deck) {
  const out = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const map = { White: 'W', Blue: 'U', Black: 'B', Red: 'R', Green: 'G' };
  for (const r of deck.cards) if (!r.deletedAt) for (const c of r.card.oracleCard.colors) out[map[c]] += r.quantity;
  return out;
}

function deckListRow(d) {
  return {
    id: d.id, name: d.name, deckFormat: d.deckFormat, updatedAt: d.updatedAt, createdAt: d.createdAt, private: d.private, unlisted: d.unlisted,
    parentFolderName: 'Home', colors: colorsOf(d), size: d.cards.filter((r) => !r.deletedAt).reduce((s, r) => s + r.quantity, 0),
    edhBracket: d.edhBracket, tags: [], viewCount: d.viewCount, featured: '', owner: d.owner,
  };
}

function paginate(list, page, pageSize) {
  const start = (page - 1) * pageSize;
  const results = list.slice(start, start + pageSize);
  const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
  return { count: list.length, results, page, totalPages, next: page < totalPages ? `page=${page + 1}` : null, previous: page > 1 ? `page=${page - 1}` : null };
}

export function createMockServer(state = createState()) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { detail: 'bad json' });
      }
    }
    const p = url.pathname.replace(/^\/api/, '');
    const q = url.searchParams;
    const authz = req.headers.authorization || '';
    const token = authz.startsWith('JWT ') ? authz.slice(4) : null; // Bearer → anonymous, like the real API
    const userId = token && state.access.has(token) ? MOCK_USER.id : null;

    // test hooks
    if (p.startsWith('/__test/')) {
      if (p === '/__test/log') return send(res, 200, state.log);
      if (p === '/__test/expire-access') { state.access.clear(); return send(res, 200, {}); }
      if (p === '/__test/expire-all') { state.access.clear(); state.refresh.clear(); return send(res, 200, {}); }
      if (p === '/__test/next429') { state.flags.next429 = true; return send(res, 200, {}); }
      if (p === '/__test/fail-next-modify') { state.flags.failNextModify = true; return send(res, 200, {}); }
      return send(res, 404, {});
    }

    state.log.push({ method: req.method, path: p, query: url.search, auth: authz ? authz.split(' ')[0] : null, authed: !!userId, body, ua: req.headers['user-agent'] });

    if (req.method === 'GET' && state.flags.next429) {
      state.flags.next429 = false;
      return send(res, 429, { detail: 'Request was throttled.' }, { 'Retry-After': '0' });
    }
    // a JWT that is present but unknown/expired → 401 (like the real API)
    if (token && !userId && !p.startsWith('/rest-auth/')) return send(res, 401, { detail: 'Signature has expired.' });

    // ---- auth ----
    if (p === '/rest-auth/login/' && req.method === 'POST') {
      const ok = body && body.password === MOCK_USER.password && (body.email === MOCK_USER.email || body.username === MOCK_USER.username);
      if (!ok) return send(res, 400, { non_field_errors: ['Unable to log in with provided credentials.'] });
      const access = makeJwt(MOCK_USER.id);
      const refresh = 'refresh-' + crypto.randomUUID();
      state.access.add(access);
      state.refresh.add(refresh);
      return send(res, 200, { access_token: access, refresh_token: refresh, user: { pk: MOCK_USER.id, username: MOCK_USER.username, email: MOCK_USER.email } });
    }
    if (p === '/rest-auth/token/refresh/' && req.method === 'POST') {
      if (!body || !state.refresh.has(body.refresh)) return send(res, 401, { detail: 'Token is invalid or expired', code: 'token_not_valid' });
      const access = makeJwt(MOCK_USER.id);
      state.access.add(access);
      return send(res, 200, { access, access_token_expiration: new Date(Date.now() + 3600e3).toISOString() });
    }

    // ---- cards ----
    if (p === '/cards/v2/' && req.method === 'GET') {
      const name = (q.get('name') || '').toLowerCase();
      const exact = q.get('exact') === 'true';
      let list = state.cards.filter((c) => (exact ? c.oracleCard.name.toLowerCase() === name : c.oracleCard.name.toLowerCase().includes(name)));
      if (q.get('edition')) list = list.filter((c) => c.edition.editioncode === q.get('edition'));
      if (q.get('collectorNumber')) list = list.filter((c) => c.collectorNumber === q.get('collectorNumber'));
      const size = Number(q.get('pageSize') || 60);
      return send(res, 200, { count: list.length, next: null, previous: null, results: list.slice(0, size) });
    }

    // ---- decks ----
    if (p === '/decks/v3/' && req.method === 'GET') {
      let list = [...state.decks.values()].filter((d) => !d.deleted);
      const ownerId = q.get('ownerId');
      list = list.filter((d) => !d.private || (userId && d.owner.id === userId && ownerId));
      if (ownerId) list = list.filter((d) => String(d.owner.id) === ownerId);
      if (q.get('name')) list = list.filter((d) => d.name.toLowerCase().includes(q.get('name').toLowerCase()));
      if (q.get('ownerUsername')) list = list.filter((d) => d.owner.username === q.get('ownerUsername'));
      if (q.get('deckFormat')) list = list.filter((d) => String(d.deckFormat) === q.get('deckFormat'));
      if (q.get('commanderName')) {
        const n = q.get('commanderName').toLowerCase();
        list = list.filter((d) => d.cards.some((r) => !r.deletedAt && r.categories?.[0] === 'Commander' && r.card.oracleCard.name.toLowerCase().includes(n)));
      }
      list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const page = Number(q.get('page') || 1);
      const pg = paginate(list.map(deckListRow), page, ownerId ? Number(q.get('pageSize') || 50) : 60);
      return send(res, 200, { count: pg.count, next: pg.next, previous: pg.previous, results: pg.results });
    }
    if (p === '/decks/v2/' && req.method === 'POST') {
      if (!userId) return send(res, 401, { detail: 'Authentication credentials were not provided.' });
      if (!body?.name) return send(res, 400, { name: ['This field is required.'] });
      const id = ++state.nextDeckId;
      state.decks.set(id, {
        id, name: body.name, description: body.description ? state.quill(body.description) : '', deckFormat: body.deckFormat, edhBracket: body.edhBracket,
        private: !!body.private, unlisted: !!body.unlisted, owner: { id: userId, username: MOCK_USER.username }, deckTags: [],
        updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), viewCount: 0,
        categories: [{ name: 'Commander', isPremier: true, includedInDeck: true }, { name: 'Maybeboard', isPremier: false, includedInDeck: false }],
        cards: [],
      });
      return send(res, 201, { id, name: body.name });
    }
    let m = p.match(/^\/decks\/(\d+)\/$/);
    if (m) {
      const d = state.decks.get(Number(m[1]));
      if (!d) return send(res, 404, { detail: 'Not found.' });
      if (d.deleted) return send(res, 400, { detail: 'Deck has been deleted' });
      const isOwner = userId && d.owner.id === userId;
      if (req.method === 'GET') {
        if (d.private && !isOwner) return send(res, 404, { detail: 'Not found.' });
        return send(res, 200, d);
      }
      if (req.method === 'DELETE') {
        if (!userId) return send(res, 401, { detail: 'not authenticated' });
        if (!isOwner) return send(res, 403, { detail: 'forbidden' });
        d.deleted = true;
        return send(res, 204);
      }
    }
    m = p.match(/^\/decks\/(\d+)\/update\/$/);
    if (m && req.method === 'PATCH') {
      const d = state.decks.get(Number(m[1]));
      if (!d || d.deleted) return send(res, 404, { detail: 'Not found.' });
      if (!userId) return send(res, 401, { detail: 'not authenticated' });
      if (d.owner.id !== userId) return send(res, 403, { detail: 'forbidden' });
      for (const k of ['name', 'deckFormat', 'edhBracket', 'private', 'unlisted']) if (k in body) d[k] = body[k];
      if ('description' in body) d.description = state.quill(body.description);
      return send(res, 200, { id: d.id });
    }
    m = p.match(/^\/decks\/(\d+)\/modifyCards\/v2\/$/);
    if (m && req.method === 'PATCH') {
      const d = state.decks.get(Number(m[1]));
      if (!d || d.deleted) return send(res, 404, { detail: 'Not found.' });
      if (!userId) return send(res, 401, { detail: 'not authenticated' });
      if (d.owner.id !== userId) return send(res, 403, { detail: 'forbidden' });
      if (state.flags.failNextModify) { state.flags.failNextModify = false; return send(res, 500, '<html>Server Error</html>'); }
      if (!Array.isArray(body?.cards) || body.cards.length !== 1) return send(res, 400, { detail: 'mock expects exactly one entry' });
      const e = body.cards[0];
      if (!/^[0-9a-f]{32}$/.test(e.patchId || '')) return send(res, 400, { detail: 'bad patchId' });
      const mods = e.modifications || {};
      if (e.action === 'add') {
        const card = state.byId.get(e.cardid);
        if (!card) return send(res, 400, { detail: 'unknown card' });
        const cats = e.categories?.length ? e.categories : [card.oracleCard.defaultCategory || 'Uncategorized'];
        for (const c of cats) if (!d.categories.some((x) => x.name === c)) d.categories.push({ name: c, isPremier: false, includedInDeck: true });
        const r = state.row(e.cardid, mods.quantity ?? 1, cats, { modifier: mods.modifier || 'Normal' });
        d.cards.push(r);
        return send(res, 200, { add: [{ id: r.id, patchId: e.patchId }] });
      }
      const r = d.cards.find((x) => x.id === e.deckRelationId && !x.deletedAt);
      if (!r) return send(res, 400, { detail: 'unknown deckRelationId' });
      if (e.action === 'remove') { r.deletedAt = new Date().toISOString(); return send(res, 200, {}); }
      if (e.action === 'modify') {
        if (mods.quantity != null) r.quantity = mods.quantity;
        if (mods.modifier) r.modifier = mods.modifier;
        if (Array.isArray(e.categories) && e.categories.length) {
          r.categories = e.categories;
          for (const c of e.categories) if (!d.categories.some((x) => x.name === c)) d.categories.push({ name: c, isPremier: false, includedInDeck: !/maybeboard|sideboard/i.test(c) });
        }
        return send(res, 200, {});
      }
      return send(res, 400, { detail: 'bad action' });
    }

    // ---- collection ----
    m = p.match(/^\/collection\/(\d+)\/v2\/$/);
    if (m && req.method === 'GET') {
      if (!userId || Number(m[1]) !== userId) return send(res, 403, { detail: 'private collection' });
      let list = [...state.collection.values()].sort((a, b) => a.id - b.id);
      if (q.get('cardName')) list = list.filter((r) => r.card.oracleCard.name.toLowerCase().includes(q.get('cardName').toLowerCase()));
      const pageSize = Math.min(500, Number(q.get('pageSize') || 50));
      const pg = paginate(list, Number(q.get('page') || 1), pageSize);
      return send(res, 200, { ...pg, tags: [], isPublic: false, owner: { id: userId, username: MOCK_USER.username } });
    }
    if (p === '/collection/v2/' && req.method === 'POST') {
      if (!userId) return send(res, 401, { detail: 'not authenticated' });
      const card = state.byId.get(body?.card);
      if (!card || !body.quantity || body.game !== 1) return send(res, 400, { detail: 'invalid' });
      if (!Number.isInteger(body.condition) || body.condition < 1 || body.condition > 5) return send(res, 400, { condition: ['A valid integer is required.'] });
      if (!Number.isInteger(body.language) || body.language < 1 || body.language > 11) return send(res, 400, { language: ['A valid integer is required.'] });
      const id = ++state.nextRecordId;
      const r = { id, quantity: body.quantity, modifier: body.modifier, language: body.language, condition: body.condition, tags: [], purchasePrice: 0, createdAt: new Date().toISOString(), game: 1, card };
      state.collection.set(id, r);
      return send(res, 201, { ...r, card: card.id });
    }
    m = p.match(/^\/collection\/v2\/(\d+)\/$/);
    if (m && req.method === 'PATCH') {
      if (!userId) return send(res, 401, { detail: 'not authenticated' });
      const r = state.collection.get(Number(m[1]));
      if (!r) return send(res, 404, { detail: 'Not found.' });
      for (const k of ['game', 'quantity', 'card', 'modifier', 'language', 'condition']) if (!(k in body)) return send(res, 400, { [k]: ['This field is required.'] });
      if (!Number.isInteger(body.condition) || body.condition < 1 || body.condition > 5) return send(res, 400, { condition: ['A valid integer is required.'] });
      if (!Number.isInteger(body.language) || body.language < 1 || body.language > 11) return send(res, 400, { language: ['A valid integer is required.'] });
      Object.assign(r, { quantity: body.quantity, modifier: body.modifier, language: body.language, condition: body.condition, card: state.byId.get(body.card) || r.card });
      return send(res, 200, { ...r, card: r.card.id });
    }
    if (p === '/collection/bulk/' && req.method === 'DELETE') {
      if (!userId) return send(res, 401, { detail: 'not authenticated' });
      for (const id of body?.ids || []) state.collection.delete(id);
      return send(res, 204);
    }

    return send(res, 404, { detail: `mock: no route ${req.method} ${p}` });
  });
  return { server, state };
}

export async function startMock(port = 0) {
  const { server, state } = createMockServer();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return { server, state, base, close: () => new Promise((r) => server.close(r)) };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('mock-server.mjs')) {
  const { base } = await startMock(Number(process.argv[2] || 8787));
  process.stderr.write(`mock Archidekt API at ${base}\n`);
}
