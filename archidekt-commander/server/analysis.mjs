// Deck analysis: roles vs targets, mana, fluidity (does the deck run smoothly?), synergy, power/bracket,
// per-card scores. The deck's own model decides; EDHREC is only a reference.
// Pure functions: callers pass the parsed deck, a cache lookup and EDHREC data.

import { oracleText } from './commander.mjs';
import { cardFluidity, deckFluidity, landPlan } from './fluidity.mjs';
import { CORE_ROLES, etbTapped, oTagRoles, pips, producedColors, textRoles } from './roles.mjs';
import { normName } from './store.mjs';

export const ROLE_TARGETS = {
  ramp: [10, 12],
  draw: [10, 12],
  removal: [8, 10],
  wipe: [2, 4],
  protection: [2, 5],
  recursion: [2, 5],
  'gy-hate': [0, 3],
  tutor: [0, 4],
  counter: [0, 6],
};
const ROLE_PT = {
  ramp: 'ramp', draw: 'compra', removal: 'remoção', wipe: 'board wipe', protection: 'proteção', recursion: 'recursão',
  'gy-hate': 'graveyard hate', tutor: 'tutor', counter: 'counter', tokens: 'tokens', landfall: 'landfall', 'sac-outlet': 'sac outlet',
  wincon: 'finalizador', anthem: 'anthem', evasion: 'evasão', lifegain: 'ganho de vida', burn: 'dano direto',
};
export const rolePt = (r) => ROLE_PT[r] || r;

const THEMES = [
  ['landfall', /landfall|land enters|lands? you control|additional land|land cards?|play lands?|lands? matter|earthbend/],
  ['tokens', /\btokens?\b/],
  ['counters', /\+1\/\+1 counters?|proliferate|one or more counters|counters? would be put|twice that many|additional \+1\/\+1/],
  ['sacrifice', /sacrifice|\bdies\b|leaves the battlefield/],
  ['graveyard', /graveyard/],
  ['artifacts', /\bartifacts?\b/],
  ['enchantments', /\benchantments?\b|\bauras?\b/],
  ['equipment', /\bequip|equipment|equipped/],
  ['spells', /instant|sorcery|noncreature spell/],
  ['lifegain', /gains? (\w+ )?life|lifelink/],
  ['draw', /draws? (a|two|\w+) cards?/],
  ['combat', /attacks?|combat damage/],
  ['flying', /\bflying\b/],
  ['legendary', /\blegendary\b/],
  ['elementals', /\belementals?\b/],
];

/** Theme names whose pattern matches a text (e.g. the user's plan). */
export function themesOf(text) {
  const t = String(text || '').toLowerCase();
  return THEMES.filter(([, re]) => re.test(t)).map(([n]) => n);
}

const TYPE_ORDER = ['land', 'creature', 'planeswalker', 'battle', 'instant', 'sorcery', 'artifact', 'enchantment'];

function mainType(typeLine) {
  const t = String(typeLine || '').toLowerCase().split('//')[0];
  return TYPE_ORDER.find((x) => new RegExp(`\\b${x}\\b`).test(t)) || 'other';
}

function powerOf(p) {
  if (p == null || p === '') return null;
  const n = parseInt(String(p), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Merge Archidekt oracle data + cache record into a flat card info. */
export function cardInfo(row, rec) {
  const o = row.oracle || {};
  const faces = Array.isArray(o.faces) && o.faces.length > 1 && !o.text ? o.faces : null;
  const text = (faces ? faces.map((f) => f?.text || '').join('\n//\n') : oracleText(o)) || rec?.text || '';
  // The cache's type line keeps " // " between faces, which textRoles uses per face.
  const typeLine = (rec?.type && (faces || !row.type) ? rec.type : row.type) || rec?.type || '';
  const lower = text.toLowerCase();
  const roles = new Set([...textRoles(text, typeLine, row.name), ...oTagRoles(o.oTags), ...(rec?.roles || [])]);
  // Archidekt's "tutor" flag also marks land searches (Cultivate…), which are ramp, not tutors.
  const landSearchOnly = /search your library/i.test(text) && !/search your library for (a|an|up to (one|two|three)|any) (?!(basic|snow|nonbasic)\b)(?!lands?\b)(?!(forest|plains|island|swamp|mountain)s?\b)[^.]*?cards?/i.test(text);
  if (o.tutor && !landSearchOnly) roles.add('tutor');
  const isLand = /\bland\b/i.test(String(typeLine).split('//')[0]);
  if (isLand) roles.delete('ramp');
  const kw = (o.keywords?.length ? o.keywords : rec?.kw || []).map((k) => String(k).toLowerCase());
  const tags = rec?.tags || [];
  return {
    name: row.name,
    qty: Number(row.qty) > 0 ? Number(row.qty) : 0,
    // Numbers only: a missing/odd value must never turn a score into NaN.
    mv: [row.mv, rec?.mv].map(Number).find((x) => Number.isFinite(x) && x >= 0) ?? 0,
    cost: o.manaCost || rec?.cost || '',
    typeLine,
    type: mainType(typeLine),
    text,
    roles,
    isLand,
    isBasic: isLand && /\bbasic\b/i.test(typeLine),
    instant: /\binstant\b/i.test(typeLine) || kw.includes('flash') || /(^|\n)flash\b/i.test(text),
    gc: !!(o.gameChanger ?? rec?.gc),
    salt: typeof o.salt === 'number' ? o.salt : null,
    rank: o.edhrecRank ?? rec?.rank ?? null,
    extraTurn: !!o.extraTurns || /take an extra turn/i.test(text),
    mld: !!o.massLandDenial || /destroy all lands|each player sacrifices (all|x|\w+) lands|lands don't untap/i.test(text),
    combos: (o.twoCardComboIds || []).map((x) => (x && typeof x === 'object' ? x.id : x)).filter((x) => x != null),
    produced: producedColors({ text, typeLine, manaProduction: o.manaProduction }),
    etb: isLand ? etbTapped(text) : null,
    artEnch: /(destroy|exile) (target|all|each|up to (one|two) target) (artifact|enchantment|nonland permanent|permanent|nonland|noncreature|artifacts|enchantments)/i.test(text) ||
      /(artifact|enchantment)-removal|removal-(artifact|enchantment)/.test(tags.join(' ')),
    edict: /(target player|target opponent|each opponent|each player) sacrifices (a|an|two) (creature|attacking|nonland|permanent)/i.test(lower),
    subtypes: (o.subTypes || []).map((s) => String(s).toLowerCase()),
    // power of a creature (null when not a creature or unknown, "*" counts as 0)
    power: powerOf(o.power ?? (rec?.pt ? String(rec.pt).split('/')[0] : null)),
    inCache: !!rec,
    // color identity letters ('' = colorless, null = unknown): Scryfall cache first, then Archidekt
    ci: rec?.ci != null ? rec.ci : row.colorIdentity != null ? (row.colorIdentity === 'C' ? '' : row.colorIdentity) : null,
  };
}

/**
 * Themes of the deck's plan: the commander's own text (Archidekt oracle, or the local cache via lookup),
 * the user's plan, and — independent of any external site — the themes the deck's own cards already
 * share (≥ 10 nonland cards and ≥ 16% of them). deckCards: card infos (optional).
 */
export function commanderThemes(commanders, plan, { lookup = null, deckCards = null } = {}) {
  const out = new Set();
  const sub = new Set();
  for (const c of commanders) {
    const t = `${oracleText(c.oracle) || (lookup ? lookup(c.name)?.text || '' : '')}`.toLowerCase();
    for (const [name, re] of THEMES) if (re.test(t)) out.add(name);
    for (const s of c.oracle?.subTypes || []) sub.add(String(s).toLowerCase());
  }
  if (plan) for (const [name, re] of THEMES) if (re.test(String(plan).toLowerCase())) out.add(name);
  const fromDeck = [];
  if (deckCards?.length) {
    const nl = deckCards.filter((c) => !c.isLand && !c.isCommander);
    for (const [name, re] of THEMES) {
      if (['draw', 'combat', 'legendary', 'flying'].includes(name)) continue; // too generic to be a plan
      const n = nl.filter((c) => re.test(`${c.text}\n${c.typeLine}`.toLowerCase())).reduce((x, c) => x + (c.qty || 1), 0);
      if (n >= 10 && n >= nl.length * 0.16) {
        fromDeck.push(name);
        out.add(name);
      }
    }
  }
  return { themes: [...out], subtypes: [...sub], fromDeck };
}

export function heuristicSynergy(info, th) {
  if (!th.themes.length) return 0;
  const hay = `${info.text}\n${info.typeLine}`.toLowerCase();
  let hits = th.themes.filter((name) => THEMES.find((x) => x[0] === name)[1].test(hay)).length;
  if (th.themes.includes('landfall') && (info.roles.has('ramp') || info.roles.has('landfall'))) hits += 1;
  if (th.themes.includes('tokens') && info.roles.has('tokens')) hits += 1;
  if (info.subtypes.some((s) => th.subtypes.includes(s) && !['human', 'legendary'].includes(s))) hits += 1;
  return Math.min(1, hits / Math.min(3, Math.max(1, th.themes.length)));
}

/** Land range from the deck's own curve, cheap ramp and plan (see fluidity.landPlan). */
export function landTarget(avgMv, themes, cheapRamp = 0) {
  return landPlan({ avgMv, themes, cheapRamp }).range;
}

/** Estimated bracket from simple rules. */
export function estimateBracket({ gc, tutors, extraTurns, mld, combos }) {
  const reasons = [];
  let b = 2;
  if (gc > 0) {
    b = Math.max(b, 3);
    reasons.push(`${gc} Game Changer(s)`);
  }
  if (tutors > 2) {
    b = Math.max(b, 3);
    reasons.push(`${tutors} tutores`);
  }
  if (combos > 0) {
    b = Math.max(b, 3);
    reasons.push(`${combos} combo(s) de 2 cartas`);
  }
  if (extraTurns === 1) reasons.push('1 carta de turno extra');
  if (gc > 3) {
    b = 4;
    reasons.push('mais de 3 Game Changers');
  }
  if (mld) {
    b = 4;
    reasons.push('destruição em massa de terrenos');
  }
  if (extraTurns >= 2) {
    b = 4;
    reasons.push(`${extraTurns} cartas de turno extra (encadeamento)`);
  }
  if (!reasons.length) reasons.push('sem Game Changers, combos de 2 cartas, MLD ou turnos extras');
  return { bracket: b, reasons };
}

/**
 * Full analysis. deck = parseDeck() output; lookup(name) → cache record | null;
 * edh = EDHREC commanderPage() result (or {found:false}).
 */
export function analyzeDeck(deck, { lookup = () => null, edh = { found: false, cards: new Map(), typeMix: {} }, targetBracket = null, plan = null, evaluations = null } = {}) {
  const main = deck.rows.filter((r) => r.included);
  const commanders = main.filter((r) => r.isCommander);
  // aggregate rows by card name
  const byName = new Map();
  for (const r of main) {
    const k = normName(r.name);
    if (byName.has(k)) byName.get(k).qty += Number(r.qty) > 0 ? Number(r.qty) : 0;
    else {
      const info = cardInfo(r, lookup(r.name));
      byName.set(k, { ...info, isCommander: r.isCommander, category: r.category });
    }
  }
  const th = commanderThemes(commanders, plan, { lookup, deckCards: [...byName.values()] });
  const cards = [...byName.values()];
  const others = cards.filter((c) => !c.isCommander);
  const nonland = cards.filter((c) => !c.isLand);
  const lands = cards.filter((c) => c.isLand);
  const sum = (arr) => arr.reduce((s, c) => s + c.qty, 0);

  // ---- roles
  const roles = {};
  for (const role of Object.keys(ROLE_TARGETS)) {
    const list = others.filter((c) => c.roles.has(role));
    const [min, max] = ROLE_TARGETS[role];
    const count = sum(list);
    roles[role] = { count, target: `${min}-${max}`, status: count < min ? 'baixo' : count > max ? 'alto' : 'ok', cards: list.map((c) => c.name) };
  }
  for (const role of ['tokens', 'landfall', 'sac-outlet', 'wincon']) {
    const list = others.filter((c) => c.roles.has(role));
    roles[role] = { count: sum(list), cards: list.map((c) => c.name) };
  }

  // ---- mana
  const nonlandMain = nonland.filter((c) => !c.isCommander);
  const avgMv = nonland.length ? Math.round((nonland.reduce((s, c) => s + c.mv * c.qty, 0) / Math.max(1, sum(nonland))) * 100) / 100 : 0;
  const curve = {};
  for (const c of nonland) {
    const b = c.mv >= 7 ? '7+' : String(Math.floor(c.mv));
    curve[b] = (curve[b] || 0) + c.qty;
  }
  const landCount = sum(lands);
  const cheapRamp = sum(nonlandMain.filter((c) => c.roles.has('ramp') && c.mv <= 2));
  const lt = landPlan({ avgMv, themes: th.themes, cheapRamp, edhAvg: edh.found ? edh.typeMix?.land : null }).range;
  const pipTotals = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const c of nonland) {
    const p = pips(c.cost);
    for (const k of Object.keys(p)) pipTotals[k] += p[k] * c.qty;
  }
  const identity = deck.identity && deck.identity !== 'C' ? [...deck.identity] : [];
  const sources = Object.fromEntries(identity.map((k) => [k, 0]));
  for (const c of cards) {
    if (!(c.isLand || (c.roles.has('ramp') && c.produced.length))) continue;
    for (const k of c.produced) if (k in sources) sources[k] += c.qty;
  }
  for (const k of Object.keys(pipTotals)) pipTotals[k] = Math.round(pipTotals[k] * 10) / 10;
  const tapped = lands.filter((c) => c.etb === 'tapped').map((c) => c.name);
  const conditional = lands.filter((c) => c.etb === 'conditional').map((c) => c.name);

  // ---- interaction, power
  const removal = others.filter((c) => c.roles.has('removal') || c.roles.has('wipe'));
  const instantRemoval = removal.filter((c) => c.instant);
  const gcCards = others.filter((c) => c.gc).map((c) => c.name).concat(commanders.filter((c) => c.gc).map((c) => c.name));
  const tutors = others.filter((c) => c.roles.has('tutor'));
  const extra = cards.filter((c) => c.extraTurn).map((c) => c.name);
  const mld = cards.filter((c) => c.mld).map((c) => c.name);
  const comboMap = new Map();
  for (const c of cards) for (const id of c.combos) {
    if (!comboMap.has(id)) comboMap.set(id, new Set());
    comboMap.get(id).add(c.name);
  }
  const combos = [...comboMap.entries()].filter(([, s]) => s.size >= 2).map(([id, s]) => ({ id, cards: [...s] }));
  const est = estimateBracket({ gc: gcCards.length, tutors: sum(tutors), extraTurns: extra.length, mld: mld.length > 0, combos: combos.length });
  const salts = nonlandMain.map((c) => c.salt).filter((x) => typeof x === 'number');
  const saltAvg = salts.length ? Math.round((salts.reduce((s, x) => s + x, 0) / salts.length) * 100) / 100 : null;

  // ---- fluidity: early plays, top end, color requirements, card flow, mana sinks
  const fluidity = deckFluidity(others, { commanders, identity, sources, lands: landCount, size: Math.max(1, deck.mainCount - commanders.length) || 99, isPayoff: (c) => heuristicSynergy(c, th) >= 0.67 });

  // ---- type mix vs EDHREC
  const typeCounts = {};
  for (const c of cards) typeCounts[c.type] = (typeCounts[c.type] || 0) + c.qty;
  const typeDiffs = [];
  if (edh.found && edh.typeMix && deck.mainCount >= 90) {
    for (const t of ['creature', 'instant', 'sorcery', 'artifact', 'enchantment', 'planeswalker', 'land']) {
      const avg = edh.typeMix[t];
      if (typeof avg !== 'number') continue;
      const d = Math.round(((typeCounts[t] || 0) - avg) * 10) / 10;
      if (Math.abs(d) >= 4) typeDiffs.push({ type: t, deck: typeCounts[t] || 0, edhrecAvg: Math.round(avg * 10) / 10, diff: d });
    }
  }

  // ---- per-card scores
  const target = targetBracket ? Number(targetBracket) : null;
  // evaluations (deck_triangulate's own model + EDHREC reference) replace the simple score when given,
  // so the analysis, the cut list and the optimizer all rank cards the same way
  const scored = others.map((c) => {
    const ev = evaluations?.get(normName(c.name));
    if (ev) return { info: c, score: ev.value, why: [...(ev.why || [])], verdict: ev.verdict };
    return scoreCard(c, { th, edh, target, gcCount: gcCards.length, identity });
  });
  // redundancy beyond role targets
  for (const role of CORE_ROLES) {
    const max = ROLE_TARGETS[role]?.[1];
    if (!max) continue;
    const list = scored.filter((s) => s.info.roles.has(role) && !s.info.isLand);
    const extraN = sum(list.map((s) => s.info)) - max;
    if (extraN <= 0) continue;
    const single = list.filter((s) => [...s.info.roles].filter((r) => CORE_ROLES.includes(r)).length === 1).sort((a, b) => a.score - b.score);
    for (const s of single.slice(0, extraN)) {
      s.score = Math.max(0, s.score - 6);
      s.why.push(`-6 redundância (${rolePt(role)} acima da meta)`);
    }
  }
  scored.sort((a, b) => a.score - b.score || a.info.name.localeCompare(b.info.name));

  // ---- issues
  const issues = [];
  const add = (impact, area, problem, fix) => issues.push({ impact, area, problem, fix });
  if (deck.mainCount !== 100) add(10, 'regras', `Deck com ${deck.mainCount} cartas (precisa de 100).`, deck.mainCount > 100 ? `Corte ${deck.mainCount - 100} carta(s) (deck_cut_candidates).` : `Adicione ${100 - deck.mainCount} carta(s) (deck_upgrade_candidates).`);
  for (const [role, info] of Object.entries(roles)) {
    if (!ROLE_TARGETS[role] || info.status !== 'baixo') continue;
    const need = ROLE_TARGETS[role][0] - info.count;
    const weight = { ramp: 1.2, draw: 1.2, removal: 0.9, wipe: 0.6, protection: 0.5, recursion: 0.4 }[role] ?? 0;
    if (!weight) continue;
    add(Math.min(9, Math.round(need * weight * 1.5 + 2)), 'funções', `${rolePt(role)}: ${info.count} (meta ${info.target}).`, `Adicione ${need} carta(s) de ${rolePt(role)} (deck_upgrade_candidates role="${role}").`);
  }
  if (landCount < lt[0]) add(Math.min(9, (lt[0] - landCount) * 2 + 2), 'mana', `${landCount} terrenos (meta ${lt[0]}-${lt[1]}).`, `Adicione ${lt[0] - landCount} terreno(s).`);
  if (landCount > lt[1] + 1) add(3, 'mana', `${landCount} terrenos (meta ${lt[0]}-${lt[1]}).`, `Troque ${landCount - lt[1]} terreno(s) por ação/ramp.`);
  if (avgMv > 3.4) add(Math.min(8, Math.round((avgMv - 3.2) * 10)), 'curva', `MV médio ${avgMv} (casual ~3,0).`, 'Corte cartas de MV 6+ que não ganham o jogo nem viram a mesa.');
  // fluidity
  const fl = fluidity;
  if (fl.earlyPlays.count < 12) add(Math.min(7, 14 - fl.earlyPlays.count), 'fluidez', `Só ${fl.earlyPlays.count} jogadas de MV ≤ 2 (${fl.odds.earlyPlayByT2}% de ter uma até o T2): os primeiros turnos tendem a passar em branco.`, 'Troque cartas caras/situacionais por ramp, compra ou interação de MV ≤ 2.');
  if (fl.deadTopEnd.count >= 2) add(Math.min(7, 2 + fl.deadTopEnd.count), 'fluidez', `${fl.deadTopEnd.count} carta(s) de MV 6+ sem função básica travam a mão: ${fl.deadTopEnd.cards.slice(0, 5).join(', ')}.`, 'Mantenha só os finalizadores/bombas que o plano precisa; o resto vira ramp, compra ou peças baratas do tema.');
  else if (fl.topEnd.count > 9) add(4, 'fluidez', `${fl.topEnd.count} cartas de MV 6+ (${fl.odds.notClunkyT4}% de não ter 2+ delas presas na mão no T4).`, 'Reduza o topo da curva para 6–8 cartas.');
  for (const r of fl.colorRequirements) {
    if (r.prob >= 0.8) continue;
    add(r.commander ? 7 : r.prob < 0.6 ? 6 : 4, 'mana', `Cor ${r.color}: ${r.hardest}${r.commander ? ' (comandante)' : ''} pede ${r.pips}× ${r.color} até o T${r.turn}, mas com ${r.sources} fontes só há ${Math.round(r.prob * 100)}% de chance.`, `Mais fontes de ${r.color} (duais, ramp que busca ${r.color}) ou troque cartas de custo de cor pesado.`);
  }
  if (fl.drawEngines.count < 3 && roles.draw.count >= 1) add(3, 'fluidez', `Só ${fl.drawEngines.count} fonte(s) de compra recorrente.`, 'Motores de compra (permanentes que compram a cada turno/gatilho) evitam ficar sem cartas no meio do jogo.');
  if (fl.manaSinks.count < 2 && landCount >= lt[0]) add(2, 'fluidez', `Poucos usos para mana sobrando: ${fl.manaSinks.count}.`, 'Terrenos utilitários, habilidades ativadas ou custos X tornam o flood útil.');
  if (tapped.length > 4) add(Math.min(6, tapped.length - 2), 'mana', `${tapped.length} terrenos entram virados.`, 'Troque os piores por terrenos que entram desvirados.');
  const totalPips = Object.values(pipTotals).reduce((s, x) => s + x, 0);
  const totalSources = Object.values(sources).reduce((s, x) => s + x, 0);
  if (totalPips > 0 && totalSources > 0) {
    for (const k of identity) {
      const pp = pipTotals[k] / totalPips;
      const sp = sources[k] / totalSources;
      if (pp - sp > 0.12) add(5, 'mana', `Cor ${k}: ${Math.round(pp * 100)}% dos símbolos de mana, mas só ${Math.round(sp * 100)}% das fontes.`, `Mais fontes de ${k} (duais/fetch/ramp que busca ${k}).`);
    }
  }
  if (removal.length >= 4 && instantRemoval.length / removal.length < 0.3) add(2, 'interação', `Só ${instantRemoval.length}/${removal.length} remoções são instantâneas.`, 'Interação instantânea usa a mana do turno do oponente e não atrasa o seu desenvolvimento.');
  if (target) {
    if (est.bracket > target) add(8, 'bracket', `Bracket estimado ${est.bracket} acima do alvo ${target} (${est.reasons.join(', ')}).`, 'Remova os itens que puxam o bracket para cima.');
    const allowed = target <= 2 ? 0 : target === 3 ? 3 : Infinity;
    if (gcCards.length > allowed) add(8, 'bracket', `${gcCards.length} Game Changers para bracket ${target} (máx. ${allowed}).`, `Remova: ${gcCards.join(', ')}.`);
  }
  for (const d of typeDiffs) add(1, 'referência', `${d.type}: ${d.deck} no deck vs média EDHREC ${d.edhrecAvg} (só referência).`, 'Só mude se isso também melhorar a fluidez ou o plano do deck.');
  const weak = scored.filter((s) => s.score < 35);
  if (weak.length) add(Math.min(6, 2 + Math.floor(weak.length / 2)), 'cartas', `${weak.length} carta(s) com nota < 35: ${weak.slice(0, 6).map((s) => s.info.name).join(', ')}${weak.length > 6 ? '…' : ''}.`, 'Veja deck_cut_candidates.');
  issues.sort((a, b) => b.impact - a.impact);

  const summary = [
    `${deck.name}: ${deck.mainCount} cartas, comandante(s) ${commanders.map((c) => c.name).join(' + ') || '?'}, identidade ${deck.identity ?? '?'}.`,
    `Terrenos ${landCount} (meta ${lt[0]}-${lt[1]}), MV médio ${avgMv}, ${tapped.length} terreno(s) virado(s).`,
    `Ramp ${roles.ramp.count} · Compra ${roles.draw.count} · Remoção ${roles.removal.count} · Wipes ${roles.wipe.count} · Proteção ${roles.protection.count} · Recursão ${roles.recursion.count}.`,
    `Fluidez: ${fluidity.earlyPlays.count} jogadas de MV ≤ 2 (${fluidity.odds.earlyPlayByT2}% de ter uma até o T2), ${fluidity.topEnd.count} cartas de MV 6+, ${fluidity.drawEngines.count} motor(es) de compra, ${fluidity.manaSinks.count} uso(s) para mana sobrando, mão inicial com 2–5 terrenos ${fluidity.odds.landsInOpening}%.`,
    `Bracket estimado ${est.bracket}${deck.edhBracket ? ` (declarado ${deck.edhBracket})` : ''}${target ? `, alvo ${target}` : ''}: ${est.reasons.join(', ')}.`,
    edh.found ? `EDHREC (referência): ${edh.numDecks ?? '?'} decks (${edh.slug}).` : `EDHREC: sem dados${edh.error ? ` (${edh.error})` : ''} — a análise não depende dele.`,
    issues.length ? `Principal problema: ${issues[0].problem} → ${issues[0].fix}` : 'Nenhum problema relevante encontrado.',
  ];

  return {
    deck: { id: deck.id, name: deck.name, commanders: commanders.map((c) => c.name), identity: deck.identity, count: deck.mainCount, declaredBracket: deck.edhBracket },
    summary,
    themes: th.themes,
    roles,
    mana: { lands: landCount, landTarget: `${lt[0]}-${lt[1]}`, avgMv, curve, pips: pipTotals, sources, tappedLands: tapped, conditionalTapped: conditional, cheapRamp },
    fluidity,
    interaction: { removal: sum(removal), instant: sum(instantRemoval), instantShare: removal.length ? Math.round((instantRemoval.length / removal.length) * 100) / 100 : null },
    power: { gameChangers: gcCards, tutors: tutors.map((c) => c.name), extraTurns: extra, massLandDenial: mld, combos, estimatedBracket: est.bracket, reasons: est.reasons, saltAvg },
    typeMix: { deck: typeCounts, edhrec: edh.found ? edh.typeMix : null, diffs: typeDiffs },
    edhrec: { slug: edh.slug ?? null, found: !!edh.found, numDecks: edh.numDecks ?? null, ...(edh.error ? { error: edh.error } : {}) },
    issues,
    cards: scored.map((s) => ({ name: s.info.name, score: s.score, ...(s.verdict ? { verdict: s.verdict } : {}), roles: [...s.info.roles], mv: s.info.mv, type: s.info.type, why: s.why.join('; ') })),
    _scored: scored,
    _landTarget: lt,
  };
}

function scoreCard(info, { th, edh, target, gcCount, identity }) {
  // Own model first (function, cost, fluidity, text synergy); EDHREC adds a bounded reference bonus.
  const why = [];
  let s = 45;
  const ed = edh.found ? edh.cards.get(normName(info.name)) : null;
  const addPts = (n, label) => {
    if (!n) return;
    s += n;
    why.push(`${n > 0 ? '+' : ''}${n} ${label}`);
  };
  if (info.isLand) {
    s = info.isBasic ? 50 : 55;
    why.push(info.isBasic ? 'terreno básico' : 'terreno');
    const fix = info.produced.filter((c) => identity.includes(c)).length;
    if (!info.isBasic && fix >= 2) addPts(8, 'corrige cores');
    if (info.etb === 'tapped') addPts(-12, 'entra virado');
    if (info.etb === 'conditional') addPts(-3, 'entra virado às vezes');
    const util = [...info.roles].filter((r) => r !== 'ramp');
    if (util.length) addPts(6, `utilidade (${util.map(rolePt).join(', ')})`);
  } else {
    const core = [...info.roles].filter((r) => CORE_ROLES.includes(r));
    const second = [...info.roles].filter((r) => !CORE_ROLES.includes(r) && ['tokens', 'landfall', 'sac-outlet', 'wincon', 'anthem', 'evasion'].includes(r));
    if (core.length) addPts(Math.min(24, core.length * 12), core.map(rolePt).join('+'));
    if (second.length) addPts(Math.min(10, second.length * 5), second.map(rolePt).join('+'));
    const mv = info.mv;
    let mvPts = mv <= 1 ? 6 : mv === 2 ? 5 : mv === 3 ? 2 : mv === 4 ? 0 : mv === 5 ? -4 : -8 - Math.max(0, mv - 6) * 3;
    if (mvPts < 0 && (info.roles.has('wincon') || info.roles.has('wipe'))) mvPts = Math.round(mvPts / 2);
    addPts(mvPts, `MV ${mv}`);
  }
  let heur = 0;
  if (!info.isLand) {
    heur = heuristicSynergy(info, th);
    if (heur > 0) addPts(Math.round(heur * 15), `sinergia com o comandante (${th.themes.join('/')})`);
    const fl = cardFluidity(info, identity, { payoff: heur >= 0.67 });
    const flPts = Math.round((fl.score - 0.5) * 20);
    if (flPts) addPts(flPts, `fluidez ${fl.score}`);
  }
  if (ed) {
    // reference only: at most about +8 (EDHREC can confirm, not decide)
    const ref = (Number.isFinite(ed.synergy) ? Math.max(-0.2, ed.synergy) * 10 : 0) + (Number.isFinite(ed.inclusion) ? ed.inclusion * 5 : 0);
    if (Math.round(ref)) addPts(Math.round(ref), `referência EDHREC (sinergia ${ed.synergy ?? '?'}, ${Math.round((ed.inclusion ?? 0) * 100)}% dos decks)`);
  }
  if (!info.isLand) {
    const hasRole = [...info.roles].some((r) => r !== 'lifegain' && r !== 'burn');
    const edhSyn = ed && (ed.synergy ?? 0) >= 0.15;
    if (!hasRole && heur === 0 && !edhSyn) addPts(-12, 'fora do plano (sem função nem sinergia)');
    if (info.mv >= 6 && !hasRole && heur < 0.5) addPts(-6, 'MV alto com pouco impacto');
  }
  if (info.gc && target) {
    if (target <= 2) addPts(-30, 'Game Changer acima do bracket');
    else if (target === 3 && gcCount > 3) addPts(-10, 'Game Changers demais para bracket 3');
  }
  if (info.salt != null && info.salt >= 2.5) why.push(`salt ${info.salt}`);
  return { info, score: Number.isFinite(s) ? Math.max(0, Math.min(100, Math.round(s))) : 45, why };
}

/** Cut candidates from an analysis: lowest scores, excluding protected roles and lands unless surplus. */
export function cutCandidates(analysis, count = 10) {
  const protectedRoles = Object.entries(analysis.roles)
    .filter(([r, v]) => ROLE_TARGETS[r] && ROLE_TARGETS[r][0] > 0 && v.count <= ROLE_TARGETS[r][0])
    .map(([r]) => r);
  const lands = analysis.mana.lands;
  const landSurplus = lands - analysis._landTarget[1];
  let landsAllowed = Math.max(0, landSurplus);
  const out = [];
  const guarded = [];
  for (const s of analysis._scored) {
    if (out.length >= count) break;
    const i = s.info;
    if (i.isLand) {
      if (landsAllowed <= 0) continue;
      landsAllowed--;
    }
    const row = { name: i.name, score: s.score, roles: [...i.roles], mv: i.mv, reason: s.why.join('; ') || 'nota baixa' };
    const guard = [...i.roles].filter((r) => protectedRoles.includes(r));
    if (guard.length) {
      guarded.push({ ...row, warning: `cumpre função abaixo da meta: ${guard.map(rolePt).join(', ')}` });
      continue;
    }
    out.push(row);
  }
  // When protected roles leave too few cuts, list the weakest protected cards separately (cut only with a replacement in the same role).
  const alsoConsider = out.length < count ? guarded.filter((g) => g.score < 50).slice(0, count - out.length) : [];
  return { protectedRoles, cuts: out, alsoConsider };
}

/** Roles below target, worst deficit first. */
export function gapRoles(analysis) {
  return Object.entries(analysis.roles)
    .filter(([r, v]) => ROLE_TARGETS[r] && v.count < ROLE_TARGETS[r][0])
    .map(([r, v]) => ({ role: r, missing: ROLE_TARGETS[r][0] - v.count }))
    .sort((a, b) => b.missing - a.missing);
}
