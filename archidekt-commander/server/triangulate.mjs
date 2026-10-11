// Triangulation: does each card make sense in THIS deck with THIS commander?
// The deck's OWN model leads — function, mana cost, fluidity (does it keep the game flowing?) and text
// synergy with the commander. EDHREC is a reference that can confirm or question, never decide alone:
// all its pages together are ONE vote and ~20% of the value.
// Sources:
//   1. EDHREC commander page   — synergy (vs. the card's colors) and inclusion in decks of this commander
//   2. EDHREC theme page       — inclusion in decks of the detected theme (landfall, artifacts…)
//   3. EDHREC bracket page     — inclusion in decks of the target bracket
//   4. EDHREC average deck     — the card is (or is not) in the "average" list
//   5. Global popularity       — EDHREC card page (share of all decks of its colors) or Scryfall's edhrec_rank
//   6. Function                — ramp/draw/removal… (Scryfall tags + Archidekt tags + text)
//   7. Text synergy            — oracle-text overlap with the commander's themes (catches cards EDHREC
//                                does not know yet or "pet cards" that do fit)
//   8. Fluidity               — cheap, instant, draws/filters, flexible, not color-hungry, not a dead 6-drop
// Each source votes keep/doubt; the value 0–100 is a weighted mix; confidence = how many sources exist
// and how much they agree. Pure functions except loadContext (network, through edhrec.mjs).

import { cardInfo, commanderThemes, heuristicSynergy, rolePt } from './analysis.mjs';
import { averageDeck, BRACKET_SLUGS, cardPage, cardPageCached, combosFor, commanderPageSafe } from './edhrec.mjs';
import { cardFluidity } from './fluidity.mjs';
import { CORE_ROLES } from './roles.mjs';
import { normName } from './store.mjs';

const clamp01 = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

export const MODES = {
  // weights of the components of a nonland card's value. E = EDHREC (reference), G = global popularity,
  // R = function, H = text synergy with the commander/plan, M = mana cost, F = fluidity.
  equilibrio: { E: 0.18, G: 0.06, R: 0.22, H: 0.18, M: 0.14, F: 0.22, edh: { syn: 0.35, inc: 0.25, theme: 0.15, bracket: 0.1, avg: 0.15 } },
  forca: { E: 0.22, G: 0.12, R: 0.22, H: 0.08, M: 0.14, F: 0.22, edh: { syn: 0.2, inc: 0.35, theme: 0.05, bracket: 0.25, avg: 0.15 } },
  tema: { E: 0.2, G: 0.03, R: 0.14, H: 0.32, M: 0.11, F: 0.2, edh: { syn: 0.35, inc: 0.15, theme: 0.35, bracket: 0.05, avg: 0.1 } },
};
export const MODE_ALIASES = { equilibrio: 'equilibrio', 'equilíbrio': 'equilibrio', balance: 'equilibrio', balanced: 'equilibrio', forca: 'forca', 'força': 'forca', power: 'forca', tema: 'tema', theme: 'tema' };

export const VERDICT_PT = {
  nucleo: 'núcleo do comandante',
  sinergia: 'sinergia',
  staple: 'staple / função',
  aposta: 'aposta pessoal (EDHREC não confirma, mas o texto conversa com o comandante)',
  duvidosa: 'duvidosa',
  corte: 'corte provável',
  terreno: 'terreno',
};

// ---------------------------------------------------------------- context (network)

/**
 * Gather every EDHREC source for a deck. deckNames: Set of normalized names (to detect the theme).
 * Returns ctx = {commanders[], base, themes[], theme, bracket, avg, combos, cardPages: Map, notes[]}.
 */
export async function loadContext(deck, { targetBracket = null, theme = null, maxThemes = 3, deadline = Infinity } = {}) {
  const names = deck.commanders.map((c) => c.name);
  const notes = [];
  const ctx = { commanders: names, base: { found: false, cards: new Map(), themes: [], curve: {}, typeMix: {} }, themePages: [], theme: null, bracket: null, avg: null, combos: [], cardPages: new Map(), notes };
  if (!names.length) {
    notes.push('Deck sem comandante: EDHREC não consultado.');
    return ctx;
  }
  ctx.base = await commanderPageSafe(names);
  if (!ctx.base.found) {
    notes.push(`EDHREC sem página para ${names.join(' + ')}${ctx.base.error ? ` (${ctx.base.error})` : ''}: só função, popularidade global e texto.`);
    return ctx;
  }
  const time = () => deadline - Date.now() > 4000;

  // Themes: the most played ones for this commander, plus the one the user asked for.
  const wanted = theme ? resolveTheme(ctx.base.themes, theme) : null;
  const slugs = [...new Set([...(wanted ? [wanted] : []), ...ctx.base.themes.slice(0, maxThemes).map((t) => t.slug)])];
  for (const slug of slugs) {
    if (!time()) {
      notes.push('Algumas páginas de tema do EDHREC ficaram para a próxima chamada (limite de tempo).');
      break;
    }
    const p = await commanderPageSafe(names, { variant: slug });
    if (p.found) ctx.themePages.push({ slug, name: ctx.base.themes.find((t) => t.slug === slug)?.name || slug, decks: p.numDecks, page: p });
  }
  const deckNorm = new Set(deck.rows.filter((r) => r.included && !r.isCommander).map((r) => normName(r.name)));
  const ranked = rankThemes(ctx, deckNorm);
  ctx.themeRanking = ranked;
  if (wanted) ctx.theme = ctx.themePages.find((t) => t.slug === wanted) || null;
  else if (ranked.length && ranked[0].affinity >= 0.01) ctx.theme = ctx.themePages.find((t) => t.slug === ranked[0].slug);
  if (wanted && !ctx.theme) notes.push(`Tema "${theme}" não encontrado no EDHREC para este comandante.`);

  const bslug = targetBracket ? BRACKET_SLUGS[targetBracket] : null;
  if (bslug && time()) {
    const p = await commanderPageSafe(names, { variant: bslug });
    if (p.found) ctx.bracket = { slug: bslug, bracket: targetBracket, decks: p.numDecks, page: p };
  }
  if (time()) {
    const a = await averageDeck(names, bslug ? { variant: bslug } : {});
    ctx.avg = a.found ? a : bslug ? await averageDeck(names) : a;
    if (!ctx.avg.found) ctx.avg = null;
  }
  if (time()) {
    const c = await combosFor(names);
    ctx.combos = c.combos || [];
  }
  return ctx;
}

function resolveTheme(themes, wanted) {
  const w = normName(wanted).replace(/\s+/g, '-');
  const hit = themes.find((t) => t.slug === w || normName(t.name).replace(/\s+/g, '-') === w) || themes.find((t) => t.slug.includes(w) || w.includes(t.slug));
  return hit ? hit.slug : w;
}

/** Theme affinity: how much more the deck's cards show up in theme decks than in decks of the commander in general. */
export function rankThemes(ctx, deckNorm) {
  const out = [];
  for (const t of ctx.themePages) {
    let s = 0;
    let hits = 0;
    for (const k of deckNorm) {
      const ti = t.page.cards.get(k)?.inclusion ?? 0;
      const bi = ctx.base.cards.get(k)?.inclusion ?? 0;
      s += ti - bi;
      if (ti > 0) hits++;
    }
    out.push({ slug: t.slug, name: t.name, decks: t.decks, affinity: Math.round((s / Math.max(1, deckNorm.size)) * 1000) / 1000, cardsInTheme: hits });
  }
  return out.sort((a, b) => b.affinity - a.affinity);
}

/** Fetch EDHREC card pages for the given names until the deadline. Returns {fetched, skipped}. */
export async function fetchCardPages(ctx, names, { deadline = Infinity, max = 25 } = {}) {
  let fetched = 0;
  let skipped = 0;
  for (const n of names) {
    const k = normName(n);
    if (ctx.cardPages.has(k)) continue;
    const cached = cardPageCached(n);
    if (!cached && (fetched >= max || deadline - Date.now() < 2500)) {
      skipped++;
      continue;
    }
    try {
      const p = await cardPage(n);
      ctx.cardPages.set(k, p);
      if (!p.cached) fetched++;
    } catch (e) {
      ctx.cardPages.set(k, { found: false, error: e.message });
    }
  }
  return { fetched, skipped };
}

// ---------------------------------------------------------------- signals & value (pure)

const rankScore = (rank) => (rank == null || !(rank > 0) ? null : clamp01(1 - Math.log10(rank) / 4.5));

function mvFit(info) {
  const mv = info.mv;
  let s = mv <= 2 ? 1 : mv === 3 ? 0.85 : mv === 4 ? 0.65 : mv === 5 ? 0.45 : mv === 6 ? 0.3 : 0.15;
  if (s < 0.65 && (info.roles.has('wincon') || info.roles.has('wipe'))) s = (s + 0.65) / 2;
  return s;
}

function roleScore(info) {
  const core = [...info.roles].filter((r) => CORE_ROLES.includes(r) && r !== 'counter');
  const second = [...info.roles].filter((r) => ['tokens', 'landfall', 'sac-outlet', 'wincon', 'anthem', 'evasion', 'counter'].includes(r));
  if (core.length >= 2) return 1;
  if (core.length === 1) return 0.7 + Math.min(0.2, second.length * 0.1);
  return Math.min(0.45, second.length * 0.2);
}

/** Collect raw evidence for one card. */
export function signals(info, ctx, th) {
  const k = normName(info.name);
  const ev = { sources: 0 };
  if (ctx.base?.found) {
    const c = ctx.base.cards.get(k);
    ev.commander = { synergy: c?.synergy ?? null, inclusion: c?.inclusion ?? 0, lists: c?.lists || [], listed: !!c };
    ev.sources++;
  }
  if (ctx.theme) {
    const c = ctx.theme.page.cards.get(k);
    ev.theme = { slug: ctx.theme.slug, inclusion: c?.inclusion ?? 0, synergy: c?.synergy ?? null };
    ev.sources++;
  }
  if (ctx.bracket) {
    const c = ctx.bracket.page.cards.get(k);
    ev.bracket = { bracket: ctx.bracket.bracket, inclusion: c?.inclusion ?? 0 };
  }
  if (ctx.avg) ev.averageDeck = ctx.avg.cards.has(k);
  const cp = ctx.cardPages?.get(k);
  if (cp?.found) {
    const top = cp.topCommanders.find((t) => ctx.commanders.some((n) => normName(n) === normName(t.name)));
    ev.global = { inclusion: cp.inclusion, salt: cp.salt, source: 'EDHREC (página da carta)', topForThisCommander: !!top };
    ev.sources++;
  } else if (info.rank != null) {
    ev.global = { rank: info.rank, source: 'rank EDHREC (Scryfall)' };
    ev.sources++;
  }
  ev.roles = [...info.roles];
  ev.sources++; // function is always known (may be "none")
  ev.text = r2(heuristicSynergy(info, th));
  ev.sources++;
  ev.mv = info.mv;
  return ev;
}

/** Combos (EDHREC) whose pieces are all in `have` (normalized names, commander included) and include `k`. */
export function combosWith(k, ctx, have) {
  return (ctx.combos || []).filter((c) => {
    const ks = c.cards.map(normName);
    return ks.includes(k) && ks.every((x) => x === k || have.has(x));
  });
}

/**
 * Value 0–100 for a nonland card + verdict, confidence and reasons.
 * opts: {mode, targetBracket, have (Set of normalized names in the deck incl. commanders)}
 */
export function evaluate(info, ctx, th, { mode = 'equilibrio', targetBracket = null, have = new Set() } = {}) {
  const W = MODES[mode] || MODES.equilibrio;
  const ev = signals(info, ctx, th);
  const why = [];
  const k = normName(info.name);

  if (info.isLand) return evaluateLand(info, ctx, ev, th);

  // EDHREC composite
  const parts = [];
  if (ev.commander) {
    if (ev.commander.synergy != null) parts.push([W.edh.syn, clamp01((ev.commander.synergy + 0.1) / 0.6)]);
    else parts.push([W.edh.syn * 0.5, 0]); // not in the commander's lists: no evidence of synergy
    parts.push([W.edh.inc, clamp01(ev.commander.inclusion / 0.5)]);
  }
  if (ev.theme) parts.push([W.edh.theme, clamp01(ev.theme.inclusion / 0.5)]);
  if (ev.bracket) parts.push([W.edh.bracket, clamp01(ev.bracket.inclusion / 0.5)]);
  if (ev.averageDeck != null) parts.push([W.edh.avg, ev.averageDeck ? 1 : 0]);
  const wSum = parts.reduce((s, [w]) => s + w, 0);
  const E = wSum ? parts.reduce((s, [w, x]) => s + w * x, 0) / wSum : null;

  const G = ev.global?.inclusion != null ? clamp01(ev.global.inclusion / 0.35) : rankScore(ev.global?.rank);
  const R = roleScore(info);
  const H = ev.text ?? 0;
  const M = mvFit(info);
  const fl = cardFluidity(info, ctx.identity || [], { payoff: H >= 0.67 });
  const F = fl.score;

  // The deck's own model (function, synergy, cost, fluidity) — what the card does here, with no external data.
  const ownW = W.R + W.H + W.M + W.F;
  const own = (W.R * R + W.H * H + W.M * M + W.F * F) / ownW;
  // Missing references simply drop out (the own model fills their weight).
  const w = { E: E == null ? 0 : W.E, G: G == null ? 0 : W.G };
  let value = 100 * (w.E * (E ?? 0) + w.G * (G ?? 0) + ownW * own) / (w.E + w.G + ownW);

  // combos already assembled in the deck
  const combos = combosWith(k, ctx, have);
  if (combos.length) {
    if (targetBracket && targetBracket <= 2) why.push(`peça de combo (${combos[0].cards.join(' + ')}) — acima do bracket ${targetBracket}`);
    else {
      value += 8;
      why.push(`+8 peça de combo: ${combos[0].cards.join(' + ')}`);
    }
  }
  const bracketBlock = bracketProblem(info, targetBracket);
  if (bracketBlock) {
    value -= 40;
    why.push(`-40 ${bracketBlock}`);
  }
  value = Math.max(0, Math.min(100, Math.round(value)));

  // ---- votes (all EDHREC pages together are a single reference vote)
  const votes = [];
  const edhSub = [];
  if (ev.commander) edhSub.push(ev.commander.inclusion >= 0.2 || (ev.commander.synergy ?? -1) >= 0.12 ? 1 : ev.commander.inclusion >= 0.08 ? 0.5 : 0);
  if (ev.theme) edhSub.push(ev.theme.inclusion >= 0.25 ? 1 : ev.theme.inclusion >= 0.1 ? 0.5 : 0);
  if (ev.bracket) edhSub.push(ev.bracket.inclusion >= 0.2 ? 1 : ev.bracket.inclusion >= 0.08 ? 0.5 : 0);
  if (ev.averageDeck != null) edhSub.push(ev.averageDeck ? 1 : 0);
  if (edhSub.length) {
    const m = edhSub.reduce((s, x) => s + x, 0) / edhSub.length;
    votes.push(['EDHREC (referência)', m >= 0.6 ? 1 : m >= 0.25 ? 0.5 : 0]);
  }
  if (G != null) votes.push(['popularidade global', G >= 0.6 ? 1 : G >= 0.35 ? 0.5 : 0]);
  votes.push(['função', R >= 0.7 ? 1 : R >= 0.4 ? 0.5 : 0]);
  votes.push(['texto x comandante', H >= 0.5 ? 1 : H >= 0.25 ? 0.5 : 0]);
  votes.push(['fluidez', F >= 0.62 ? 1 : F >= 0.42 ? 0.5 : 0]);
  const agreement = votes.reduce((s, [, v]) => s + v, 0) / votes.length;

  // ---- verdict
  const synergy = ev.commander?.synergy ?? null;
  const inc = ev.commander?.inclusion ?? 0;
  // The own model decides; EDHREC can lift a card to "núcleo" or confirm synergy, never cut it alone.
  let verdict;
  const edhStrong = E != null && (E >= 0.55 || inc >= 0.4);
  if (bracketBlock) verdict = 'corte';
  else if ((edhStrong && own >= 0.45) || (H >= 0.75 && own >= 0.6)) verdict = 'nucleo';
  else if ((H >= 0.5 || (synergy ?? 0) >= 0.15 || (ev.theme?.inclusion ?? 0) >= 0.3) && own >= 0.42 && value >= 38) verdict = H >= 0.5 && ev.commander && !ev.commander.listed ? 'aposta' : 'sinergia';
  else if (R >= 0.7 && F >= 0.45) verdict = 'staple';
  else if (own < 0.33 && value < 40) verdict = 'corte';
  else if (own < 0.45 || value < 42) verdict = 'duvidosa';
  else verdict = R >= 0.7 ? 'staple' : 'sinergia';

  const nSources = votes.length;
  const decisive = agreement >= 0.7 || agreement <= 0.25;
  let confidence = nSources >= 5 && decisive ? 'alta' : nSources >= 4 ? 'média' : 'baixa';
  // Not being listed on EDHREC (lists stop around 5%) is weaker evidence than a measured low inclusion.
  if (confidence === 'alta' && ['corte', 'duvidosa'].includes(verdict) && ev.commander && !ev.commander.listed && !bracketBlock) confidence = 'média';

  // ---- reasons (PT)
  if (ev.commander) {
    if (ev.commander.listed) why.push(`referência EDHREC ${ctx.commanders.join(' + ')}: em ${Math.round(inc * 100)}% dos decks${synergy != null ? `, sinergia ${synergy >= 0 ? '+' : ''}${Math.round(synergy * 100)}%` : ''}`);
    else why.push('fora das listas do EDHREC deste comandante (só referência)');
  }
  why.unshift(`modelo próprio ${Math.round(own * 100)} (função ${Math.round(R * 100)}, sinergia ${Math.round(H * 100)}, custo ${Math.round(M * 100)}, fluidez ${Math.round(F * 100)})`);
  const flPlus = fl.why.filter((x) => !/^[+-]?\d+ MV /.test(x));
  if (flPlus.length) why.push(`fluidez: ${flPlus.join(', ')}`);
  if (ev.theme) why.push(`tema ${ctx.theme.name}: ${Math.round(ev.theme.inclusion * 100)}%`);
  if (ev.bracket) why.push(`bracket ${ev.bracket.bracket}: ${Math.round(ev.bracket.inclusion * 100)}%`);
  if (ev.averageDeck != null) why.push(ev.averageDeck ? 'está no deck médio' : 'fora do deck médio');
  if (ev.global?.inclusion != null) why.push(`em ${Math.round(ev.global.inclusion * 100)}% de todos os decks das suas cores${ev.global.topForThisCommander ? ' (e este comandante está entre os que mais a usam)' : ''}`);
  else if (ev.global?.rank != null) why.push(`rank EDHREC global #${ev.global.rank}`);
  const core = [...info.roles].filter((r) => CORE_ROLES.includes(r));
  why.push(core.length ? `função: ${core.map(rolePt).join(', ')}` : info.roles.size ? `papéis: ${[...info.roles].map(rolePt).join(', ')}` : (E ?? 0) >= 0.4 || H >= 0.5 ? 'sem função básica (vale pela sinergia)' : 'sem função clara');
  if (H >= 0.25) why.push(`texto conversa com o comandante (${th.themes.join('/') || 'tipos'})`);
  if (info.mv >= 6) why.push(`MV ${info.mv}`);
  if (info.salt != null && info.salt >= 2.5) why.push(`salt ${info.salt}`);

  return {
    name: info.name,
    value,
    verdict,
    confidence,
    agreement: r2(agreement),
    votes: votes.map(([source, v]) => ({ source, vote: v === 1 ? 'mantém' : v === 0.5 ? 'neutro' : 'questiona' })),
    components: { own: r2(own), role: r2(R), text: r2(H), curve: r2(M), fluidity: r2(F), edhrec: r2(E), global: r2(G) },
    evidence: ev,
    why,
    bracketBlock,
  };
}

function evaluateLand(info, ctx, ev, th) {
  const why = [];
  let v = info.isBasic ? 50 : 55;
  why.push(info.isBasic ? 'terreno básico' : 'terreno');
  const ident = ctx.identity || [];
  const fix = info.produced.filter((c) => ident.includes(c)).length;
  if (!info.isBasic && fix >= 2) {
    v += 8;
    why.push('+8 corrige cores');
  }
  if (info.etb === 'tapped') {
    v -= 12;
    why.push('-12 entra virado');
  }
  if (info.etb === 'conditional') {
    v -= 3;
    why.push('-3 entra virado às vezes');
  }
  const util = [...info.roles].filter((r) => r !== 'ramp');
  if (util.length) {
    v += 6;
    why.push(`+6 utilidade (${util.map(rolePt).join(', ')})`);
  }
  if (!info.isBasic && ev.commander?.listed) {
    const b = Math.round(clamp01(ev.commander.inclusion / 0.5) * 10 + clamp01(((ev.commander.synergy ?? 0) + 0.1) / 0.6) * 6);
    if (b) {
      v += b;
      why.push(`+${b} EDHREC (${Math.round(ev.commander.inclusion * 100)}% dos decks)`);
    }
  }
  if (!info.isBasic && heuristicSynergy(info, th) >= 0.5) {
    v += 4;
    why.push('+4 conversa com o comandante');
  }
  if (info.isLand && info.produced.length && ident.length && !info.produced.some((c) => ident.includes(c)) && !info.isBasic && !util.length) {
    v -= 10;
    why.push('-10 não produz cores do deck');
  }
  return { name: info.name, value: Math.max(0, Math.min(100, v)), verdict: 'terreno', confidence: 'média', agreement: null, votes: [], components: {}, evidence: ev, why, bracketBlock: null };
}

/** Why a card is not allowed at the target bracket (null when fine). */
export function bracketProblem(info, targetBracket) {
  if (!targetBracket) return null;
  if (info.gc && targetBracket <= 2) return `Game Changer não cabe no bracket ${targetBracket}`;
  if (info.mld && targetBracket <= 3) return `destruição em massa de terrenos não cabe no bracket ${targetBracket}`;
  if (info.extraTurn && targetBracket <= 2) return `turno extra não cabe no bracket ${targetBracket}`;
  return null;
}

/** Card info for a card that is not in the deck (candidate), from the local cache record. */
export function infoFromRecord(rec) {
  return cardInfo({ name: rec.name, qty: 1, mv: rec.mv, type: rec.type, oracle: {} }, rec);
}

/**
 * Triangulate every card of a parsed deck. lookup(name) → cache record.
 * Returns {theme, themes, cards: [evaluation + qty/type/mv/isLand], counts by verdict, info: Map(normName → info)}.
 */
export function triangulateDeck(deck, ctx, { lookup = () => null, mode = 'equilibrio', targetBracket = null, plan = null } = {}) {
  const main = deck.rows.filter((r) => r.included);
  const commanders = main.filter((r) => r.isCommander);
  ctx.identity = deck.identity && deck.identity !== 'C' ? [...deck.identity] : [];
  const have = new Set(main.map((r) => normName(r.name)));
  const infos = new Map();
  for (const r of main) {
    if (r.isCommander) continue;
    const k = normName(r.name);
    if (infos.has(k)) infos.get(k).qty += Number(r.qty) > 0 ? Number(r.qty) : 0;
    else infos.set(k, { ...cardInfo(r, lookup(r.name)), category: r.category });
  }
  const th = commanderThemes(commanders, [plan, ctx.theme?.name].filter(Boolean).join(' '), { lookup, deckCards: [...infos.values()] });
  const cards = [...infos.values()].map((info) => ({ ...evaluate(info, ctx, th, { mode, targetBracket, have }), qty: info.qty, type: info.type, mv: info.mv, isLand: info.isLand, category: info.category }));
  const counts = {};
  for (const c of cards) counts[c.verdict] = (counts[c.verdict] || 0) + c.qty;
  return { th, have, infos, cards, counts };
}
