// Deck review: what the deck is trying to do (engine of each theme: enablers × payoffs, closers, card flow),
// a per-area scorecard, and concrete IMPROVEMENT OPTIONS — small packages of 1-for-1 swaps, each aimed at one
// problem and checked with the Monte Carlo goldfish before being shown.
// Everything is computed from the live deck in the current call: no notes, plans or results from earlier
// sessions are read or written. EDHREC is only one reference among the candidate sources.

import { heuristicSynergy, rolePt, ROLE_TARGETS, themesOf } from './analysis.mjs';
import { findCard, getCache } from './cache.mjs';
import { withinIdentity } from './commander.mjs';
import { goldfish, goldfishScore, simCard } from './simulate.mjs';
import { CORE_ROLES } from './roles.mjs';
import { normName } from './store.mjs';
import { bracketProblem, combosWith, evaluate, infoFromRecord } from './triangulate.mjs';

const r1 = (x) => Math.round(x * 10) / 10;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const textOf = (c) => `${c.text || ''}\n${c.typeLine || ''}`.toLowerCase();
const qtyOf = (c) => Math.max(1, Number(c.qty) || 1);
const sumQ = (arr) => arr.reduce((s, c) => s + qtyOf(c), 0);

// ---------------------------------------------------------------- engine (plan) analysis

const is = (re) => (c) => re.test(textOf(c));
const any = (...fns) => (c) => fns.some((f) => f(c));
const typeIs = (re) => (c) => re.test(String(c.typeLine || '').split('//')[0].toLowerCase());

/**
 * For each theme: enablers (cards that feed the plan) and payoffs (cards that turn it into advantage or damage).
 * A deck with plenty of enablers and few payoffs "does things" but runs out of gas; the reverse stalls.
 */
export const ENGINES = {
  landfall: {
    label: 'landfall / terrenos',
    enabler: any(
      (c) => !c.isLand && c.roles.has('ramp') && /search your library for[^.]*\b(lands?|forests?|plains|islands?|swamps?|mountains?)\b|put (a|up to \w+) land cards?|additional lands?/.test(textOf(c)),
      is(/you may play (an )?additional lands?|play lands? from (the top of your library|your graveyard)|return [^.]*\blands?\b[^.]* to (its owner's|your) hand|put (a|up to \w+) land cards? from your (hand|graveyard) onto the battlefield/),
      (c) => c.isLand && /sacrifice [^.]*: search your library|sacrifice this[^.]*search/.test(textOf(c)),
    ),
    payoff: is(/\blandfall\b|whenever (a|one or more|another) (other )?lands? (you control )?(enters|is put onto|are put onto)|for each land you control|\bearthbend|lands you control (are|become|have)|land creatures?/),
  },
  tokens: {
    label: 'fichas',
    enabler: (c) => c.roles.has('tokens'),
    payoff: any((c) => c.roles.has('anthem'), is(/whenever (a|one or more|another) (nontoken )?(creature )?tokens?|for each (creature|token)[^.]*you control|whenever one or more (other )?creatures you control (attack|enter)|populate|creatures you control (get|have|gain)/)),
  },
  counters: {
    label: 'marcadores +1/+1',
    enabler: is(/\+1\/\+1 counters? on|\bproliferate\b|enters? with [^.]*\+1\/\+1 counters?|\badapt\b|\bmonstrosity\b|\bbolster\b|\bsupport\b|\bevolve\b|\boutlast\b|\bearthbend/),
    payoff: is(/twice that many|that many plus one|additional \+1\/\+1|for each \+1\/\+1 counter|whenever one or more \+1\/\+1 counters? (are|is) put|with (a |one or more )?\+1\/\+1 counters? on (it|them)|counters? would be put/),
  },
  sacrifice: {
    label: 'sacrifício',
    enabler: (c) => c.roles.has('sac-outlet') || c.roles.has('tokens'),
    payoff: is(/whenever (a|another|one or more) (other )?(nontoken )?(creatures?|permanents?|artifacts?)( you control)? (dies|die|is put into a graveyard)|whenever you sacrifice/),
  },
  graveyard: {
    label: 'cemitério',
    enabler: is(/\bmills?\b|\bsurveil\b|\bdiscard\b|put the top [^.]* into your graveyard|\bdredge\b/),
    payoff: any((c) => c.roles.has('recursion'), is(/from your graveyard|for each [^.]*cards? in your graveyard|\bdelirium\b|\bthreshold\b|\bescape\b|\bunearth\b/)),
  },
  spells: {
    label: 'mágicas instantâneas/feitiços',
    enabler: typeIs(/\b(instant|sorcery)\b/),
    payoff: is(/whenever you cast (an? |your )?(instant|sorcery|noncreature|first)|\bmagecraft\b|\bprowess\b|copy target (instant|sorcery)/),
  },
  artifacts: {
    label: 'artefatos',
    enabler: any(typeIs(/\bartifact\b/), is(/create (a|an|two|three|x|\w+) (treasure|clue|food|blood|map|powerstone|gold)/)),
    payoff: is(/whenever (an|another|one or more) (nontoken )?artifacts?|for each artifact|artifacts? you control (have|get)|\baffinity for artifacts\b|\bimprovise\b|\bmetalcraft\b/),
  },
  enchantments: {
    label: 'encantamentos',
    enabler: typeIs(/\benchantment\b/),
    payoff: is(/\bconstellation\b|whenever (an|another) (nontoken )?enchantment|for each enchantment|enchantments? you control (have|get)/),
  },
  lifegain: {
    label: 'ganho de vida',
    enabler: (c) => c.roles.has('lifegain'),
    payoff: is(/whenever you gain life|for each 1 life you gained|life you gained this turn|if you gained life this turn/),
  },
  equipment: {
    label: 'equipamentos',
    enabler: typeIs(/\bequipment\b/),
    payoff: is(/equipped creatures? you control|becomes equipped|equip abilities you activate cost|for each equipment|attach (target|an?) equipment/),
  },
};

/** Cards that can actually close a game: explicit win cons, big bodies, mass pump/evasion, drain, big payoffs. */
export function isCloser(c, th) {
  if (c.isLand) return false;
  if (c.roles.has('wincon')) return true;
  if (c.power != null && c.power >= 5) return true;
  if (c.roles.has('anthem') || (c.roles.has('evasion') && /creatures you control/.test(textOf(c)))) return true;
  if (/each opponent loses|deals? (x|\d+) damage to each opponent|double (the )?(damage|power)|gets \+x\/\+x|extra combat|additional combat/.test(textOf(c))) return true;
  if (c.mv >= 5 && th && heuristicSynergy(c, th) >= 0.67) return true;
  return false;
}

/** Card-draw permanent that keeps giving cards (not a one-shot). */
export const isEngine = (c) => c.roles.has('draw') && !/\b(instant|sorcery)\b/i.test(c.typeLine || '') && /(whenever|at the beginning of|\{t\}[^:]*:|landfall)/i.test(c.text || '');

/**
 * Plan report: for each theme the deck plays, enablers vs payoffs, plus closers and card flow.
 * infos: card infos of the 99 (with qty); commanders: infos of the commander(s); plan: the user's words.
 * Main themes (the user's plan, then the two biggest engines) get a status and advice; the rest are listed as
 * secondary. Themes that only show up in the deck's text (not the commander nor the plan) need a real engine
 * (≥ 4 payoffs and ≥ 6 enablers) to be reported at all — a few fetch lands do not make a "sacrifice" deck.
 * When the commander itself is a payoff of a theme it counts as 3 payoffs (it is always available).
 */
export function engineReport(infos, th, { commanders = [], plan = null } = {}) {
  const nonland = infos.filter((c) => !c.isLand);
  const fromPlan = new Set(themesOf(plan));
  const fromDeck = new Set(th.fromDeck || []);
  const rows = [];
  for (const t of th.themes) {
    const e = ENGINES[t];
    if (!e) continue;
    const en = infos.filter((c) => e.enabler(c));
    const pay = nonland.filter((c) => e.payoff(c));
    const cmdPayoff = commanders.some((c) => e.payoff(c));
    const nEn = sumQ(en);
    const nPay = sumQ(pay) + (cmdPayoff ? 3 : 0);
    const source = fromPlan.has(t) ? 'plano' : fromDeck.has(t) && !cmdPayoff ? 'deck' : 'comandante';
    if (source === 'deck' && (nPay < 4 || nEn < 6)) continue;
    rows.push({ t, e, en, pay, nEn, nPay, cmdPayoff, source });
  }
  rows.sort((a, b) => (b.source === 'plano') - (a.source === 'plano') || b.nEn + 2 * b.nPay - (a.nEn + 2 * a.nPay));
  const main = new Set([...rows.filter((r) => r.source === 'plano').map((r) => r.t), ...rows.slice(0, 2).map((r) => r.t)]);
  const themes = rows.map(({ t, e, en, pay, nEn, nPay, cmdPayoff, source }) => {
    let status = main.has(t) ? 'equilibrado' : 'secundário';
    let advice = null;
    if (main.has(t)) {
      if (nPay < 5) {
        status = 'poucos payoffs';
        advice = `Só ${nPay} payoff(s) transformam ${e.label} em vantagem${cmdPayoff ? ' (contando o comandante)' : ''}: o deck executa o plano mas não converte. Troque habilitadores repetidos/fracos por payoffs.`;
      } else if (nEn < 8) {
        status = 'poucos habilitadores';
        advice = `Só ${nEn} carta(s) alimentam ${e.label}: os payoffs ficam parados na mão. Adicione habilitadores baratos.`;
      } else if (nEn > 3.5 * nPay && nPay < 9) {
        status = 'muita base, pouco retorno';
        advice = `${nEn} habilitadores para ${nPay} payoffs: parte da base pode virar payoff ou compra.`;
      }
    }
    return {
      theme: t,
      label: e.label,
      source,
      enablers: nEn,
      payoffs: nPay,
      ...(cmdPayoff ? { commanderIsPayoff: true } : {}),
      status,
      ...(advice ? { advice } : {}),
      enablerCards: en.map((c) => c.name).slice(0, 20),
      payoffCards: pay.map((c) => c.name).slice(0, 20),
    };
  });
  const closers = nonland.filter((c) => isCloser(c, th));
  const engines = nonland.filter(isEngine);
  const draw = nonland.filter((c) => c.roles.has('draw'));
  const ramp = nonland.filter((c) => c.roles.has('ramp'));
  const mainEngines = themes.filter((t) => t.status !== 'secundário');
  // "gas": cards that keep generating something once the mana is there
  const gas = nonland.filter((c) => c.roles.has('draw') || isCloser(c, th) || mainEngines.some((t) => ENGINES[t.theme].payoff(c)));
  return {
    themes,
    closers: { count: sumQ(closers), cards: closers.map((c) => c.name) },
    drawEngines: { count: sumQ(engines), cards: engines.map((c) => c.name) },
    rampToGas: { ramp: sumQ(ramp), gas: sumQ(gas), ratio: sumQ(gas) ? r1(sumQ(ramp) / sumQ(gas)) : null },
    draw: sumQ(draw),
  };
}

// ---------------------------------------------------------------- simulation helpers

export function simulateInfos(infos, commanderInfo, identity, { games = 2000, seed = 42 } = {}) {
  const cards = [];
  for (const info of infos) for (let i = 0; i < qtyOf(info); i++) cards.push(simCard(info, identity));
  const cmd = commanderInfo ? simCard(commanderInfo, identity) : null;
  const r = goldfish(cards, cmd, { games, seed, identity });
  return { ...r, score: goldfishScore(r) };
}

/** Apply 1-for-1 swaps [{out: name, in: info}] to a list of infos (qty-aware). */
export function swapInfos(infos, swaps) {
  const out = infos.map((x) => ({ ...x }));
  for (const s of swaps) {
    const k = normName(s.out);
    const i = out.findIndex((x) => normName(x.name) === k);
    if (i >= 0) {
      if (qtyOf(out[i]) > 1) out[i].qty = qtyOf(out[i]) - 1;
      else out.splice(i, 1);
    }
    const j = out.findIndex((x) => normName(x.name) === normName(s.in.name));
    if (j >= 0) out[j].qty = qtyOf(out[j]) + 1;
    else out.push({ ...s.in, qty: 1 });
  }
  return out;
}

// ---------------------------------------------------------------- candidates

/**
 * Candidate pool from several sources, so EDHREC is not the only way in: EDHREC lists (commander, theme,
 * bracket, average deck) + local card database search for roles below target + cheap ramp/draw/interaction
 * that make the deck flow + cards whose text matches the deck's themes (enablers AND payoffs of each engine).
 * Every candidate must be inside the commander's color identity (hard rule), Commander-legal and inside the
 * target bracket. Returns {candidates: [{info, eval, sources}], rejected}.
 */
export function candidatePool(deck, ctx, tri, { mode, targetBracket, deckCi }) {
  const cache = getCache();
  const have = tri.have;
  const names = new Map();
  const add = (n, src) => {
    const k = normName(n);
    if (have.has(k)) return;
    if (!names.has(k)) names.set(k, { name: n, sources: new Set() });
    names.get(k).sources.add(src);
  };
  if (ctx.base?.found) for (const c of ctx.base.cards.values()) add(c.name, 'EDHREC comandante');
  if (ctx.theme) for (const c of ctx.theme.page.cards.values()) add(c.name, `EDHREC tema ${ctx.theme.slug}`);
  if (ctx.bracket) for (const c of ctx.bracket.page.cards.values()) add(c.name, `EDHREC bracket ${ctx.bracket.bracket}`);
  if (ctx.avg) for (const c of ctx.avg.cards.values()) add(c.name, 'deck médio EDHREC');
  const counts = {};
  for (const [, info] of tri.infos) for (const r of info.roles) if (!info.isLand) counts[r] = (counts[r] || 0) + info.qty;
  if (cache?.hasCards) {
    const ok = (c) => c.legal === 'legal' && withinIdentity(c.ci, deckCi || 'C') && !have.has(normName(c.name)) && !/\bland\b/i.test(String(c.type).split('//')[0]);
    const byRank = (a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9);
    // roles below target → best-ranked cards of that role in the colors
    for (const [role, [min]] of Object.entries(ROLE_TARGETS)) {
      if (!min || (counts[role] || 0) >= min) continue;
      cache.list.filter((c) => ok(c) && c.roles.includes(role)).sort(byRank).slice(0, 25).forEach((c) => add(c.name, `banco de cartas: ${rolePt(role)}`));
    }
    // fluidity: the best cheap ramp, card draw and interaction in the colors
    for (const role of ['ramp', 'draw', 'removal']) {
      cache.list.filter((c) => ok(c) && c.roles.includes(role) && Number(c.mv) <= 2).sort(byRank).slice(0, 15).forEach((c) => add(c.name, `banco de cartas: ${rolePt(role)} barato`));
    }
    // card-draw engines (permanents that keep drawing): what keeps a deck from running out of gas
    cache.list
      .filter((c) => ok(c) && c.roles.includes('draw') && Number(c.mv) <= 4 && isEngine({ roles: new Set(c.roles), typeLine: c.type, text: c.text }))
      .sort(byRank)
      .slice(0, 20)
      .forEach((c) => add(c.name, 'banco de cartas: motor de compra'));
    // the deck's own engines: enablers and payoffs of every theme it plays
    for (const t of tri.th.themes) {
      const e = ENGINES[t];
      if (!e) continue;
      const asInfo = (c) => ({ name: c.name, text: c.text || '', typeLine: c.type || '', roles: new Set(c.roles || []), isLand: false, mv: Number(c.mv) || 0 });
      cache.list.filter((c) => ok(c) && Number(c.mv) <= 6 && e.payoff(asInfo(c))).sort(byRank).slice(0, 25).forEach((c) => add(c.name, `banco de cartas: payoff de ${e.label}`));
      cache.list.filter((c) => ok(c) && Number(c.mv) <= 4 && e.enabler(asInfo(c))).sort(byRank).slice(0, 15).forEach((c) => add(c.name, `banco de cartas: habilitador de ${e.label}`));
    }
    // text synergy with the commander/plan, even if EDHREC does not list the card
    if (tri.th.themes.length) {
      cache.list
        .filter((c) => ok(c) && Number(c.mv) <= 5)
        .map((c) => ({ c, h: heuristicSynergy({ text: c.text || '', typeLine: c.type || '', roles: new Set(c.roles || []), subtypes: [] }, tri.th) }))
        .filter((x) => x.h >= 0.5)
        .sort((a, b) => b.h - a.h || byRank(a.c, b.c))
        .slice(0, 30)
        .forEach(({ c }) => add(c.name, `banco de cartas: sinergia de texto (${tri.th.themes.join('/')})`));
    }
  }
  const out = [];
  const rejected = { unknown: 0, color: 0, legality: 0, bracket: 0, combo: 0 };
  for (const { name, sources } of names.values()) {
    const rec = findCard(name);
    if (!rec) {
      rejected.unknown++;
      continue;
    }
    if (rec.legal !== 'legal') {
      rejected.legality++;
      continue;
    }
    if (rec.ci == null || !withinIdentity(rec.ci, deckCi || 'C')) {
      rejected.color++;
      continue;
    }
    const info = infoFromRecord(rec);
    if (bracketProblem(info, targetBracket)) {
      rejected.bracket++;
      continue;
    }
    const k = normName(rec.name);
    if (targetBracket && targetBracket <= 2 && combosWith(k, ctx, new Set([...have, k])).length) {
      rejected.combo++;
      continue;
    }
    const ev = evaluate(info, ctx, tri.th, { mode, targetBracket, have: new Set([...have, k]) });
    out.push({ info, eval: ev, sources: [...sources] });
  }
  return { candidates: out, rejected };
}

/** Role counts of EDHREC's average deck (reference for role targets), or null when too few cards are known. */
export function avgRoleCounts(ctx) {
  if (!ctx?.avg) return null;
  const out = {};
  let known = 0;
  for (const c of ctx.avg.cards.values()) {
    const rec = findCard(c.name);
    if (!rec || /\bland\b/i.test(String(rec.type).split('//')[0])) continue;
    known++;
    for (const r of infoFromRecord(rec).roles) out[r] = (out[r] || 0) + (c.qty || 1);
  }
  return known >= 30 ? out : null;
}

// ---------------------------------------------------------------- scorecard

/** Grades 0–10 per area, each with the number that drove it. */
export function scorecard({ analysis, sim, engine, tri }) {
  const nonland = tri.cards.filter((c) => !c.isLand);
  const avgValue = nonland.reduce((s, c) => s + c.value * c.qty, 0) / Math.max(1, nonland.reduce((s, c) => s + c.qty, 0));
  const weak = nonland.filter((c) => ['corte', 'duvidosa'].includes(c.verdict)).reduce((s, c) => s + c.qty, 0);
  const lt = analysis._landTarget;
  const lands = analysis.mana.lands;
  const landOff = lands < lt[0] ? lt[0] - lands : lands > lt[1] ? lands - lt[1] : 0;
  const tapped = analysis.mana.tappedLands.length;
  const roles = analysis.roles;
  const avgH = nonland.reduce((s, c) => s + (c.components?.text ?? 0) * c.qty, 0) / Math.max(1, nonland.reduce((s, c) => s + c.qty, 0));
  const minPay = engine.themes.length ? Math.min(...engine.themes.map((t) => t.payoffs)) : null;
  const g = (x) => r1(clamp(x, 0, 10));
  const areas = [
    {
      area: 'Base de mana',
      grade: g(10 - sim.screwT4Pct / 4 - sim.colorScrewT4Pct / 4 - Math.max(0, tapped - 3) * 0.5 - landOff * 0.7),
      key: `travou em terreno no T4 ${sim.screwT4Pct}% · faltou cor no T4 ${sim.colorScrewT4Pct}% · ${lands} terrenos (faixa ${lt[0]}-${lt[1]}) · ${tapped} virados`,
    },
    {
      area: 'Início de jogo',
      grade: g(10 - sim.deadTurnsT2toT5 * 9 - Math.max(0, 75 - (sim.commanderByNextTurnPct ?? 75)) / 10 - Math.max(0, 12 - analysis.fluidity.earlyPlays.count) * 0.25),
      key: `${sim.deadTurnsT2toT5} turno(s) morto(s) T2–T5 · comandante até 1 turno depois do custo ${sim.commanderByNextTurnPct ?? '—'}% · ${analysis.fluidity.earlyPlays.count} jogadas de MV ≤ 2`,
    },
    {
      area: 'Gás (cartas e ameaças)',
      grade: g(10 - sim.outOfGasT6Pct / 3.5 + Math.min(2, engine.drawEngines.count * 0.4) - Math.max(0, 3 - engine.drawEngines.count) * 0.7),
      key: `sem mágica na mão no T6 ${sim.outOfGasT6Pct}% · ${engine.drawEngines.count} motor(es) de compra · ${roles.draw.count} compra · ramp ${engine.rampToGas.ramp} × gás ${engine.rampToGas.gas}`,
    },
    {
      area: 'Interação',
      grade: g(((Math.min(1, roles.removal.count / 8) * 0.6 + Math.min(1, roles.wipe.count / 2) * 0.25 + Math.min(1, (analysis.interaction.instantShare ?? 0) / 0.4) * 0.15) * 10)),
      key: `${roles.removal.count} remoções (${analysis.interaction.instant} instantâneas) · ${roles.wipe.count} wipes`,
    },
    {
      area: 'Plano e sinergia',
      grade: g(avgH * 10 * 0.6 + (minPay == null ? 3 : Math.min(4, minPay * 0.5)) + Math.min(1.5, engine.closers.count * 0.2)),
      key: `${engine.themes.map((t) => `${t.label}: ${t.enablers} habilitadores × ${t.payoffs} payoffs`).join(' · ') || 'sem tema claro'} · ${engine.closers.count} finalizadores`,
    },
    {
      area: 'Resiliência',
      grade: g(Math.min(5, roles.protection.count * 1.25) + Math.min(5, roles.recursion.count * 1.25)),
      key: `${roles.protection.count} proteção · ${roles.recursion.count} recursão`,
    },
    {
      area: 'Qualidade das cartas',
      grade: g((avgValue - 30) / 4 - weak * 0.15),
      key: `valor médio ${Math.round(avgValue)}/100 · ${weak} carta(s) duvidosas/corte`,
    },
  ];
  const w = [1.2, 1.2, 1.2, 0.9, 1.0, 0.6, 1.0];
  const overall = r1(areas.reduce((s, a, i) => s + a.grade * w[i], 0) / w.reduce((s, x) => s + x, 0));
  return { overall, areas };
}

// ---------------------------------------------------------------- improvement options

const BASIC = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };

/**
 * Build improvement options. Each option targets one problem with ≤ maxSwaps 1-for-1 swaps:
 *   cuts  — the weakest cards (own model value) that the problem allows to leave;
 *   adds  — the best candidates for that problem (inside the color identity, legal, bracket-safe);
 * cutting a card that holds a role at/below its minimum is only allowed for a replacement in the same role.
 * Every option is checked with the goldfish (same seed as the baseline) and reports value/role/simulation deltas.
 * ctx: {entries:[{info, eval, qty}], pool:[{info, eval, sources}], analysis, sim, engine, th, identity, commanderInfo, locked:Set, targets}
 */
export function improvementOptions(ctx, { maxSwaps = 4, games = 2000 } = {}) {
  const { entries, pool, analysis, sim, engine, th, identity, commanderInfo, locked = new Set(), targets = ROLE_TARGETS } = ctx;
  const infos = entries.map((e) => ({ ...e.info, qty: e.qty }));
  const valueOf = new Map(entries.map((e) => [normName(e.info.name), e.eval]));
  const roleCount = {};
  for (const e of entries) if (!e.info.isLand) for (const r of e.info.roles) roleCount[r] = (roleCount[r] || 0) + e.qty;
  const protectedRole = (r) => CORE_ROLES.includes(r) && targets[r] && targets[r][0] > 0 && (roleCount[r] || 0) <= targets[r][0];
  const cutsOf = (filter) =>
    entries
      .filter((e) => !locked.has(normName(e.info.name)) && filter(e))
      .sort((a, b) => a.eval.value - b.eval.value || a.info.name.localeCompare(b.info.name));
  const mainThemes = engine.themes.filter((t) => t.status !== 'secundário');
  const mainTheme = mainThemes[0] || null;
  const payoffOfTheme = (c) => mainThemes.some((t) => ENGINES[t.theme].payoff(c));
  const enablerOfTheme = (c) => mainThemes.some((t) => ENGINES[t.theme].enabler(c));
  // adding a card whose function is already above its maximum (e.g. a 23rd ramp) is worth less
  const overMax = (c, cut) => [...c.info.roles].filter((r) => targets[r] && (roleCount[r] || 0) >= targets[r][1] && !cut?.info.roles.has(r)).length;
  // cards the plan relies on: closers, payoffs, and good enablers of the main themes
  const keyCard = (e) => isCloser(e.info, th) || payoffOfTheme(e.info) || (enablerOfTheme(e.info) && e.eval.value >= 60);
  const H = (e) => e.eval?.components?.text ?? 0;
  const nonlandPool = pool.filter((c) => !c.info.isLand);

  /** Pair cuts with adds (greedy, best add first), respecting protected roles and the singleton rule. */
  function pair(cuts, adds, { score = (c) => c.eval.value, needGain = 0 } = {}) {
    const usedIn = new Set();
    const usedOut = new Set();
    const swaps = [];
    const ranked = adds.slice().sort((a, b) => score(b) - score(a));
    for (const cut of cuts) {
      if (swaps.length >= maxSwaps) break;
      const k = normName(cut.info.name);
      if (usedOut.has(k)) continue;
      const guard = [...cut.info.roles].filter(protectedRole);
      const add = ranked.find((c) => !usedIn.has(normName(c.info.name)) && guard.every((r) => c.info.roles.has(r)) && c.eval.value >= cut.eval.value + needGain);
      if (!add) continue;
      usedIn.add(normName(add.info.name));
      usedOut.add(k);
      swaps.push({ out: cut, in: add });
    }
    return swaps;
  }

  const options = [];
  const push = (id, title, problem, swaps) => {
    if (swaps.length) options.push({ id, title, problem, swaps });
  };

  // 1. Weakest cards → clearly better cards that do the same job (or fit the plan better)
  {
    const cuts = cutsOf((e) => !e.info.isLand && ['corte', 'duvidosa'].includes(e.eval.verdict));
    const adds = nonlandPool;
    const share = (cut) => (c) => c.eval.value + 12 * [...c.info.roles].filter((r) => CORE_ROLES.includes(r) && cut.info.roles.has(r)).length + 6 * (payoffOfTheme(c.info) ? 1 : 0) - 15 * overMax(c, cut);
    const swaps = [];
    const usedIn = new Set();
    for (const cut of cuts) {
      if (swaps.length >= maxSwaps) break;
      const guard = [...cut.info.roles].filter(protectedRole);
      // a direct upgrade does the same job (shares a basic function) or fits the plan better
      const fits = (c) => [...c.info.roles].some((r) => CORE_ROLES.includes(r) && cut.info.roles.has(r)) || payoffOfTheme(c.info) || enablerOfTheme(c.info) || (c.eval.components?.text ?? 0) >= 0.5;
      const best = adds
        .filter((c) => !usedIn.has(normName(c.info.name)) && guard.every((r) => c.info.roles.has(r)) && fits(c) && c.eval.value >= cut.eval.value + 12)
        .sort((a, b) => share(cut)(b) - share(cut)(a))[0];
      if (!best) continue;
      usedIn.add(normName(best.info.name));
      swaps.push({ out: cut, in: best });
    }
    push('upgrade', 'Trocar as cartas mais fracas', `${cuts.length} carta(s) avaliadas como duvidosas ou corte provável pelo modelo próprio.`, swaps);
  }

  // 2. Gas: card flow and payoffs, paid with surplus ramp (or the weakest off-role cards)
  const rampMax = targets.ramp?.[1] ?? 12;
  if (sim.outOfGasT6Pct >= 15 || engine.drawEngines.count < 3 || analysis.roles.draw.count < (targets.draw?.[0] ?? 10)) {
    const surplusRamp = (roleCount.ramp || 0) - rampMax;
    // pays with the weakest single-role ramp when ramp is above target (never a closer or a payoff of the plan),
    // otherwise with the weakest cards without a basic function
    const cuts = surplusRamp > 0
      ? cutsOf((e) => !e.info.isLand && e.info.roles.has('ramp') && e.eval.value < 80 && [...e.info.roles].filter((r) => CORE_ROLES.includes(r)).length === 1 && !isCloser(e.info, th) && !payoffOfTheme(e.info))
          // cheap ramp is what makes the early turns work: the slower/weaker ramp goes first
          .sort((a, b) => a.eval.value + (a.info.mv <= 2 ? 15 : 0) - (b.eval.value + (b.info.mv <= 2 ? 15 : 0)))
          .slice(0, Math.max(surplusRamp, 2) + 2)
      : cutsOf((e) => !e.info.isLand && ![...e.info.roles].some((r) => CORE_ROLES.includes(r)) && !keyCard(e));
    // what comes in must keep cards flowing (draw engines, real card draw) or turn the plan into advantage — not more ramp
    const realDraw = (c) => isEngine(c.info) || (c.info.roles.has('draw') && !c.info.roles.has('ramp'));
    const adds = nonlandPool.filter((c) => realDraw(c) || (payoffOfTheme(c.info) && !c.info.roles.has('ramp')));
    const swaps = pair(cuts, adds, { score: (c) => c.eval.value + (isEngine(c.info) ? 15 : 0) + (payoffOfTheme(c.info) ? 8 : 0) + (c.info.mv <= 3 ? 4 : 0) - 15 * overMax(c), needGain: -10 });
    push('gas', 'Mais gás: compra e payoffs', `Fica sem mágica na mão no T6 em ${sim.outOfGasT6Pct}% das partidas; ${engine.drawEngines.count} motor(es) de compra; ramp ${engine.rampToGas.ramp} para gás ${engine.rampToGas.gas}.${surplusRamp > 0 ? ` Ramp acima da meta (${roleCount.ramp} > ${rampMax}): paga com o ramp mais fraco.` : ''}`, swaps);
  }

  // 3. Early game: replace clunky expensive cards with cheap plays
  if (sim.deadTurnsT2toT5 >= 0.3 || analysis.fluidity.earlyPlays.count < 12) {
    const cuts = cutsOf((e) => !e.info.isLand && e.info.mv >= 4 && e.eval.value < 60 && !keyCard(e) && !e.info.roles.has('wipe'));
    const adds = nonlandPool.filter((c) => c.info.mv <= 2 && ([...c.info.roles].some((r) => CORE_ROLES.includes(r)) || payoffOfTheme(c.info) || enablerOfTheme(c.info)));
    const swaps = pair(cuts, adds, { score: (c) => c.eval.value + (c.info.mv <= 1 ? 4 : 0) + (payoffOfTheme(c.info) || enablerOfTheme(c.info) ? 6 : 0) - 15 * overMax(c), needGain: -8 });
    push('early', 'Começo mais rápido: menos turnos mortos', `${sim.deadTurnsT2toT5} turno(s) sem jogar nada entre o T2 e o T5; ${analysis.fluidity.earlyPlays.count} cartas de MV ≤ 2.`, swaps);
  }

  // 4. Top end: dead expensive cards out
  if (analysis.fluidity.deadTopEnd.count >= 2 || analysis.mana.avgMv > 3.4) {
    const dead = new Set(analysis.fluidity.deadTopEnd.cards.map(normName));
    const cuts = cutsOf((e) => !e.info.isLand && (dead.has(normName(e.info.name)) || (e.info.mv >= 6 && !keyCard(e))));
    const adds = nonlandPool.filter((c) => c.info.mv <= 3);
    const swaps = pair(cuts, adds, { score: (c) => c.eval.value - 15 * overMax(c), needGain: -10 });
    push('curve', 'Curva mais leve', `MV médio ${analysis.mana.avgMv}; ${analysis.fluidity.deadTopEnd.count} carta(s) caras sem função que travam a mão.`, swaps);
  }

  // 5. Interaction
  const remMin = targets.removal?.[0] ?? 8;
  const wipeMin = targets.wipe?.[0] ?? 2;
  if (analysis.roles.removal.count < remMin || analysis.roles.wipe.count < wipeMin || (analysis.interaction.instantShare ?? 1) < 0.3) {
    const cuts = cutsOf((e) => !e.info.isLand && !['removal', 'wipe', 'counter'].some((r) => e.info.roles.has(r)) && !keyCard(e) && !e.info.roles.has('draw'));
    const needWipe = analysis.roles.wipe.count < wipeMin;
    const adds = nonlandPool.filter((c) => c.info.roles.has('removal') || (needWipe && c.info.roles.has('wipe')));
    const swaps = pair(cuts, adds, { score: (c) => c.eval.value + (c.info.instant ? 6 : 0) + (c.info.mv <= 2 ? 4 : 0) + (needWipe && c.info.roles.has('wipe') ? 10 : 0) + (c.info.artEnch ? 3 : 0), needGain: -5 });
    push('interaction', 'Mais interação', `${analysis.roles.removal.count} remoções (meta ${remMin}+), ${analysis.roles.wipe.count} wipes (meta ${wipeMin}+), ${analysis.interaction.instant} instantâneas.`, swaps);
  }

  // 6. Plan: fix the engine of the main theme (missing payoffs or enablers), paid with off-plan cards
  const weakTheme = mainThemes.find((t) => t.status !== 'equilibrado');
  if (weakTheme || (mainTheme && mainTheme.payoffs < 8)) {
    const t = weakTheme || mainTheme;
    const e = ENGINES[t.theme];
    const wantPayoff = t.status !== 'poucos habilitadores';
    const cuts = cutsOf((x) => !x.info.isLand && H(x) < 0.34 && !e.payoff(x.info) && !e.enabler(x.info) && !keyCard(x));
    const adds = nonlandPool.filter((c) => (wantPayoff ? e.payoff(c.info) : e.enabler(c.info)));
    const swaps = pair(cuts, adds, { score: (c) => c.eval.value + (c.eval.components?.text ?? 0) * 15 - 15 * overMax(c), needGain: -5 });
    push('plan', `Reforçar o plano: ${t.label}`, `${t.label}: ${t.enablers} habilitadores × ${t.payoffs} payoffs (${t.status}). ${wantPayoff ? 'Entram payoffs' : 'Entram habilitadores'} no lugar de cartas fora do plano.`, swaps);
  }

  // 7. Mana base: tapped lands / missing colors → basics of the color the deck needs most
  const colorReq = analysis.fluidity.colorRequirements.filter((r) => r.prob < 0.75);
  const tapped = new Set(analysis.mana.tappedLands.map(normName));
  if (identity.length && (sim.colorScrewT4Pct >= 12 || tapped.size > 5 || colorReq.length)) {
    const pips = analysis.mana.pips;
    const src = analysis.mana.sources;
    const need = identity.slice().sort((a, b) => (pips[b] || 0) / Math.max(1, src[b] || 0) - (pips[a] || 0) / Math.max(1, src[a] || 0))[0];
    const rec = findCard(BASIC[need]);
    if (rec) {
      const basicIn = { info: infoFromRecord(rec), eval: { value: 50, verdict: 'terreno', why: ['terreno básico'], components: {} }, sources: ['base de mana'] };
      // lands that are part of the plan (fetch/landfall enablers) or have a utility role stay
      const cuts = cutsOf((e) => e.info.isLand && !e.info.isBasic && !enablerOfTheme(e.info) && ![...e.info.roles].some((r) => r !== 'ramp') && (tapped.has(normName(e.info.name)) || !e.info.produced.some((c) => identity.includes(c)))).slice(0, Math.min(maxSwaps, 3));
      const swaps = cuts.map((c) => ({ out: c, in: basicIn }));
      push('mana', `Base de mana: menos terrenos virados, mais ${BASIC[need]}`, `${tapped.size} terreno(s) entram virados; faltou cor no T4 em ${sim.colorScrewT4Pct}% das partidas; cor mais pedida em relação às fontes: ${need}.`, swaps);
    }
  }

  // ---- check every option with the simulation and describe it
  const base = sim.score;
  const valueOfCard = (c) => (c.info.isLand ? 0.6 : 1) * c.eval.value;
  const out = options.map((o) => {
    const after = simulateInfos(swapInfos(infos, o.swaps.map((s) => ({ out: s.out.info.name, in: s.in.info }))), commanderInfo, identity, { games });
    const valueDelta = r1(o.swaps.reduce((s, x) => s + valueOfCard(x.in) - valueOfCard(x.out), 0));
    const rolesAfter = { ...roleCount };
    for (const s of o.swaps) {
      if (!s.out.info.isLand) for (const r of s.out.info.roles) rolesAfter[r] = (rolesAfter[r] || 0) - 1;
      if (!s.in.info.isLand) for (const r of s.in.info.roles) rolesAfter[r] = (rolesAfter[r] || 0) + 1;
    }
    const roleMoves = ['ramp', 'draw', 'removal', 'wipe', 'protection', 'recursion']
      .filter((r) => (rolesAfter[r] || 0) !== (roleCount[r] || 0))
      .map((r) => `${rolePt(r)} ${roleCount[r] || 0}→${rolesAfter[r] || 0}`);
    const simDelta = r1(after.score - base);
    return {
      id: o.id,
      title: o.title,
      problem: o.problem,
      swaps: o.swaps.map((s) => ({
        out: { name: s.out.info.name, value: s.out.eval.value, verdict: s.out.eval.verdict, mv: s.out.info.mv },
        in: { name: s.in.info.name, value: s.in.eval.value, mv: s.in.info.mv, roles: [...s.in.info.roles].map(rolePt), sources: s.in.sources },
        why: swapWhy(s, th),
      })),
      effect: {
        valueDelta,
        roles: roleMoves,
        simulation: {
          score: `${base} → ${after.score} (${simDelta >= 0 ? '+' : ''}${simDelta})`,
          deadTurnsT2toT5: `${sim.deadTurnsT2toT5} → ${after.deadTurnsT2toT5}`,
          outOfGasT6Pct: `${sim.outOfGasT6Pct}% → ${after.outOfGasT6Pct}%`,
          wastedManaT2toT6: `${sim.wastedManaT2toT6} → ${after.wastedManaT2toT6}`,
          colorScrewT4Pct: `${sim.colorScrewT4Pct}% → ${after.colorScrewT4Pct}%`,
          commanderByNextTurnPct: `${sim.commanderByNextTurnPct ?? '—'}% → ${after.commanderByNextTurnPct ?? '—'}%`,
        },
      },
      // what matters most is how the deck plays (simulation), then card quality; options that make the
      // deck run out of cards sooner or add dead turns lose points
      _rank: 3 * simDelta + clamp(valueDelta / 30, -3, 3) - 0.4 * (after.outOfGasT6Pct - sim.outOfGasT6Pct) - 6 * (after.deadTurnsT2toT5 - sim.deadTurnsT2toT5),
      _simDelta: simDelta,
      _gasDelta: after.outOfGasT6Pct - sim.outOfGasT6Pct,
    };
  });
  // an option that makes the deck play worse in the simulation AND does not improve the cards is dropped
  const kept = out.filter((o) => !(o._simDelta < -1 && o.effect.valueDelta <= 0));
  kept.sort((a, b) => b._rank - a._rank);
  kept.forEach((o, i) => {
    o.rank = i + 1;
    o.verdict = o._simDelta >= -0.3 && o.effect.valueDelta > 0 && o._gasDelta <= 2 ? 'recomendada' : o._simDelta >= -0.3 || o.effect.valueDelta > 10 ? 'vale considerar' : 'troca de perfil (piora a simulação)';
    delete o._rank;
    delete o._simDelta;
    delete o._gasDelta;
  });
  return { options: kept, dropped: out.length - kept.length };
}

function swapWhy(s, th) {
  const o = s.out;
  const i = s.in;
  const parts = [];
  const outWhy = (o.eval.why || []).find((w) => /^modelo próprio/.test(w)) || '';
  parts.push(`sai ${o.info.name} (${o.eval.value}${o.eval.verdict ? `, ${o.eval.verdict}` : ''}${outWhy ? `; ${outWhy}` : ''})`);
  const roles = [...i.info.roles].filter((r) => CORE_ROLES.includes(r)).map(rolePt);
  const extras = [];
  if (i.info.mv <= 2) extras.push(`MV ${i.info.mv}`);
  if (i.info.instant) extras.push('instantânea');
  if (isEngine(i.info)) extras.push('motor de compra');
  if (th?.themes?.length && heuristicSynergy(i.info, th) >= 0.5) extras.push(`conversa com ${th.themes.join('/')}`);
  parts.push(`entra ${i.info.name} (${i.eval.value}${roles.length ? `; ${roles.join(', ')}` : ''}${extras.length ? `; ${extras.join(', ')}` : ''})`);
  return parts.join(' → ');
}
