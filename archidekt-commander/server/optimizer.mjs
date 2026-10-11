// Deck optimizer: steepest-ascent local search over 1-for-1 swaps.
//
// Goal: a better, smoother deck — fewer stuck hands and dead turns. EDHREC is only a reference.
// Objective F(deck) — every term in "card-value points" (one card's value is 0–100):
//   + Σ value(card)                        triangulated value (own model + EDHREC reference); lands weigh 0.6
//   − role penalty                         per core role below its minimum: w·(20d + 5d²); mild penalty above max+1
//   − curve penalty                        asymmetric distance to a smooth curve (own ideal, EDHREC blended 30%):
//                                          extra expensive cards cost the most, extra cheap cards almost nothing
//   − color penalty                        60 × (pip share − source share − 8%) per color
//   + 2.5 × consistency                    hypergeometric odds (keepable 7, 4th land on T4, ramp/draw on time,
//                                          two cheap plays by T2, no clunky hand of 6-drops)
// Hard constraints: commander + locked cards stay; color identity (checked again here); Commander legality;
// singleton (basics excepted); land count inside the deck's own range (fluidity.landPlan); bracket (Game
// Changers, MLD, extra turns, 2-card combos for brackets ≤ 2, at most 3 Game Changers in bracket 3).
// Each step applies the best swap if it gains ≥ minGain; a card removed never comes back, a card added never leaves.
// Pure function; the Monte Carlo goldfish (simulate.mjs) is run by the caller before/after as a check.

import { ROLE_TARGETS } from './analysis.mjs';
import { withinIdentity } from './commander.mjs';
import { IDEAL_CURVE, landPlan } from './fluidity.mjs';
import { consistencyOdds } from './simulate.mjs';
import { normName } from './store.mjs';

const ROLE_W = { ramp: 1.2, draw: 1.2, removal: 1.0, wipe: 0.5, protection: 0.4, recursion: 0.3 };
const LAND_W = 0.6;
const CONS_W = 2.5;
const EDH_CURVE_W = 0.3; // EDHREC's curve is a reference: 30% of the target, 70% the deck's own smooth curve
// asymmetric curve weights per MV bucket: [excess, deficit]
const CURVE_W = [[0.2, 0.4], [0.2, 1.0], [0.3, 1.0], [0.5, 0.6], [0.7, 0.4], [1.2, 0.2], [1.6, 0.1], [2.0, 0.1]];
const bucket = (mv) => Math.max(0, Math.min(7, Math.floor(Number(mv) || 0)));
const INTERACTION = ['removal', 'wipe', 'counter'];

/**
 * Role targets: the generic targets, only nudged by what EDHREC's average deck runs (avgCounts: {role: n}).
 * The nudge is 35% of the difference to the generic middle, capped at −2/+4, and never below 80% of the
 * generic minimum — a landfall commander whose average deck runs 20 ramp gets ~13-15, not 20.
 */
export function roleTargets(avgCounts = null, themes = []) {
  const out = {};
  for (const [r, [min0, max0]] of Object.entries(ROLE_TARGETS)) {
    // in a lands/landfall plan, land ramp IS the engine: allow more of it (still bounded)
    const min = min0;
    const max = r === 'ramp' && themes.includes('landfall') ? max0 + 8 : max0;
    const a = avgCounts?.[r];
    if (typeof a !== 'number' || !(r in ROLE_W)) {
      out[r] = [min, max];
      continue;
    }
    const shift = Math.max(-2, Math.min(4, (a - (min + max) / 2) * 0.35));
    const lo = Math.max(Math.ceil(min * 0.8), Math.round(min + shift));
    out[r] = [lo, Math.max(lo + 2, Math.round(max + shift))];
  }
  return out;
}

/** Land range from the deck's own curve and cheap ramp; EDHREC's average land count only nudges it (30%). */
export function landRange(ctx, avgMv, themes, cheapRamp = 0) {
  return landPlan({ avgMv, themes, cheapRamp, edhAvg: ctx?.base?.typeMix?.land }).range;
}

/** Target MV histogram (8 buckets 0…7+) scaled to `nonland` cards: own smooth curve, EDHREC blended in at 30%. */
export function curveTarget(ctx, nonland) {
  const norm = (h) => {
    const tot = h.reduce((s, x) => s + x, 0) || 1;
    return h.map((x) => x / tot);
  };
  const ideal = norm(IDEAL_CURVE);
  let mix = ideal;
  if (ctx?.base?.curve && Object.keys(ctx.base.curve).length) {
    const h = Array(8).fill(0);
    for (const [mv, n] of Object.entries(ctx.base.curve)) h[bucket(Number(mv))] += Number(n) || 0;
    const edh = norm(h);
    mix = ideal.map((x, i) => (1 - EDH_CURVE_W) * x + EDH_CURVE_W * edh[i]);
  }
  return mix.map((x) => x * nonland);
}

function unitOf(e) {
  const roles = [...e.info.roles];
  return {
    k: normName(e.info.name),
    name: e.info.name,
    value: e.eval.value,
    land: e.info.isLand,
    basic: e.info.isBasic,
    mv: e.info.mv,
    roles,
    pips: pipObj(e.info.cost),
    produced: e.info.isLand || roles.includes('ramp') ? e.info.produced : [],
    gc: !!e.info.gc,
    ci: e.info.ci ?? null,
    eval: e.eval,
    info: e.info,
  };
}

function pipObj(cost) {
  const p = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const m of String(cost || '').toUpperCase().matchAll(/\{([^}]+)\}/g)) {
    const cols = [...m[1]].filter((c) => 'WUBRG'.includes(c));
    if (!cols.length) continue;
    const w = cols.length > 1 && !/\/P/.test(m[1]) ? 1 / cols.length : 1;
    for (const c of new Set(cols)) p[c] += w;
  }
  return p;
}

// ---------------------------------------------------------------- aggregates

function emptyAgg() {
  return { value: 0, landValue: 0, lands: 0, size: 0, roles: {}, curve: Array(8).fill(0), pips: { W: 0, U: 0, B: 0, R: 0, G: 0 }, sources: { W: 0, U: 0, B: 0, R: 0, G: 0 }, gc: 0, interaction: 0 };
}

function apply(agg, u, s) {
  agg.size += s;
  if (u.land) {
    agg.lands += s;
    agg.landValue += s * u.value;
  } else {
    agg.value += s * u.value;
    agg.curve[bucket(u.mv)] += s;
    for (const c of 'WUBRG') agg.pips[c] += s * u.pips[c];
    for (const r of u.roles) agg.roles[r] = (agg.roles[r] || 0) + s;
    if (u.roles.some((r) => INTERACTION.includes(r))) agg.interaction += s;
  }
  for (const c of u.produced) if (c in agg.sources) agg.sources[c] += s;
  if (u.gc) agg.gc += s;
}

/** Objective and its parts for an aggregate. env = {curveT[], identity[], landRange} */
export function objective(agg, env) {
  let roleP = 0;
  for (const [r, w] of Object.entries(ROLE_W)) {
    const [min, max] = env.targets?.[r] || ROLE_TARGETS[r];
    const n = agg.roles[r] || 0;
    const d = Math.max(0, min - n);
    // steep: dropping below the minimum costs about as much as a card's value, so the search prefers
    // like-for-like replacements (a weak removal → a better removal) over trading the role away
    roleP += w * (20 * d + 5 * d * d);
    // too much of one function (e.g. ramp with nothing to ramp into) makes the deck run out of gas
    const sur = Math.max(0, n - max);
    roleP += w * (4 * sur + sur * sur);
  }
  const nonland = agg.size - agg.lands;
  const scale = nonland / Math.max(1, env.curveNonland);
  let dist = 0;
  for (let i = 0; i < 8; i++) {
    const d = agg.curve[i] - env.curveT[i] * scale;
    dist += d > 0 ? CURVE_W[i][0] * d : -CURVE_W[i][1] * d;
  }
  const curveP = 1.5 * dist * 0.5; // each misplaced card counts twice (one bucket too many, one too few)
  let colorP = 0;
  const totP = Object.values(agg.pips).reduce((s, x) => s + x, 0);
  const totS = env.identity.reduce((s, c) => s + agg.sources[c], 0);
  if (totP > 0 && totS > 0) {
    for (const c of env.identity) {
      const gap = agg.pips[c] / totP - agg.sources[c] / totS - 0.08;
      if (gap > 0) colorP += 60 * gap;
    }
  }
  const cons = consistencyOdds({
    lands: agg.lands, ramp: agg.roles.ramp || 0, draw: agg.roles.draw || 0, interaction: agg.interaction,
    cheap: agg.curve[0] + agg.curve[1] + agg.curve[2], expensive: agg.curve[6] + agg.curve[7], size: Math.max(agg.size, 1),
  });
  const F = agg.value + LAND_W * agg.landValue - roleP - curveP - colorP + CONS_W * cons.score;
  return { F, value: agg.value, landValue: agg.landValue, roleP, curveP, colorP, consistency: cons.score, odds: cons };
}

// ---------------------------------------------------------------- search

/**
 * deckEntries: [{info, eval, qty}] (the 99, commander excluded); candidates: [{info, eval}] (not in deck).
 * opts: {maxSwaps=10, minGain=2, locked:Set(normName), targetBracket, ctx, identity[], avgMv, themes[], comboBlock(k)→bool}
 * Returns {swaps:[{out, in, gain, parts, outEval, inEval}], before, after, landRange, rejected}.
 */
export function optimize(deckEntries, candidates, opts = {}) {
  const { maxSwaps = 10, minGain = 2, locked = new Set(), targetBracket = null, ctx = null, identity = [], avgMv = 3, themes = [], targets = null, deckIdentity = null } = opts;
  const units = [];
  for (const e of deckEntries) {
    const u = unitOf(e);
    for (let i = 0; i < Math.max(1, e.qty || 1); i++) units.push({ ...u });
  }
  const agg = emptyAgg();
  for (const u of units) apply(agg, u, 1);
  const cheapRamp = units.filter((u) => !u.land && u.mv <= 2 && u.roles.includes('ramp')).length;
  const range = landRange(ctx, avgMv, themes, cheapRamp);
  const env = { curveT: curveTarget(ctx, agg.size - agg.lands), curveNonland: agg.size - agg.lands, identity, landRange: range, targets };
  const before = objective(agg, env);
  const gcLimit = targetBracket === 3 ? 3 : targetBracket && targetBracket <= 2 ? 0 : Infinity;
  const inDeck = new Set(units.map((u) => u.k));
  // color identity is a hard rule: a candidate with a known identity outside the deck's never enters
  const allowedCi = deckIdentity ?? (identity.length ? identity.join('') : null);
  const pool = candidates.map(unitOf).filter((c) => !inDeck.has(c.k) && (allowedCi == null || c.ci == null || withinIdentity(c.ci, allowedCi)));
  const removed = new Set();
  const added = new Set();
  const swaps = [];
  // inside the range, or at least not farther from it than before the swap
  const landOk = (lands, from) => (lands >= range[0] && lands <= range[1]) || Math.abs(lands - clampTo(lands, range)) <= Math.abs(from - clampTo(from, range));

  // Cards that break the target bracket must leave first (hard constraint): Game Changers / MLD / extra
  // turns flagged by the evaluation, and the weakest Game Changers above the bracket-3 limit of 3.
  const mustOut = () => {
    const flagged = units.filter((u) => u.eval?.bracketBlock && !added.has(u.k) && !locked.has(u.k));
    if (flagged.length) return new Set(flagged.map((u) => u.k));
    if (agg.gc > gcLimit) {
      const gcs = units.filter((u) => u.gc && !added.has(u.k) && !locked.has(u.k)).sort((a, b) => a.value - b.value);
      if (!gcs.length) return null;
      return new Set(gcs.slice(0, agg.gc - gcLimit).map((u) => u.k));
    }
    return null;
  };

  for (let step = 0; step < maxSwaps; step++) {
    const cur = objective(agg, env);
    let best = null;
    const forced = mustOut();
    // dedupe identical outs (basics): try each distinct key once
    const seenOut = new Set();
    for (let i = 0; i < units.length; i++) {
      const out = units[i];
      if (forced ? !forced.has(out.k) : locked.has(out.k) || added.has(out.k)) continue;
      if (seenOut.has(out.k)) continue;
      seenOut.add(out.k);
      apply(agg, out, -1);
      for (const cand of pool) {
        if (removed.has(cand.k) || inDeck.has(cand.k)) continue;
        const landsAfter = agg.lands + (cand.land ? 1 : 0);
        if (!landOk(landsAfter, agg.lands + (out.land ? 1 : 0))) continue;
        if (cand.gc && agg.gc + 1 > gcLimit) continue;
        apply(agg, cand, 1);
        const o = objective(agg, env);
        apply(agg, cand, -1);
        const gain = o.F - cur.F;
        if (!best || gain > best.gain) best = { i, out, cand, gain, o };
      }
      apply(agg, out, 1);
    }
    if (!best || (best.gain < minGain && !forced)) break;
    if (forced) best.forced = true;
    apply(agg, best.out, -1);
    apply(agg, best.cand, 1);
    units.splice(best.i, 1);
    units.push(best.cand);
    if (!units.some((u) => u.k === best.out.k)) inDeck.delete(best.out.k);
    inDeck.add(best.cand.k);
    removed.add(best.out.k);
    added.add(best.cand.k);
    swaps.push({
      out: best.out,
      in: best.cand,
      ...(best.forced ? { forced: best.out.eval?.bracketBlock || `Game Changers acima do limite do bracket ${targetBracket}` } : {}),
      gain: round1(best.gain),
      parts: {
        value: round1((best.cand.land ? LAND_W : 1) * best.cand.value - (best.out.land ? LAND_W : 1) * best.out.value),
        roles: round1(cur.roleP - best.o.roleP),
        curve: round1(cur.curveP - best.o.curveP),
        colors: round1(cur.colorP - best.o.colorP),
        consistency: round1(CONS_W * (best.o.consistency - cur.consistency)),
      },
    });
  }
  const after = objective(agg, env);
  return { swaps, before: summarize(before), after: summarize(after), landRange: range, roles: { ...agg.roles }, lands: agg.lands, poolSize: pool.length, units };
}

/**
 * Re-score a fixed list of swaps (e.g. after the simulation undid some): {swaps (with fresh gains/parts), before, after}.
 * swaps: [{out: unit, in: unit}] as returned by optimize().
 */
export function replay(deckEntries, swaps, opts = {}) {
  const { ctx = null, identity = [], avgMv = 3, themes = [], targets = null } = opts;
  const agg = emptyAgg();
  let cheapRamp = 0;
  for (const e of deckEntries) {
    const u = unitOf(e);
    for (let i = 0; i < Math.max(1, e.qty || 1); i++) apply(agg, u, 1);
    if (!u.land && u.mv <= 2 && u.roles.includes('ramp')) cheapRamp += Math.max(1, e.qty || 1);
  }
  const range = landRange(ctx, avgMv, themes, cheapRamp);
  const env = { curveT: curveTarget(ctx, agg.size - agg.lands), curveNonland: agg.size - agg.lands, identity, landRange: range, targets };
  const before = objective(agg, env);
  const out = [];
  for (const s of swaps) {
    const cur = objective(agg, env);
    apply(agg, s.out, -1);
    apply(agg, s.in, 1);
    const o = objective(agg, env);
    out.push({
      ...s,
      gain: round1(o.F - cur.F),
      parts: {
        value: round1((s.in.land ? LAND_W : 1) * s.in.value - (s.out.land ? LAND_W : 1) * s.out.value),
        roles: round1(cur.roleP - o.roleP),
        curve: round1(cur.curveP - o.curveP),
        colors: round1(cur.colorP - o.colorP),
        consistency: round1(CONS_W * (o.consistency - cur.consistency)),
      },
    });
  }
  return { swaps: out, before: summarize(before), after: summarize(objective(agg, env)), landRange: range };
}

const clampTo = (x, [lo, hi]) => Math.max(lo, Math.min(hi, x));
const round1 = (x) => Math.round(x * 10) / 10;

function summarize(o) {
  return {
    score: round1(o.F),
    cardValue: round1(o.value + LAND_W * o.landValue),
    rolePenalty: round1(-o.roleP),
    curvePenalty: round1(-o.curveP),
    colorPenalty: round1(-o.colorP),
    consistency: round1(o.consistency),
    odds: Object.fromEntries(Object.entries(o.odds).filter(([k]) => k !== 'score').map(([k, v]) => [k, Math.round(v * 1000) / 10])),
  };
}
