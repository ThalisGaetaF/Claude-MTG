// Fluidity: how much a card (and the whole deck) helps a game run smoothly — playable early turns,
// no hands stuck with expensive or color-hungry cards, steady card flow, uses for extra mana.
// This is the deck's OWN quality model; EDHREC is only a reference elsewhere.
// Pure functions, no I/O.

import { CORE_ROLES, pips } from './roles.mjs';
import { hyperRange } from './simulate.mjs';

const clamp01 = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

/** Has an activated ability or X cost that turns spare mana into something (insurance against flood). */
export function isManaSink(info) {
  const cost = String(info.cost || '').toUpperCase();
  if (/\{X\}/.test(cost)) return true;
  const t = String(info.text || '');
  // "{2}{G}: ...", "{3}, {T}: ..." — activated abilities that cost generic mana (not "{T}: Add")
  return /(^|\n)[^\n:]*\{\d+\}[^\n:]*:\s*(?!add\b)/i.test(t) || /\b(cycling|channel|kicker|multikicker|adapt|monstrosity|outlast|level up)\b/i.test(t);
}

/** Card can be traded for something else when it is not the right moment (never fully dead in hand). */
export function isFlexible(info) {
  const t = String(info.text || '').toLowerCase();
  return /choose (one|two|three)|\bcycling\b|\bchannel\b|\bkicker\b|\bescape\b|\bflashback\b|\badventure\b|\bmodal\b|\bentwine\b/.test(t) || /\/\//.test(info.typeLine || '');
}

/** Hardest colored requirement of a card: {color, pips, turn} (turn = max(MV, pips)) or null. */
export function colorDemand(info) {
  const p = pips(info.cost);
  let best = null;
  for (const [c, n] of Object.entries(p)) {
    const k = Math.floor(n + 1e-9);
    if (k < 1) continue;
    // X spells are cast later than their printed MV
    const xSpell = /\{X\}/i.test(String(info.cost || ''));
    const turn = Math.max(1, Math.round(info.mv) || 1, k, xSpell ? 4 : 0);
    if (!best || k > best.pips || (k === best.pips && turn < best.turn)) best = { color: c, pips: k, turn };
  }
  return best;
}

/**
 * Card-level fluidity 0–1 with reasons. A land returns null (lands are judged by the land evaluator).
 * identity: deck colors (to judge color-hungry costs).
 */
export function cardFluidity(info, identity = [], { payoff = false } = {}) {
  if (info.isLand) return null;
  const why = [];
  let s = 0.5;
  const add = (d, label) => {
    s += d;
    why.push(`${d > 0 ? '+' : ''}${Math.round(d * 100)} ${label}`);
  };
  const mv = Number(info.mv) || 0;
  const roles = info.roles instanceof Set ? info.roles : new Set(info.roles || []);
  const core = [...roles].filter((r) => CORE_ROLES.includes(r));
  const mvD = mv <= 1 ? 0.14 : mv === 2 ? 0.12 : mv === 3 ? 0.05 : mv === 4 ? 0 : mv === 5 ? -0.08 : -0.15 - 0.03 * Math.min(4, mv - 6);
  if (mvD) add(mvD, `MV ${mv}`);
  if (roles.has('ramp') && mv <= 2) add(0.12, 'ramp barato (acelera e evita mão travada)');
  else if (roles.has('ramp') && mv === 3) add(0.06, 'ramp');
  if (roles.has('draw')) add(0.08, 'compra (mantém o fluxo de cartas)');
  else if (/\bdraws? a card\b|\bscry \d\b|\bsurveil \d\b|\binvestigate\b/i.test(info.text || '')) add(0.04, 'filtra/compra de leve');
  if (info.instant) add(0.05, 'velocidade instantânea (usa a mana do turno do oponente)');
  if (core.length >= 2) add(0.05, 'cumpre duas funções');
  if (isFlexible(info)) add(0.04, 'flexível (modos/ciclagem/custos alternativos)');
  if (isManaSink(info)) add(0.03, 'usa mana sobrando');
  const d = colorDemand(info);
  const multi = identity.length >= 3;
  if (d && (d.pips >= 3 || (d.pips >= 2 && mv <= 3 && multi))) add(multi ? -0.1 : -0.05, `custo de cor pesado (${d.pips}× ${d.color} até o T${d.turn})`);
  if (mv >= 6 && !core.length && !roles.has('wincon') && !payoff) add(-0.1, 'cara e sem função básica (tende a travar na mão)');
  return { score: Math.round(clamp01(s) * 100) / 100, why };
}

// ---------------------------------------------------------------- deck level

/**
 * Smooth-curve target for the nonland cards (8 buckets 0…7+). Own model; EDHREC's curve, when known,
 * is blended in only as a reference (refWeight).
 */
export const IDEAL_CURVE = [1, 9, 16, 15, 11, 6, 3, 2];

/**
 * Land count center from the deck itself: average MV, cheap ramp and landfall plan; EDHREC's average,
 * when given, only nudges it (30%). Returns {center, range:[lo,hi], own, ref}.
 */
export function landPlan({ avgMv = 3, cheapRamp = 0, themes = [], edhAvg = null } = {}) {
  let own = 36 + 3 * (avgMv - 3) - 0.5 * Math.max(0, cheapRamp - 8);
  if (themes.includes('landfall')) own += 2;
  own = Math.max(32, Math.min(41, own));
  const ref = typeof edhAvg === 'number' && edhAvg >= 28 && edhAvg <= 45 ? edhAvg : null;
  const center = Math.round(ref == null ? own : 0.7 * own + 0.3 * ref);
  return { center, range: [Math.max(31, center - 1), Math.min(42, center + 1)], own: Math.round(own * 10) / 10, ref };
}

/** P(at least `k` sources of a color among the cards seen by turn `t` on the play). */
export function colorOdds(sources, k, t, size = 99) {
  return hyperRange(size, sources, 7 + Math.max(0, t - 1), k);
}

/**
 * Deck-level fluidity report. cards: card infos with qty (the 99, commander excluded);
 * commanders: infos; identity: colors; sources: {color: count}; size: library size.
 */
export function deckFluidity(cards, { commanders = [], identity = [], sources = {}, lands = 0, size = 99, isPayoff = () => false } = {}) {
  const nonland = cards.filter((c) => !c.isLand);
  const q = (c) => Number(c.qty) || 1;
  const sum = (arr) => arr.reduce((s, c) => s + q(c), 0);
  const early = nonland.filter((c) => c.mv <= 2);
  const top = nonland.filter((c) => c.mv >= 6);
  // a 6+ drop is fine when it is a payoff of the deck's plan; dead weight is expensive AND off-plan AND without a function
  const deadTop = top.filter((c) => ![...c.roles].some((r) => CORE_ROLES.includes(r)) && !c.roles.has('wincon') && !isPayoff(c));
  const sinks = nonland.filter(isManaSink).concat(cards.filter((c) => c.isLand && isManaSink(c)));
  const engines = nonland.filter((c) => c.roles.has('draw') && !/\b(instant|sorcery)\b/i.test(c.typeLine || ''));
  const cheapRamp = nonland.filter((c) => c.roles.has('ramp') && c.mv <= 2);

  // hardest color requirement per color (commander included: it should come down on curve)
  const colors = {};
  for (const c of [...commanders.map((x) => ({ ...x, isCommanderCard: true })), ...nonland]) {
    const d = colorDemand(c);
    if (!d || (identity.length && !identity.includes(d.color))) continue;
    const prob = colorOdds(sources[d.color] || 0, d.pips, d.turn, size);
    const cur = colors[d.color];
    if (!cur || prob < cur.prob) colors[d.color] = { color: d.color, sources: sources[d.color] || 0, hardest: c.name, pips: d.pips, turn: d.turn, prob: Math.round(prob * 1000) / 1000, commander: !!c.isCommanderCard };
  }
  const odds = {
    earlyPlayByT2: hyperRange(size, sum(early), 8, 1),
    notClunkyT4: hyperRange(size, sum(top), 10, 0, 1), // at most one 6+ card among the first 10 cards
    landsInOpening: hyperRange(size, lands, 7, 2, 5),
  };
  return {
    earlyPlays: { count: sum(early), cards: early.map((c) => c.name) },
    topEnd: { count: sum(top), cards: top.map((c) => c.name) },
    deadTopEnd: { count: sum(deadTop), cards: deadTop.map((c) => c.name) },
    cheapRamp: { count: sum(cheapRamp), cards: cheapRamp.map((c) => c.name) },
    drawEngines: { count: sum(engines), cards: engines.map((c) => c.name) },
    manaSinks: { count: sum(sinks), cards: sinks.map((c) => c.name) },
    colorRequirements: Object.values(colors).sort((a, b) => a.prob - b.prob),
    odds: Object.fromEntries(Object.entries(odds).map(([k, v]) => [k, Math.round(v * 1000) / 10])),
  };
}
