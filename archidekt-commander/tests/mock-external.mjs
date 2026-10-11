// Local mocks of Scryfall, LigaMagic and EDHREC, shaped after PHASE2_SOURCES.md (formats verified live 2026-10-11).
// One HTTP server; routes are prefixed /scryfall, /liga and /edhrec.

import http from 'node:http';
import zlib from 'node:zlib';

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’'`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const oid = (name) => `oid-${norm(name).replace(/ /g, '-')}`;

function sc(name, o = {}) {
  return {
    object: 'card', id: `id-${oid(name)}`, oracle_id: oid(name), name, lang: 'en', layout: o.layout ?? 'normal',
    mana_cost: o.cost ?? '', cmc: o.cmc ?? 0, type_line: o.type ?? '', oracle_text: o.text ?? '',
    colors: o.colors ?? o.ci ?? [], color_identity: o.ci ?? [], keywords: o.kw ?? [],
    legalities: { commander: o.legal ?? 'legal', standard: 'not_legal' }, games: o.games ?? ['paper', 'mtgo'],
    game_changer: !!o.gc, ...(o.rank != null ? { edhrec_rank: o.rank } : {}), prices: { usd: o.usd ?? '1.00', eur: null },
    set: 'tst', rarity: 'rare', digital: !!o.digital, ...(o.extra || {}),
  };
}

export const SCRY_CARDS = [
  sc('Sol Ring', { cmc: 1, cost: '{1}', type: 'Artifact', text: '{T}: Add {C}{C}.', rank: 1, gc: false }),
  sc('Rampant Growth', { cmc: 2, cost: '{1}{G}', type: 'Sorcery', ci: ['G'], text: 'Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.', rank: 30 }),
  sc('Cultivate', { cmc: 3, cost: '{2}{G}', type: 'Sorcery', ci: ['G'], text: 'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.', rank: 10 }),
  sc("Kodama's Reach", { cmc: 3, cost: '{2}{G}', type: 'Sorcery — Arcane', ci: ['G'], text: 'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.', rank: 25 }),
  sc('Lightning Bolt', { cmc: 1, cost: '{R}', type: 'Instant', ci: ['R'], text: 'Lightning Bolt deals 3 damage to any target.', rank: 50 }),
  sc('Counterspell', { cmc: 2, cost: '{U}{U}', type: 'Instant', ci: ['U'], text: 'Counter target spell.', rank: 35 }),
  sc('Forest', { type: 'Basic Land — Forest', ci: ['G'], colors: [], text: '({T}: Add {G}.)' }),
  sc('Mountain', { type: 'Basic Land — Mountain', ci: ['R'], colors: [], text: '({T}: Add {R}.)' }),
  sc('Island', { type: 'Basic Land — Island', ci: ['U'], colors: [], text: '({T}: Add {U}.)' }),
  sc('Omnath, Locus of Rage', { cmc: 5, cost: '{3}{R}{R}{G}{G}', type: 'Legendary Creature — Elemental', ci: ['R', 'G'], text: 'Landfall — Whenever a land you control enters, create a 5/5 red and green Elemental creature token.\nWhenever Omnath, Locus of Rage or another Elemental you control dies, Omnath deals 3 damage to any target.', rank: 900, kw: ['Landfall'] }),
  sc('Valakut Awakening // Valakut Stoneforge', {
    cmc: 3, ci: ['R'], layout: 'modal_dfc', rank: 400,
    extra: {
      mana_cost: undefined, type_line: undefined, oracle_text: undefined, colors: undefined,
      card_faces: [
        { name: 'Valakut Awakening', mana_cost: '{2}{R}', type_line: 'Instant', oracle_text: 'Put any number of cards from your hand on the bottom of your library, then draw that many cards plus one.', colors: ['R'] },
        { name: 'Valakut Stoneforge', mana_cost: '', type_line: 'Land', oracle_text: 'As Valakut Stoneforge enters, you may pay 3 life. If you don\'t, it enters tapped.\n{T}: Add {R}.', colors: [] },
      ],
    },
  }),
  sc('Mana Crypt', { cmc: 0, cost: '{0}', type: 'Artifact', text: '{T}: Add {C}{C}.', legal: 'banned', gc: true, rank: 5 }),
  sc('The One Ring', { cmc: 4, cost: '{4}', type: 'Legendary Artifact', text: 'Indestructible\nWhen The One Ring enters, if you cast it, you gain protection from everything until your next turn.\n{T}: Put a burden counter on The One Ring, then draw a card for each burden counter on The One Ring.', gc: true, rank: 8 }),
  sc("Dragon's Approach", { cmc: 3, cost: '{2}{R}', type: 'Sorcery', ci: ['R'], text: "Dragon's Approach deals 3 damage to each opponent.", rank: 9000 }),
  sc("Atraxa, Praetors' Voice", { cmc: 4, cost: '{G}{W}{U}{B}', type: 'Legendary Creature — Phyrexian Angel Horror', ci: ['W', 'U', 'B', 'G'], text: 'Flying, vigilance, deathtouch, lifelink\nAt the beginning of your end step, proliferate.', rank: 100 }),
  sc('Lotus Cobra', { cmc: 2, cost: '{1}{G}', type: 'Creature — Snake', ci: ['G'], text: 'Landfall — Whenever a land you control enters, add one mana of any color.', rank: 200, kw: ['Landfall'] }),
  sc('Beast Within', { cmc: 3, cost: '{2}{G}', type: 'Instant', ci: ['G'], text: 'Destroy target permanent. Its controller creates a 3/3 green Beast creature token.', rank: 40 }),
  sc('Blasphemous Act', { cmc: 9, cost: '{8}{R}', type: 'Sorcery', ci: ['R'], text: 'This spell costs {1} less to cast for each creature on the battlefield.\nBlasphemous Act deals 13 damage to each creature.', rank: 60 }),
  sc('Eternal Witness', { cmc: 3, cost: '{1}{G}{G}', type: 'Creature — Human Shaman', ci: ['G'], text: 'When this creature enters, return target card from your graveyard to your hand.', rank: 45 }),
  sc('Scavenging Ooze', { cmc: 2, cost: '{1}{G}', type: 'Creature — Ooze', ci: ['G'], text: '{G}: Exile target card from a graveyard. If it was a creature card, put a +1/+1 counter on this creature and you gain 1 life.', rank: 80 }),
  sc('Colossal Dreadmaw', { cmc: 6, cost: '{4}{G}{G}', type: 'Creature — Dinosaur', ci: ['G'], text: 'Trample', kw: ['Trample'], rank: 15000 }),
  sc('Temple of Abandon', { type: 'Land', ci: ['R', 'G'], colors: [], text: 'This land enters tapped.\nWhen this land enters, scry 1.\n{T}: Add {R} or {G}.', rank: 900 }),
  sc('Demonic Tutor', { cmc: 2, cost: '{1}{B}', type: 'Sorcery', ci: ['B'], text: 'Search your library for a card, put that card into your hand, then shuffle.', gc: true, rank: 20 }),
  sc('Avenger of Zendikar', { cmc: 7, cost: '{5}{G}{G}', type: 'Creature — Elemental', ci: ['G'], text: 'When this creature enters, create a 0/1 green Plant creature token for each land you control.\nLandfall — Whenever a land you control enters, you may put a +1/+1 counter on each Plant creature you control.', rank: 300 }),
  sc('Heroic Intervention', { cmc: 2, cost: '{1}{G}', type: 'Instant', ci: ['G'], text: 'Permanents you control gain hexproof and indestructible until end of turn.', rank: 70 }),
  sc('Relic of Progenitus', { cmc: 1, cost: '{1}', type: 'Artifact', text: '{T}: Target player exiles a card from their graveyard.\n{1}, Exile this artifact: Exile all graveyards. Draw a card.', rank: 400 }),
  sc('Toph, the First Metalbender', { cmc: 3, cost: '{1}{G}{G}', type: 'Legendary Creature — Human Warrior', ci: ['G'], text: 'Artifacts you control are lands in addition to their other types.' }),
  sc('Opt', { cmc: 1, cost: '{U}', type: 'Instant', ci: ['U'], text: 'Scry 1.\nDraw a card.', rank: 300 }),
  sc('Howling Mine', { cmc: 2, cost: '{2}', type: 'Artifact', text: "At the beginning of each player's draw step, if this artifact is untapped, that player draws an additional card.", rank: 3000 }),
  sc('Darksteel Myr', { cmc: 3, cost: '{3}', type: 'Artifact Creature — Myr', text: 'Indestructible', kw: ['Indestructible'], rank: 9000 }),
  sc('Gravecrawler', { cmc: 1, cost: '{B}', type: 'Creature — Zombie', ci: ['B'], text: "Gravecrawler can't block.\nYou may cast Gravecrawler from your graveyard as long as you control a Zombie.", rank: 5000 }),
  sc('Destiny Spinner', { cmc: 2, cost: '{1}{G}', type: 'Enchantment Creature — Human', ci: ['G'], text: "Creature and enchantment spells you control can't be countered.", rank: 900 }),
  sc('Digital Only Thing', { cmc: 2, type: 'Creature — Construct', games: ['arena'], digital: true }),
  sc('Beast', { type: 'Token Creature — Beast', layout: 'token', ci: ['G'] }),
];

// Archidekt-style twoCardComboIds etc. are on the Archidekt mock; Scryfall tags below.
const T = (id, slug, cards, parents = []) => ({
  object: 'tag', id, label: slug, slug, type: 'oracle', description: `${slug} tag`, parent_ids: parents, child_ids: [], aliases: [],
  taggings: cards.map((c) => ({ oracle_id: oid(c), weight: 'median' })),
});
// Real Scryfall slugs and hierarchy (oracle_tags bulk, 2026-10-11): roots such as removal, draw, tutor,
// protection, recursion, burn and hate have NO direct taggings; cards carry only descendant tags.
export const SCRY_TAGS = [
  // ramp (ramp itself has direct taggings)
  T('t-ramp', 'ramp', ['Lotus Cobra']),
  T('t-land-ramp', 'land-ramp', ['Rampant Growth', 'Cultivate', "Kodama's Reach"], ['t-ramp']),
  T('t-mana-producer', 'mana-producer', ['Forest', 'Mountain', 'Island', 'Temple of Abandon']),
  T('t-mana-rock', 'mana-rock', ['Sol Ring', 'Mana Crypt']),
  // tutors: land tutors are ramp, not tutor
  T('t-tutor', 'tutor', []),
  T('t-tutor-to', 'tutor-to', [], ['t-tutor']),
  T('t-tutor-to-hand', 'tutor-to-hand', ['Demonic Tutor'], ['t-tutor-to']),
  T('t-tutor-to-bf', 'tutor-to-battlefield', [], ['t-tutor-to']),
  T('t-tutor-land', 'tutor-land', [], ['t-tutor']),
  T('t-tutor-land-basic', 'tutor-land-basic', ['Rampant Growth', 'Cultivate', "Kodama's Reach"], ['t-tutor-land']),
  T('t-tutor-land-to-bf', 'tutor-land-to-battlefield', ['Rampant Growth', 'Cultivate', "Kodama's Reach"], ['t-tutor-to-bf', 't-tutor-land']),
  // removal
  T('t-removal', 'removal', []),
  T('t-removal-destroy', 'removal-destroy', ['Beast Within'], ['t-removal']),
  T('t-removal-creature', 'removal-creature', [], ['t-removal']),
  T('t-removal-burn', 'removal-burn', [], ['t-removal']),
  T('t-burn-creature', 'burn-creature', ['Lightning Bolt'], ['t-removal-burn', 't-removal-creature']),
  T('t-sweeper', 'sweeper', [], ['t-removal']),
  T('t-sweeper-damage', 'sweeper-damage', ['Blasphemous Act'], ['t-sweeper']),
  // burn
  T('t-burn', 'burn', []),
  T('t-burn-player', 'burn-player', ["Dragon's Approach"], ['t-burn']),
  T('t-burn-any', 'burn-any', ['Lightning Bolt']),
  // counters
  T('t-counter', 'counterspell', ['Counterspell']),
  T('t-hate', 'hate', []),
  T('t-hate-counter', 'hate-counterspell', ['Destiny Spinner'], ['t-hate']),
  // graveyard hate vs other hate
  T('t-hate-gy', 'hate-graveyard', ['Scavenging Ooze', 'Relic of Progenitus'], ['t-hate']),
  T('t-hate-artifact', 'hate-artifact', ['Beast Within'], ['t-hate']),
  // recursion (self-recursion excluded)
  T('t-recursion', 'recursion', []),
  T('t-recursion-creature', 'recursion-creature', [], ['t-recursion']),
  T('t-regrowth', 'regrowth', [], ['t-recursion']),
  T('t-regrowth-creature', 'regrowth-creature', ['Eternal Witness'], ['t-regrowth', 't-recursion-creature']),
  T('t-recursion-self', 'recursion-self', [], ['t-recursion']),
  T('t-reanimate', 'reanimate', [], ['t-recursion']),
  T('t-reanimate-self', 'reanimate-self', ['Gravecrawler'], ['t-reanimate', 't-recursion-self']),
  // draw (cantrip and force-draw excluded)
  T('t-draw', 'draw', []),
  T('t-pure-draw', 'pure-draw', [], ['t-draw']),
  T('t-cantrip', 'cantrip', ['Opt', 'Relic of Progenitus'], ['t-pure-draw']),
  T('t-repeatable-draw', 'repeatable-draw', [], ['t-draw']),
  T('t-draw-engine', 'draw-engine', ['The One Ring'], ['t-repeatable-draw']),
  T('t-force-draw', 'force-draw', ['Howling Mine']),
  T('t-ca', 'card-advantage', ['The One Ring']),
  // protection vs self-protection
  T('t-protection', 'protection', []),
  T('t-protects-all', 'protects-all', ['Heroic Intervention'], ['t-protection']),
  T('t-gives-hexproof', 'gives-hexproof', ['Heroic Intervention'], ['t-protection']),
  T('t-protects-self', 'protects-self', []),
  T('t-gains-indestructible', 'gains-indestructible', ['Darksteel Myr'], ['t-protects-self']),
  // tokens: no "token-generator" root; one-shot tokens come from text
  T('t-rtg', 'repeatable-token-generator', []),
  T('t-rct', 'repeatable-creature-tokens', ['Omnath, Locus of Rage'], ['t-rtg']),
  T('t-lands-matter', 'lands-matter', []),
  T('t-landfall', 'landfall', ['Omnath, Locus of Rage', 'Lotus Cobra', 'Avenger of Zendikar'], ['t-lands-matter']),
  // evasion: very broad (own flying) → no role
  T('t-evasion', 'evasion', ["Atraxa, Praetors' Voice"]),
  T('t-useless', 'flavor-text-reference', ['Colossal Dreadmaw']), // not whitelisted
  { object: 'tag', id: 't-art', label: 'dinosaur-art', slug: 'dinosaur-art', type: 'illustration', parent_ids: [], taggings: [{ oracle_id: oid('Colossal Dreadmaw') }] },
];

const pt = (en, printed, n = 1, extra = {}) => Array.from({ length: n }, (_, i) => ({ object: 'card', name: en, printed_name: printed, lang: 'pt', oracle_id: oid(en), set: `s${i}`, collector_number: String(100 + i), ...extra }));
export const PT_PAGES = [
  // "Opção" is (in this fixture) the PT name of two different cards: an ambiguous translation.
  [...pt('Sol Ring', 'Anel Solar', 2), ...pt('Rampant Growth', 'Crescimento Exuberante'), ...pt('Cultivate', 'Cultivar'), ...pt('Opt', 'Opção', 2), ...pt('Howling Mine', 'Opção')],
  [...pt('Lightning Bolt', 'Relâmpago', 2), ...pt('Lightning Bolt', 'Raio'), ...pt('Eternal Witness', 'Testemunha Eterna'), ...pt('Beast Within', 'Fera Interior')],
  [
    { object: 'card', name: 'Valakut Awakening // Valakut Stoneforge', lang: 'pt', oracle_id: oid('Valakut Awakening // Valakut Stoneforge'), card_faces: [{ name: 'Valakut Awakening', printed_name: 'Despertar de Valakut' }, { name: 'Valakut Stoneforge', printed_name: 'Forja-pedra de Valakut' }] },
    ...pt('Forest', 'Floresta'), ...pt("Kodama's Reach", 'Alcance de Kodama'), ...pt('Mountain', 'Montanha'),
  ],
];

// ---------------- LigaMagic HTML ----------------
const single = ({ name, aux, min, avg, max, ed = '' }) => `
<div class="mtg-single">
  <div class="mtg-names">
    <div class="mtg-name"><a href="/?view=cards/card&card=${encodeURIComponent(aux || name)}&amp;aux=${encodeURIComponent(name)}${ed}">${name}</a></div>
    ${aux ? `<div class="mtg-name-aux"><a href="/?view=cards/card&card=${encodeURIComponent(aux)}">${aux}</a></div>` : ''}
  </div>
  <div class="mtg-type">Artefato</div>
  <div class="mtg-prices "><div class="mtg-price-unit">
    <div class="price-min">${min}</div><div class="mtg-circle"> </div>
    <div class="price-avg">${avg}</div><div class="mtg-circle"> </div>
    <div class="price-max">${max}</div>
  </div></div>
</div>`;
const page = (blocks) => `<!doctype html><html><head><title>LigaMagic</title></head><body><div id="search-results">${blocks.join('\n')}</div>
<div class="mtg-single"><div class="product-name">Deck Box Ultra Pro</div><div class="price-min">R$ 50,00</div></div></body></html>`;

const LIGA = {
  sol: page([
    single({ name: 'Anel Solar', aux: 'Sol Ring', min: 'R$ 7,09', avg: 'R$ 67,83', max: 'R$ 7.499,00' }),
    single({ name: 'Anel Solar (Art Card)', aux: 'Sol Ring (Art Card)', min: 'R$ 1,00', avg: 'R$ 2,00', max: 'R$ 3,00' }),
    single({ name: 'Anel Solar (Art Card com Assinatura)', aux: 'Sol Ring (Art Card com Assinatura)', min: 'R$ 5,00', avg: 'R$ 6,00', max: 'R$ 7,00' }),
    single({ name: 'Anel Solar (#249)', aux: 'Sol Ring (#249)', min: 'R$ 9,90', avg: 'R$ 15,00', max: 'R$ 30,00' }),
    single({ name: 'Anel Solar (Lorwyn)', aux: 'Sol Ring (Lorwyn)', min: 'R$ 12,00', avg: 'R$ 20,00', max: 'R$ 1.250,50' }),
  ]),
  cultivate: page([single({ name: 'Cultivar', aux: 'Cultivate', min: 'R$ 2,49', avg: 'R$ 13,01', max: 'R$ 149,40' })]),
  toph: page([single({ name: 'Toph, the First Metalbender', min: 'R$ 12,35', avg: 'R$ 38,16', max: 'R$ 88,90' }), single({ name: 'Toph, the First Metalbender (#301)', min: 'R$ 30,00', avg: 'R$ 45,00', max: 'R$ 99,00' })]),
  bolt: page([single({ name: 'Relâmpago', aux: 'Lightning Bolt', min: 'R$ 0,00', avg: 'R$ 3,50', max: 'R$ 20,00' })]),
  moon: page([single({ name: 'Raio Lunar', aux: 'Moonlight Bolt', min: 'R$ 1,50', avg: 'R$ 2,00', max: 'R$ 4,00' })]),
  empty: page([]),
};
const LIGA_ROUTES = {
  'anel solar': 'sol', 'sol ring': 'sol', cultivar: 'cultivate', cultivate: 'cultivate', 'toph the first metalbender': 'toph',
  relampago: 'bolt', 'lightning bolt': 'bolt', 'raio lunar': 'moon',
};

// ---------------- EDHREC ----------------
const view = (name, synergy, num, potential = 5000) => ({ name, sanitized: norm(name).replace(/ /g, '-'), synergy, num_decks: num, potential_decks: potential, inclusion: num });
export const EDHREC_OMNATH = {
  creature: 30, instant: 8, sorcery: 10, artifact: 6, enchantment: 4, planeswalker: 1, battle: 0, land: 38, basic: 20, nonbasic: 18,
  bracket_counts: { 1: 10, 2: 900, 3: 2500, 4: 1200, 5: 100 },
  panels: {
    taglinks: [{ slug: 'landfall', value: 'Landfall', count: 3000 }, { slug: 'elementals', value: 'Elementals', count: 1500 }, { slug: 'tokens', value: 'Tokens', count: 400 }],
    mana_curve: { 0: 1, 1: 8, 2: 14, 3: 16, 4: 10, 5: 7, 6: 4, 7: 2 },
  },
  container: {
    json_dict: {
      card: { name: 'Omnath, Locus of Rage', num_decks: 5000, rank: 300, color_identity: ['R', 'G'] },
      cardlists: [
        { header: 'High Synergy Cards', cardviews: [view('Lotus Cobra', 0.45, 3000), view('Avenger of Zendikar', 0.4, 2800), view('Scavenging Ooze', 0.1, 1500)] },
        { header: 'Top Cards', cardviews: [view('Lightning Bolt', 0.05, 2000), view('Sol Ring', 0.0, 4800), view('Demonic Tutor', 0.0, 100), view('Mana Crypt', 0.0, 50), view('Heroic Intervention', 0.08, 1800)] },
        { header: 'Creatures', cardviews: [view('Eternal Witness', 0.02, 2500), view('Colossal Dreadmaw', -0.05, 50)] },
      ],
    },
  },
};

const edhPage = (cardviews, extra = {}) => ({ creature: 30, land: 38, ...extra, container: { json_dict: { card: { name: 'Omnath, Locus of Rage', num_decks: extra.num ?? 1000 }, cardlists: [{ header: 'Top Cards', cardviews }] } } });
export const EDHREC_OMNATH_PAGES = {
  landfall: edhPage([view('Lotus Cobra', 0.5, 2700, 3000), view('Avenger of Zendikar', 0.45, 2400, 3000), view("Kodama's Reach", 0.2, 1900, 3000), view('Cultivate', 0.15, 2000, 3000), view('Rampant Growth', 0.1, 1700, 3000), view('Temple of Abandon', 0.1, 1200, 3000)], { num: 3000 }),
  elementals: edhPage([view('Avenger of Zendikar', 0.3, 800, 1500), view('Lightning Bolt', 0.0, 300, 1500)], { num: 1500 }),
  tokens: edhPage([view('Avenger of Zendikar', 0.3, 300, 400)], { num: 400 }),
  core: edhPage([view('Cultivate', 0.1, 600, 900), view("Kodama's Reach", 0.1, 500, 900), view('Beast Within', 0.05, 450, 900), view('Heroic Intervention', 0.08, 400, 900), view('Scavenging Ooze', 0.1, 300, 900), view('Relic of Progenitus', 0.02, 200, 900)], { num: 900 }),
};
export const EDHREC_OMNATH_AVG = {
  deck: { commander: ['Omnath, Locus of Rage'], cards: { Creature: [['Lotus Cobra', 1], ['Avenger of Zendikar', 1], ['Eternal Witness', 1]], Sorcery: [['Cultivate', 1], ["Kodama's Reach", 1], ['Rampant Growth', 1]], Instant: [['Beast Within', 1], ['Heroic Intervention', 1]], Land: [['Forest', 20], ['Mountain', 8]] } },
  container: { json_dict: { card: { name: 'Omnath, Locus of Rage', num_decks: 5000 }, cardlists: [] } },
};
export const EDHREC_OMNATH_COMBOS = {
  container: { json_dict: { cardlists: [
    { header: 'Scavenging Ooze + Eternal Witness (500 decks)', combo: { count: 500, percentage: 1.2, results: ['Infinite test'], comboVote: { bracket: '3' } }, cardviews: [{ name: 'Scavenging Ooze' }, { name: 'Eternal Witness' }] },
    { header: 'dup', combo: { count: 500 }, cardviews: [{ name: 'Eternal Witness' }, { name: 'Scavenging Ooze' }] },
  ] } },
};
const cardPageOf = (name, num, potential, top = []) => ({ container: { json_dict: { card: { name, num_decks: num, potential_decks: potential, salt: 0.3 }, cardlists: [{ header: 'Top Commanders', tag: 'topcommanders', cardviews: top.map(([n, a, b]) => ({ name: n, num_decks: a, potential_decks: b })) }] } } });
export const EDHREC_CARD_PAGES = {
  'colossal-dreadmaw': cardPageOf('Colossal Dreadmaw', 2000, 900000),
  'the-one-ring': cardPageOf('The One Ring', 400000, 1000000, [['Omnath, Locus of Rage', 900, 5000]]),
  'blasphemous-act': cardPageOf('Blasphemous Act', 150000, 500000),
  'fire-ice': cardPageOf('Fire // Ice', 50000, 400000),
};

function gz(objs) {
  return zlib.gzipSync(Buffer.from(objs.map((o) => JSON.stringify(o)).join('\n') + '\n'));
}

export function createExternalMock() {
  const state = {
    log: [],
    flags: { slowMs: 0, failPtPage: 0, legacyBulk: false, bulkDown: false, truncGz: false },
  };
  const files = {
    cards: gz(SCRY_CARDS),
    tags: gz(SCRY_TAGS),
    cardsLegacy: Buffer.from('[\n' + SCRY_CARDS.map((c) => JSON.stringify(c)).join(',\n') + '\n]\n'),
    tagsLegacy: Buffer.from('[\n' + SCRY_TAGS.map((c) => JSON.stringify(c)).join(',\n') + '\n]\n'),
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const origin = `http://${req.headers.host}`;
    const p = url.pathname;
    const q = url.searchParams;
    for await (const _ of req); // drain
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (p.startsWith('/__test/')) {
      if (p === '/__test/log') return json(200, state.log);
      if (p === '/__test/flags') {
        for (const [k, v] of q) state.flags[k] = v === 'true' ? true : v === 'false' ? false : Number(v);
        return json(200, state.flags);
      }
      if (p === '/__test/reset') {
        state.flags = { slowMs: 0, failPtPage: 0, legacyBulk: false, bulkDown: false, truncGz: false };
        state.log.length = 0;
        return json(200, {});
      }
      return json(404, {});
    }
    state.log.push({ path: p, query: url.search, ua: req.headers['user-agent'] });

    // ---------- Scryfall ----------
    if (state.flags.next429 && p.startsWith('/scryfall/') && !p.startsWith('/scryfall/files/')) {
      state.flags.next429 = false;
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
      return res.end(JSON.stringify({ object: 'error', code: 'rate_limited', details: 'Too many requests' }));
    }
    if (p === '/scryfall/bulk-data') {
      if (state.flags.bulkDown) return json(503, { object: 'error', details: 'down' });
      const now = '2026-10-10T21:01:55.000+00:00';
      const entry = (type, file, legacyFile) =>
        state.flags.legacyBulk
          ? { object: 'bulk_data', type, updated_at: now, download_uri: `${origin}/scryfall/files/${legacyFile}`, size: 1000 }
          : { object: 'bulk_data', type, updated_at: now, jsonl_download_uri: `${origin}/scryfall/files/${file}`, compressed_size: 1000 };
      return json(200, {
        object: 'list',
        has_more: false,
        data: [entry('oracle_cards', 'oracle-cards.jsonl.gz', 'oracle-cards.json'), entry('oracle_tags', 'oracle-tags.jsonl.gz', 'oracle-tags.json'), entry('rulings', 'rulings.jsonl.gz', 'rulings.json')],
      });
    }
    const fileMap = { 'oracle-cards.jsonl.gz': files.cards, 'oracle-tags.jsonl.gz': files.tags, 'oracle-cards.json': files.cardsLegacy, 'oracle-tags.json': files.tagsLegacy };
    const fm = p.match(/^\/scryfall\/files\/(.+)$/);
    if (fm && fileMap[fm[1]]) {
      if (state.flags.slowMs) await new Promise((r) => setTimeout(r, state.flags.slowMs));
      res.writeHead(200, { 'Content-Type': fm[1].endsWith('.gz') ? 'application/gzip' : 'application/json' });
      if (state.flags.truncGz && fm[1] === 'oracle-cards.jsonl.gz') return res.end(fileMap[fm[1]].subarray(0, Math.floor(fileMap[fm[1]].length * 0.6)));
      return res.end(fileMap[fm[1]]);
    }
    if (p === '/scryfall/cards/search') {
      const query = q.get('q') || '';
      const exact = query.match(/!"([^"]+)"/);
      if (exact) {
        const data = PT_PAGES.flat().filter((c) => norm(c.name) === norm(exact[1]));
        if (!data.length) return json(404, { object: 'error', code: 'not_found', details: 'No cards found' });
        return json(200, { object: 'list', total_cards: data.length, has_more: false, data });
      }
      if (/lang:pt/.test(query)) {
        const pageNo = Number(q.get('page') || 1);
        if (state.flags.failPtPage && pageNo === state.flags.failPtPage) return json(500, { object: 'error', details: 'boom' });
        if (state.flags.failPtPageOnce && pageNo === state.flags.failPtPageOnce) {
          state.flags.failPtPageOnce = 0;
          return json(502, { object: 'error', details: 'transient' });
        }
        const data = PT_PAGES[pageNo - 1] || [];
        const hasMore = pageNo < PT_PAGES.length;
        const next = new URL(`${origin}/scryfall/cards/search`);
        for (const [k, v] of q) next.searchParams.set(k, v);
        next.searchParams.set('page', String(pageNo + 1));
        return json(200, { object: 'list', total_cards: PT_PAGES.flat().length, has_more: hasMore, ...(hasMore ? { next_page: next.toString() } : {}), data });
      }
      return json(404, { object: 'error', details: 'unsupported query in mock' });
    }
    if (p === '/scryfall/cards/named') {
      const want = norm(q.get('fuzzy') || q.get('exact') || '');
      let card = SCRY_CARDS.find((c) => norm(c.name) === want || (c.card_faces || []).some((f) => norm(f.name) === want));
      if (!card) {
        const ptHit = PT_PAGES.flat().find((c) => norm(c.printed_name) === want);
        if (ptHit) card = SCRY_CARDS.find((c) => c.name === ptHit.name);
      }
      if (!card && q.get('fuzzy') && want.length >= 4) {
        const hits = SCRY_CARDS.filter((c) => norm(c.name).startsWith(want));
        if (hits.length === 1) card = hits[0];
      }
      if (!card || card.layout === 'token') return json(404, { object: 'error', code: 'not_found', details: `No cards found matching "${q.get('fuzzy')}"` });
      return json(200, card);
    }

    // ---------- LigaMagic ----------
    if (p === '/liga/' || p === '/liga') {
      if (q.get('view') !== 'cards/search') {
        res.writeHead(404);
        return res.end('not found');
      }
      const k = norm(q.get('card'));
      if (k === 'blocked card') {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        return res.end('<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing. cf-chl</body></html>');
      }
      if (k === 'login form card') {
        // A normal (empty-result) page that mentions recaptcha in its login form: NOT a block.
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<html><head><title>LigaMagic</title><script src="https://www.google.com/recaptcha/api.js"></script></head><body><form class="login"><div class="g-recaptcha"></div></form><div id="search-results">Nenhum resultado</div></body></html>');
      }
      if (k === 'captcha card') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html><body><h1>Attention Required!</h1><div class="g-recaptcha">captcha</div></body></html>');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(LIGA[LIGA_ROUTES[k] || 'empty']);
    }

    // ---------- EDHREC ----------
    const vm = p.match(/^\/edhrec\/pages\/commanders\/omnath-locus-of-rage\/([a-z0-9-]+)\.json$/);
    if (vm) return EDHREC_OMNATH_PAGES[vm[1]] ? json(200, EDHREC_OMNATH_PAGES[vm[1]]) : json(403, { error: 'AccessDenied' });
    const am = p.match(/^\/edhrec\/pages\/average-decks\/([a-z0-9-]+)(\/[a-z0-9-]+)?\.json$/);
    if (am) return am[1] === 'omnath-locus-of-rage' && !am[2] ? json(200, EDHREC_OMNATH_AVG) : json(403, { error: 'AccessDenied' });
    const cm = p.match(/^\/edhrec\/pages\/combos\/([a-z0-9-]+)\.json$/);
    if (cm) return cm[1] === 'omnath-locus-of-rage' ? json(200, EDHREC_OMNATH_COMBOS) : json(403, { error: 'AccessDenied' });
    const km = p.match(/^\/edhrec\/pages\/cards\/([a-z0-9-]+)\.json$/);
    if (km) return EDHREC_CARD_PAGES[km[1]] ? json(200, EDHREC_CARD_PAGES[km[1]]) : json(403, { error: 'AccessDenied' });
    const em = p.match(/^\/edhrec\/pages\/commanders\/([a-z0-9-]+)\.json$/);
    if (em) {
      if (em[1] === 'omnath-locus-of-rage') return json(200, EDHREC_OMNATH);
      if (em[1] === 'loop-a') return json(200, { redirect: '/pages/commanders/loop-b.json' });
      if (em[1] === 'loop-b') return json(200, { redirect: '/pages/commanders/loop-c.json' });
      if (em[1] === 'loop-c') return json(200, { redirect: '/pages/commanders/loop-a.json' });
      if (em[1] === 'old-name') return json(200, { redirect: '/pages/commanders/omnath-locus-of-rage.json' });
      return json(404, { error: 'not found' });
    }
    return json(404, { detail: `mock-external: no route ${p}` });
  });
  return { server, state };
}

export async function startExternalMock(port = 0) {
  const { server, state } = createExternalMock();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    state,
    origin,
    env: {
      SCRYFALL_API_BASE: `${origin}/scryfall`,
      LIGAMAGIC_BASE: `${origin}/liga`,
      EDHREC_BASE: `${origin}/edhrec`,
      SCRYFALL_MIN_INTERVAL_MS: '0',
      LIGAMAGIC_MIN_INTERVAL_MS: '0',
      EDHREC_MIN_INTERVAL_MS: '0',
      SCRYFALL_RETRY_DELAY_MS: '0',
      LIGAMAGIC_BLOCK_COOLDOWN_MS: '0',
    },
    setFlags: (f) => fetch(`${origin}/__test/flags?${new URLSearchParams(Object.entries(f).map(([k, v]) => [k, String(v)]))}`),
    close: () => new Promise((r) => server.close(r)),
  };
}
