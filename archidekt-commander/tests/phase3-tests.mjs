// Phase 3: EDHREC triangulation, optimizer (local search), Monte Carlo goldfish, apply-after-approval.
// External services are the local mocks (tests/mock-external.mjs); Archidekt is tests/mock-server.mjs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDirs = [];
const tmp = (tag) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `archidekt-p3-${tag}-`));
  tmpDirs.push(d);
  return d;
};

export async function runPhase3(opts) {
  try {
    await phase3(opts);
  } finally {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  }
}

async function waitJob(proc, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    const r = await proc.call('cards_cache_status');
    if (r.json && !r.json.job.running && r.json.job.step === 'done') return r.json;
    if (Date.now() - t0 > timeoutMs) return r.json;
    await sleep(100);
  }
}

async function phase3({ McpProc, baseEnv, check, ext, mockState, archBase, MOCK_USER }) {
  const extLog = async () => (await fetch(`${ext.origin}/__test/log`)).json();
  const reset = () => fetch(`${ext.origin}/__test/reset`);
  const creds = { ARCHIDEKT_API_BASE: archBase, ARCHIDEKT_EMAIL: MOCK_USER.email, ARCHIDEKT_PASSWORD: MOCK_USER.password };

  // ---------------- pure units ----------------
  console.log('\n# Phase 3 units');
  const sim = await import('../server/simulate.mjs');
  {
    let s = 0;
    for (let k = 0; k <= 7; k++) s += sim.hyperPmf(99, 37, 7, k);
    check('hypergeometric pmf sums to 1', Math.abs(s - 1) < 1e-9, s);
    check('hypergeometric: P(≥1 of 1 copy in 7 of 99) = 7/99', Math.abs(sim.hyperRange(99, 1, 7, 1) - 7 / 99) < 1e-9);
    const a = sim.consistencyOdds({ lands: 30, ramp: 5, draw: 5, interaction: 5 });
    const b = sim.consistencyOdds({ lands: 37, ramp: 10, draw: 10, interaction: 8 });
    check('consistency odds grow with lands/ramp/draw', b.score > a.score && b.land4onT4 > a.land4onT4 && b.rampByT3 > a.rampByT3, { a, b });
    check('hypergeometric edge cases (K=0, n>N)', sim.hyperRange(99, 0, 7, 1) === 0 && sim.hyperPmf(5, 2, 7, 1) === 0);

    const r1 = sim.rng(7);
    const r2 = sim.rng(7);
    check('seeded RNG is deterministic', [1, 2, 3].every(() => r1() === r2()));
    const roles = (...r) => new Set(r);
    const info = (name, o = {}) => ({ name, isLand: !!o.land, isBasic: !!o.basic, mv: o.mv ?? 0, cost: o.cost ?? '', typeLine: o.type ?? (o.land ? 'Basic Land — Forest' : 'Sorcery'), text: o.text ?? '', roles: o.roles ?? roles(), produced: o.produced ?? (o.land ? ['G'] : []), etb: o.etb ?? null, qty: o.qty ?? 1 });
    const sol = sim.simCard(info('Sol Ring', { mv: 1, cost: '{1}', type: 'Artifact', text: '{T}: Add {C}{C}.', roles: roles('ramp') }), ['G']);
    const cult = sim.simCard(info('Cultivate', { mv: 3, cost: '{2}{G}', text: 'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.', roles: roles('ramp') }), ['G']);
    const dork = sim.simCard(info('Llanowar Elves', { mv: 1, cost: '{G}', type: 'Creature — Elf Druid', text: '{T}: Add {G}.', roles: roles('ramp') }), ['G']);
    check('simCard: Sol Ring = rock +2, Cultivate = land ramp + land to hand, elf = dork', sol.ramp === 2 && sol.rampKind === 'rock' && cult.rampKind === 'land' && cult.landToHand && dork.rampKind === 'dork' && dork.pips.G === 1, { sol, cult, dork });

    const deck = (lands, ramp) => {
      const c = [];
      for (let i = 0; i < lands; i++) c.push(sim.simCard(info(`Forest${i}`, { land: true }), ['G']));
      for (let i = 0; i < ramp; i++) c.push(cult);
      while (c.length < 99) c.push(sim.simCard(info(`Spell${c.length}`, { mv: 1 + (c.length % 6), cost: '{G}' }), ['G']));
      return c;
    };
    const cmd = sim.simCard(info('Cmdr', { mv: 4, cost: '{2}{G}{G}', type: 'Legendary Creature' }), ['G']);
    const g1 = sim.goldfish(deck(30, 4), cmd, { games: 1500, seed: 3, identity: ['G'] });
    const g1b = sim.goldfish(deck(30, 4), cmd, { games: 1500, seed: 3, identity: ['G'] });
    const g2 = sim.goldfish(deck(38, 10), cmd, { games: 1500, seed: 3, identity: ['G'] });
    check('goldfish deterministic with the same seed', JSON.stringify(g1) === JSON.stringify(g1b));
    check('goldfish: more lands+ramp → fewer screws, commander earlier, better score', g2.screwT4Pct < g1.screwT4Pct && g2.commanderOnCurvePct > g1.commanderOnCurvePct && sim.goldfishScore(g2) > sim.goldfishScore(g1), { g1, g2 });
    check('goldfish report fields', ['mulliganPct', 'landDropOnTimePct', 'avgMana', 'commanderOnCurvePct', 'rampByT3Pct', 'screwT4Pct', 'colorScrewT4Pct', 'floodT6Pct', 'stuckCardsT5', 'manaSpentByT6'].every((k) => k in g1) && g1.landDropOnTimePct.T1 >= g1.landDropOnTimePct.T5);
    const twoColor = sim.goldfish(deck(36, 0), sim.simCard(info('Cmdr', { mv: 4, cost: '{2}{R}{G}', type: 'Legendary Creature' }), ['R', 'G']), { games: 500, seed: 1, identity: ['R', 'G'] });
    check('goldfish: missing color (mono-G lands, RG commander) → color screw and commander never on curve', twoColor.colorScrewT4Pct === 100 && twoColor.commanderOnCurvePct === 0, twoColor);
  }

  {
    const edh = await import('../server/edhrec.mjs');
    check('card slug: front face first, every face as fallback', edh.slugOf('Fire // Ice') === 'fire' && edh.slugOf('Fire // Ice', { frontOnly: false }) === 'fire-ice' && edh.slugOf("Kodama's Reach") === 'kodamas-reach');
    const page = edh.compactCommanderPage({
      land: 37, panels: { taglinks: [{ slug: 'landfall', value: 'Landfall', count: 9 }, { value: 'no slug' }], mana_curve: { 2: 10, 3: 'x' } }, bracket_counts: { 2: 5 },
      container: { json_dict: { card: { num_decks: 100 }, cardlists: [{ header: 'Top Cards', cardviews: [{ name: 'A', synergy: 0.2, num_decks: 50, potential_decks: 100, lift: 1.234 }] }, { header: 'Creatures', cardviews: [{ name: 'A', synergy: 0.2, num_decks: 50, potential_decks: 100 }, { name: 'B', num_decks: 5 }] }] } },
    });
    check('compactCommanderPage: themes, curve, brackets, merged lists, inclusion', page.themes.length === 1 && page.themes[0].slug === 'landfall' && page.curve['2'] === 10 && !('3' in page.curve) && page.brackets['2'] === 5 && page.cards.length === 2 && page.cards[0][2] === 0.5 && page.cards[0][4].length === 2 && page.cards[0][5] === 1.23 && page.cards[1][2] === null, page);
    const avg = edh.compactAverageDeck({ deck: { cards: { Land: [['Forest', 20], ['bad']], Creature: [['X', 1]] } } });
    check('compactAverageDeck keeps quantities and type', avg.cards.length === 3 && avg.cards[0][1] === 20 && avg.cards[2][2] === 'Creature', avg);
    const cmb = edh.compactCombos({ container: { json_dict: { cardlists: [{ combo: { count: 3 }, cardviews: [{ name: 'A' }, { name: 'B' }] }, { cardviews: [{ name: 'B' }, { name: 'A' }] }, { cardviews: [{ name: 'Solo' }] }] } } });
    check('compactCombos dedupes and skips 1-card lists', cmb.combos.length === 1 && cmb.combos[0].decks === 3, cmb);
    const cp = edh.compactCardPage({ container: { json_dict: { card: { name: 'Z', num_decks: 10, potential_decks: 40, salt: 1.2345 }, cardlists: [{ header: 'Top Commanders', cardviews: [{ name: 'C', num_decks: 1, potential_decks: 4 }] }] } } });
    check('compactCardPage: inclusion inputs, salt, top commanders', cp.numDecks === 10 && cp.potentialDecks === 40 && cp.salt === 1.23 && cp.topCommanders[0][1] === 0.25, cp);
  }

  {
    const { optimize } = await import('../server/optimizer.mjs');
    const mk = (name, o = {}) => ({
      info: { name, isLand: !!o.land, isBasic: !!o.basic, mv: o.mv ?? 2, cost: o.cost ?? '{1}{G}', roles: new Set(o.roles || []), produced: o.produced ?? (o.land ? ['G'] : []), gc: !!o.gc },
      eval: { value: o.value ?? 50, name },
      qty: o.qty ?? 1,
    });
    const deck = [mk('Forest', { land: true, basic: true, qty: 36, value: 50 })];
    for (let i = 0; i < 55; i++) deck.push(mk(`Filler ${i}`, { value: 45, mv: 2 + (i % 4) }));
    for (let i = 0; i < 8; i++) deck.push(mk(`Ramp ${i}`, { roles: ['ramp'], value: 60 }));
    deck.push(mk('Pet Card', { value: 10, mv: 7 }));
    const pool = [mk('Great Ramp', { roles: ['ramp'], value: 70 }), mk('Nice Draw', { roles: ['draw'], value: 65 }), mk('Big GC', { roles: ['draw'], value: 95, gc: true }), mk('Dual', { land: true, value: 70, produced: ['G'] }), mk('Weak', { value: 20 })];
    const r = optimize(deck, pool, { maxSwaps: 10, identity: ['G'], targetBracket: 3, locked: new Set(['pet card']) });
    const outs = r.swaps.map((s) => s.out.name);
    const ins = r.swaps.map((s) => s.in.name);
    check('optimizer: improves the objective and never touches locked cards', r.after.score > r.before.score && !outs.includes('Pet Card') && r.swaps.every((s) => s.gain >= 2), r);
    check('optimizer: fills role gaps (ramp/draw) and skips weak candidates', ins.includes('Great Ramp') && ins.includes('Nice Draw') && !ins.includes('Weak'), ins);
    check('optimizer: lands stay inside the land range', r.lands >= r.landRange[0] && r.lands <= r.landRange[1], { lands: r.lands, range: r.landRange });
    check('optimizer: a card added is never removed again, no duplicates', new Set(ins).size === ins.length && !ins.some((n) => outs.includes(n)));
    const r2 = optimize(deck, pool, { maxSwaps: 10, identity: ['G'], targetBracket: 2 });
    check('optimizer: bracket 2 → no Game Changer comes in; bracket 4 → allowed', !r2.swaps.some((s) => s.in.name === 'Big GC') && optimize(deck, pool, { maxSwaps: 10, identity: ['G'], targetBracket: 4 }).swaps.some((s) => s.in.name === 'Big GC'));
    const r3 = optimize(deck, pool, { maxSwaps: 10, identity: ['G'], minGain: 1e6 });
    check('optimizer: minGain stops the search', r3.swaps.length === 0 && r3.after.score === r3.before.score);
    const r4 = optimize(deck, pool, { maxSwaps: 1, identity: ['G'] });
    check('optimizer: maxSwaps respected; swap explains its gain', r4.swaps.length === 1 && ['value', 'roles', 'curve', 'colors', 'consistency'].every((k) => k in r4.swaps[0].parts));
    // color identity is a hard rule even if an off-color card slips into the candidate list
    const black = mk('Great Black Draw', { roles: ['draw', 'ramp'], value: 99 });
    black.info.ci = 'B';
    const blue = mk('Blue Ramp', { roles: ['ramp'], value: 98 });
    blue.info.ci = 'U';
    const r5 = optimize(deck, [...pool, black, blue], { maxSwaps: 10, identity: ['R', 'G'], deckIdentity: 'RG' });
    check('optimizer: off-color candidates (B / U in an RG deck) never come in', !r5.swaps.some((s) => ['Great Black Draw', 'Blue Ramp'].includes(s.in.name)) && r5.swaps.length > 0, r5.swaps.map((s) => s.in.name));
    const { roleTargets } = await import('../server/optimizer.mjs');
    const t = roleTargets({ ramp: 20, removal: 4 });
    check('role targets: EDHREC average only nudges (ramp 20 → ~13-15, removal floor 80%)', t.ramp[0] >= 12 && t.ramp[0] <= 15 && t.removal[0] >= 7, t);
  }

  {
    const fl = await import('../server/fluidity.mjs');
    const cm = await import('../server/commander.mjs');
    check('identity: B card not allowed in RG; colorless allowed; unknown deck identity allows only colorless', !cm.withinIdentity('B', 'RG') && cm.withinIdentity('', 'RG') && cm.withinIdentity(['Red'], 'RG') && !cm.withinIdentity('G', null) && cm.withinIdentity('', null));
    const I = (name, o = {}) => ({ name, isLand: false, mv: o.mv ?? 2, cost: o.cost ?? '{1}{G}', typeLine: o.type ?? 'Sorcery', text: o.text ?? '', roles: new Set(o.roles || []), instant: !!o.instant, qty: 1 });
    const cheapRamp = fl.cardFluidity(I('Rampant Growth', { roles: ['ramp'] }), ['G']);
    const fatty = fl.cardFluidity(I('Colossal Dreadmaw', { mv: 6, cost: '{4}{G}{G}', type: 'Creature' }), ['G']);
    const heavy = fl.cardFluidity(I('Heavy', { mv: 3, cost: '{G}{G}{G}', roles: ['removal'] }), ['W', 'U', 'G']);
    check('card fluidity: cheap ramp ≫ vanilla 6-drop; heavy pips penalized', cheapRamp.score > 0.7 && fatty.score < 0.3 && heavy.why.some((w) => /custo de cor pesado/.test(w)), { cheapRamp, fatty, heavy });
    const lp = fl.landPlan({ avgMv: 3.6, cheapRamp: 4 });
    const lp2 = fl.landPlan({ avgMv: 2.4, cheapRamp: 12 });
    const lp3 = fl.landPlan({ avgMv: 3, edhAvg: 42 });
    check('land plan: own model (curve, cheap ramp), EDHREC only nudges', lp.center > lp2.center && lp3.center <= 38 && lp3.center >= 36, { lp, lp2, lp3 });
    const deckF = fl.deckFluidity([I('A', { roles: ['ramp'] }), I('B', { mv: 7 }), { ...I('L'), isLand: true }], { identity: ['G'], sources: { G: 10 }, lands: 1, size: 99, commanders: [I('Cmdr', { mv: 4, cost: '{2}{G}{G}' })] });
    check('deck fluidity: early plays, dead top end, color requirement with the commander', deckF.earlyPlays.count === 1 && deckF.deadTopEnd.cards.includes('B') && deckF.colorRequirements[0]?.commander === true && deckF.colorRequirements[0].prob < 0.8, deckF);
    const g = sim.goldfish(Array.from({ length: 99 }, (_, i) => sim.simCard(i < 37 ? { name: `F${i}`, isLand: true, mv: 0, roles: new Set(), produced: ['G'], typeLine: 'Basic Land — Forest' } : { name: `S${i}`, isLand: false, mv: 1 + (i % 5), cost: '{G}', roles: new Set(i % 7 === 0 ? ['draw'] : []), text: i % 7 === 0 ? 'Draw two cards.' : '', typeLine: 'Sorcery', produced: [] }, ['G'])), null, { games: 300, seed: 5, identity: ['G'] });
    check('goldfish fluidity metrics (dead turns, wasted mana, cards seen)', ['deadTurnsT2toT5', 'wastedManaT2toT6', 'cardsSeenByT6', 'outOfGasT6Pct'].every((k) => typeof g[k] === 'number') && g.cardsSeenByT6 > 12, g);
  }

  // ---------------- end-to-end ----------------
  console.log('\n# Phase 3 end-to-end (triangulate / optimize / apply / simulate)');
  await reset();
  const h = tmp('opt');
  const p = new McpProc(baseEnv({ ...creds, ARCHIDEKT_HOME: h }));
  try {
    await p.init();
    let r = await p.call('deck_optimize', { deckId: 1003 });
    check('deck_optimize without card cache → clear error and starts the cache job', r.isError && /cache local/.test(r.text), r.text);
    await waitJob(p);

    const n0 = (await extLog()).filter((x) => x.path.startsWith('/edhrec')).length;
    r = await p.call('deck_triangulate', { deckId: 1003, targetBracket: 2 });
    const t = r.json || {};
    const by = Object.fromEntries((t.cards || []).map((c) => [c.name, c]));
    check('triangulate: sources (commander, theme, bracket, average deck, combos)', t.sources?.commander?.decks === 5000 && t.sources.theme?.slug === 'landfall' && t.sources.bracket?.slug === 'core' && t.sources.averageDeck?.cards > 0 && t.sources.combos === 1, t.sources);
    check('triangulate: theme detected by affinity (landfall over elementals/tokens)', t.theme?.detected?.slug === 'landfall' && t.theme.ranking[0].slug === 'landfall' && t.theme.ranking.length === 3, t.theme);
    check('triangulate: Lotus Cobra is core/synergy with high confidence', ['nucleo', 'sinergia'].includes(by['Lotus Cobra']?.verdict) && by['Lotus Cobra'].confidence !== 'baixa' && by['Lotus Cobra'].value >= 60, by['Lotus Cobra']);
    check('triangulate: Dreadmaw doubtful/cut, valued below Cobra', ['duvidosa', 'corte'].includes(by['Colossal Dreadmaw']?.verdict) && by['Colossal Dreadmaw'].value < by['Lotus Cobra'].value, by['Colossal Dreadmaw']);
    check('triangulate: Game Changer flagged as cut at bracket 2', by['The One Ring']?.verdict === 'corte' && /Game Changer/.test(by['The One Ring'].why), by['The One Ring']);
    check('triangulate: each card has votes, components and reasons', (t.cards || []).filter((c) => c.verdict !== 'terreno').every((c) => c.votes && c.components && typeof c.why === 'string' && ['alta', 'média', 'baixa'].includes(c.confidence)), t.cards?.[0]);
    check('triangulate: lands evaluated as lands (tapped land penalized)', by['Temple of Abandon']?.verdict === 'terreno' && /entra virado/.test(by['Temple of Abandon'].why), by['Temple of Abandon']);
    check('triangulate: summary + verdict counts in PT', Array.isArray(t.summary) && /Tema detectado: Landfall/.test(t.summary.join(' ')) && Object.keys(t.verdicts || {}).length > 0, t.summary);
    const log1 = (await extLog()).filter((x) => x.path.startsWith('/edhrec')).slice(n0).map((x) => x.path);
    check('triangulate deep: card pages fetched for doubtful cards only', log1.some((x) => x.includes('/cards/colossal-dreadmaw')) && !log1.some((x) => x.includes('/cards/lotus-cobra')), log1);
    check('triangulate deep: card page evidence used (global inclusion)', /de todos os decks das suas cores/.test(by['Colossal Dreadmaw']?.why || ''), by['Colossal Dreadmaw']);
    r = await p.call('deck_triangulate', { deckId: 1003, targetBracket: 2, onlyVerdicts: ['nucleo'] });
    const n1 = (await extLog()).filter((x) => x.path.startsWith('/edhrec')).length;
    const log2 = (await extLog()).filter((x) => x.path.startsWith('/edhrec')).slice(n0 + log1.length).map((x) => x.path);
    check('triangulate: commander pages live again, card pages from the 7-day disk cache', log2.some((x) => x.includes('/commanders/omnath-locus-of-rage')) && !log2.some((x) => x.includes('/cards/colossal-dreadmaw')) && fs.existsSync(path.join(h, 'data', 'edhrec', 'cards', 'colossal-dreadmaw.json')) && !fs.existsSync(path.join(h, 'data', 'edhrec', 'omnath-locus-of-rage.json')) && (r.json?.cards || []).every((c) => c.verdict === 'nucleo'), { n0, n1, log2 });
    r = await p.call('deck_triangulate', { deckId: 1003, theme: 'Elementals' });
    check('triangulate: forced theme by name', r.json?.theme?.detected?.slug === 'elementals' && !r.json.sources.bracket, r.json?.theme);
    r = await p.call('deck_triangulate', { deckId: 1003, mode: 'xyz' });
    check('triangulate: bad mode → error', r.isError, r.text);
    r = await p.call('deck_triangulate', { deckId: 2001 });
    check('triangulate: commander without EDHREC page → still works (function/text/rank)', !r.isError && r.json?.sources?.commander?.found === false && Array.isArray(r.json.cards), r.text.slice(0, 300));

    r = await p.call('deck_optimize', { deckId: 1003, targetBracket: 2, maxSwaps: 6 });
    const o = r.json || {};
    const ins = (o.swaps || []).map((s) => s.in.name);
    const outs = (o.swaps || []).map((s) => s.out.name);
    check('optimize: proposes swaps with gains, reasons and an apply object (no plan id)', o.swaps?.length > 0 && o.swaps.every((s) => s.gain >= 2 && s.out.why && s.in.why && s.gainParts) && !('planId' in o) && o.apply?.swaps?.length === o.swaps.length && o.apply.swaps.every((x) => x.out && x.in), o);
    check('optimize: Game Changer leaves at bracket 2; no GC / banned / off-color comes in', outs.includes('The One Ring') && !ins.some((n) => ['Mana Crypt', 'Demonic Tutor', 'The One Ring', 'Counterspell'].includes(n)), { ins, outs });
    check('optimize: 2-card combo blocked at bracket 2 (Ooze + Eternal Witness)', !ins.includes('Scavenging Ooze'), ins);
    check('optimize: before/after objective and simulation reported', o.objective?.after?.score >= o.objective?.before?.score && o.simulation?.before?.score != null && o.simulation.after.games === 2000 && /Simulação/.test(o.summary?.[1] || ''), { obj: o.objective, sim: o.simulation });
    check('optimize: deck NOT changed', mockState.decks.get(1003).cards.some((c) => c.card.oracleCard.name === 'The One Ring'));
    check('optimize: nothing saved on disk (no plans folder)', !fs.existsSync(path.join(h, 'data', 'plans')));
    check('optimize: candidate sources listed (EDHREC lists / cache search)', o.swaps.every((s) => Array.isArray(s.in.sources) && s.in.sources.length > 0), o.swaps?.map((s) => s.in.sources));

    r = await p.call('deck_optimize', { deckId: 1003, targetBracket: 2, maxSwaps: 6, lock: ['The One Ring'], exclude: ['Cultivar'] });
    check('optimize: lock (EN) and exclude (PT name) respected', !(r.json?.swaps || []).some((s) => s.out.name === 'The One Ring' || s.in.name === 'Cultivate'), r.json?.swaps?.map((s) => `${s.out.name}>${s.in.name}`));
    r = await p.call('deck_optimize', { deckId: 1003, targetBracket: 4, maxSwaps: 6 });
    check('optimize: bracket 4 allows the combo piece / keeps the Game Changer', !(r.json?.swaps || []).some((s) => s.out.name === 'The One Ring'), r.json?.swaps?.map((s) => `${s.out.name}>${s.in.name}`));
    r = await p.call('deck_optimize', { deckId: 1003, targetBracket: 2, minGain: 1e6 });
    check('optimize: huge minGain → only the mandatory bracket swap remains', r.json?.swaps?.length === 1 && /obrigatória/.test(r.json.swaps[0].forcedBy || '') && r.json.swaps[0].out.name === 'The One Ring', r.json?.swaps);
    r = await p.call('deck_optimize', { deckId: 1003, targetBracket: 4, minGain: 1e6 });
    check('optimize: nothing good enough → no apply object', r.json?.swaps?.length === 0 && !r.json.apply, r.text.slice(0, 300));
    r = await p.call('deck_optimize', { deckId: 1003, targetBracket: 2, maxSwaps: 3, lock: ['The One Ring'] });
    check('optimize: locked card above the bracket stays, with a note', !(r.json?.swaps || []).some((s) => s.out.name === 'The One Ring') && r.json.notes.some((n) => /lock/.test(n)), r.json?.notes);

    // apply (the swaps come back from the optimizer's answer; nothing is read from disk)
    r = await p.call('deck_optimize_apply', { deckId: 1003, swaps: o.apply.swaps });
    check('apply without confirm → refused', r.isError && /confirm/.test(r.text), r.text);
    r = await p.call('deck_optimize_apply', { deckId: 1003, confirm: true, swaps: [{ out: 'Colossal Dreadmaw' }] });
    check('apply with an incomplete swap → error', r.isError && /out.*in|in.*out/.test(r.text), r.text);
    r = await p.call('deck_optimize_apply', { deckId: 1003, confirm: true, swaps: [{ out: 'Colossal Dreadmaw', in: 'Counterspell' }] });
    check('apply: off-color incoming card skipped', (r.json?.skipped || []).some((x) => /identidade de cor/.test(x.reason)) && (r.json.applied || []).length === 0, r.text.slice(0, 400));
    r = await p.call('deck_optimize_apply', { deckId: 1003, confirm: true, swaps: [o.apply.swaps[0]] });
    const a = r.json || {};
    const deckNow = mockState.decks.get(1003).cards.filter((c) => !c.deletedAt).map((c) => c.card.oracleCard.name);
    check('apply: one swap applied (remove + add), verified, undo returned, nothing on disk', a.applied?.length === 2 && /verified/.test(JSON.stringify(a.verification)) && deckNow.includes(o.swaps[0].in.name) && Array.isArray(a.undo) && a.undo.length >= 2 && !fs.existsSync(path.join(h, 'data', 'snapshots')), a);
    r = await p.call('deck_optimize_apply', { deckId: 1003, confirm: true, swaps: [o.apply.swaps[0]] });
    check('apply again: stale swap skipped, nothing applied', r.json?.skipped?.length === 1 && (r.json.applied || []).length === 0, r.text.slice(0, 400));
    r = await p.call('deck_optimize_apply', { deckId: 1003, confirm: true, swaps: [{ out: 'Mountain', in: 'Forest' }] });
    check('apply: a basic land may come in even if already in the deck', (r.json?.applied || []).length === 2 && !(r.json.skipped || []).length, r.text.slice(0, 400));

    // simulate
    r = await p.call('deck_simulate', { deckId: 1003, games: 500 });
    check('simulate: report + assumptions', r.json?.simulation?.games === 500 && typeof r.json.simulation.score === 'number' && /mulligan/.test(r.json.assumptions), r.text.slice(0, 300));
    r = await p.call('deck_simulate', { deckId: 1003, games: 500, remove: ['Floresta', 'Forest', 'Forest'], add: ['Cultivate', 'Rampant Growth', 'Carta Inexistente'] });
    check('simulate what-if: delta and ignored names', typeof r.json?.whatIf?.delta === 'number' && r.json.whatIf.ignored?.length >= 1, r.json?.whatIf);
    r = await p.call('deck_simulate', { deckId: 1003, games: 300, remove: ['Mountain'], add: ['Forest'] });
    check('simulate what-if: swapping one basic for another keeps the card count', r.json?.whatIf?.cards === r.json?.deck?.count, r.json?.whatIf);
    r = await p.call('deck_simulate', { deckId: 1003, games: 10 });
    check('simulate: games below minimum → error', r.isError, r.text);
    r = await p.call('deck_simulate', { deckId: 1003, games: 300, add: ['Demonic Tutor'] });
    check('simulate what-if: off-color card ignored', (r.json?.whatIf?.ignored || []).some((x) => /identidade de cor|fora do cache/.test(x)), r.json?.whatIf);

    // color identity guard on writes
    r = await p.call('archidekt_update_deck_cards', { deckId: 1003, changes: [{ action: 'add', cardName: 'Counterspell', category: 'Draw' }] });
    check('write guard: off-color card refused in the main deck (Counterspell in RG)', (r.json?.applied || []).length === 0 && /identidade de cor/.test(r.json?.stoppedAt?.error || '') && !mockState.decks.get(1003).cards.some((c) => !c.deletedAt && c.card.oracleCard.name === 'Counterspell'), r.text);
    r = await p.call('archidekt_update_deck_cards', { deckId: 1003, changes: [{ action: 'add', cardName: 'Counterspell', category: 'Maybeboard' }] });
    check('write guard: Maybeboard still accepts any card', !r.isError && r.json?.applied?.length === 1, r.text.slice(0, 300));
    r = await p.call('deck_optimize', { deckId: 1003, targetBracket: 4, maxSwaps: 8 });
    check('optimize: every suggestion inside the commander identity (RG)', r.json?.colorIdentity === 'RG' && (r.json.swaps || []).every((s) => !['Counterspell', 'Demonic Tutor'].includes(s.in.name)), r.json?.swaps?.map((s) => s.in.name));
  } finally {
    await p.close();
  }
}
