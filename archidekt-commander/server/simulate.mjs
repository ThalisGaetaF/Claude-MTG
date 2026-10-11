// Consistency math: exact hypergeometric odds (fast, used inside the optimizer's objective) and a seeded
// Monte Carlo "goldfish" (plays the first turns alone, used for before/after reports).
// Pure functions, no I/O.

// ---------------------------------------------------------------- hypergeometric

const LOGF = [0];
for (let i = 1; i <= 400; i++) LOGF[i] = LOGF[i - 1] + Math.log(i);
const logC = (n, k) => (k < 0 || k > n ? -Infinity : LOGF[n] - LOGF[k] - LOGF[n - k]);

/** P(X = k) drawing n cards from N with K successes. */
export function hyperPmf(N, K, n, k) {
  if (k < 0 || k > n || k > K || n - k > N - K) return 0;
  return Math.exp(logC(K, k) + logC(N - K, n - k) - logC(N, n));
}

/** P(lo ≤ X ≤ hi). */
export function hyperRange(N, K, n, lo, hi = n) {
  let s = 0;
  for (let k = Math.max(0, lo); k <= Math.min(n, hi); k++) s += hyperPmf(N, K, n, k);
  return Math.min(1, s);
}

/**
 * Closed-form consistency ("does the deck run smoothly?") of a 99-card library from counts:
 * {lands, ramp, draw, interaction, cheap (nonland MV ≤ 2), expensive (nonland MV ≥ 6), size}.
 * On the play: T2 = 8 cards seen, T3 = 9, T4 = 10, T5 = 11, T6 = 12. cheap/expensive are optional.
 */
export function consistencyOdds({ lands, ramp, draw, interaction, cheap = null, expensive = null, size = 99 }) {
  const N = Math.max(1, size);
  const o = {
    keepable7: hyperRange(N, lands, 7, 2, 5), // 2–5 lands in the opening hand
    land4onT4: hyperRange(N, lands, 10, 4), // 4th land drop on time
    rampByT3: hyperRange(N, ramp, 9, 1),
    drawByT5: hyperRange(N, draw, 11, 1),
    interactionByT6: hyperRange(N, interaction, 12, 1),
  };
  const parts = [[0.26, o.keepable7], [0.22, o.land4onT4], [0.17, o.rampByT3], [0.17, o.drawByT5], [0.06, o.interactionByT6]];
  if (cheap != null) {
    o.earlyPlayByT2 = hyperRange(N, cheap, 8, 2); // two cheap plays to fill turns 1–3
    parts.push([0.07, o.earlyPlayByT2]);
  }
  if (expensive != null) {
    o.notClunkyT4 = hyperRange(N, expensive, 10, 0, 1); // at most one 6+ card stuck in hand by T4
    parts.push([0.05, o.notClunkyT4]);
  }
  const w = parts.reduce((s, [x]) => s + x, 0);
  o.score = (100 * parts.reduce((s, [x, v]) => s + x * v, 0)) / w;
  return o;
}

// ---------------------------------------------------------------- Monte Carlo goldfish

/** mulberry32: small seeded PRNG so before/after runs are comparable. */
export function rng(seed = 42) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, x: 2 };

/**
 * Build simulation cards from analysis infos (see analysis.cardInfo).
 * {name, land, mv, etbTapped, colors[], pips{}, ramp: 0|1|2, rampKind: 'rock'|'dork'|'land'|'other', landToHand,
 *  draw, drawN (cards drawn when cast), engine (permanent that keeps drawing)}
 */
export function simCard(info, identity = []) {
  const text = String(info.text || '').toLowerCase();
  const isRamp = !info.isLand && info.roles.has('ramp');
  let ramp = 0;
  let rampKind = null;
  let landToHand = false;
  if (isRamp) {
    const landSearch = /search your library for[^.]*\b(lands?|forests?|plains|islands?|swamps?|mountains?)\b[^.]*onto the battlefield/.test(text);
    if (landSearch) {
      ramp = 1;
      rampKind = 'land';
      landToHand = /into your hand/.test(text);
    } else {
      ramp = /add \{c\}\{c\}|add two mana|add \{[wubrg]\}\{[wubrg]\}/.test(text) ? 2 : 1;
      rampKind = /\bcreature\b/i.test(info.typeLine || '') ? 'dork' : /\bartifact\b/i.test(info.typeLine || '') ? 'rock' : 'other';
      if (rampKind === 'other' && !/\{t\}: add|add [^.]*for each|untap/.test(text)) ramp = 0; // one-shot rituals are not lasting ramp
    }
  }
  let drawN = 0;
  let engine = false;
  if (!info.isLand && info.roles.has('draw')) {
    const m = text.match(/draws? (a|an|one|two|three|four|five|x) (additional )?cards?/);
    const n = m ? NUM[m[1]] || 1 : 1;
    const permanent = !/\b(instant|sorcery)\b/i.test(info.typeLine || '');
    if (permanent && /(whenever|at the beginning of)[^.]*draws? /.test(text)) engine = true;
    else drawN = Math.min(3, n);
  }
  const colors = info.isLand ? info.produced.filter((c) => !identity.length || identity.includes(c)) : rampKind === 'land' ? [...identity] : info.produced;
  const p = {};
  for (const m of String(info.cost || '').toUpperCase().matchAll(/\{([WUBRG])\}/g)) p[m[1]] = (p[m[1]] || 0) + 1;
  return {
    name: info.name,
    land: !!info.isLand,
    mv: Number(info.mv) || 0,
    etbTapped: info.isLand && info.etb === 'tapped',
    colors: colors.length ? colors : info.isLand ? [...identity] : [],
    pips: p,
    ramp,
    rampKind,
    landToHand,
    draw: info.roles.has('draw'),
    drawN,
    engine,
  };
}

function castable(card, sources, mana) {
  if (card.mv > mana) return false;
  for (const [c, n] of Object.entries(card.pips)) {
    let have = 0;
    for (const s of sources) if (s.colors.includes(c)) have += s.amount;
    if (have < n) return false;
  }
  return true;
}

function keepable(hand) {
  const lands = hand.filter((c) => c.land).length;
  return lands >= 2 && lands <= 5;
}

/** Put n cards on the bottom (London mulligan): extra lands above 4, then the most expensive spells. */
function bottom(hand, n) {
  for (let i = 0; i < n; i++) {
    const lands = hand.filter((c) => c.land).length;
    let idx;
    if (lands > 4) idx = hand.findIndex((c) => c.land);
    else {
      let best = -1;
      hand.forEach((c, j) => {
        if (!c.land && (best < 0 || c.mv > hand[best].mv)) best = j;
      });
      idx = best >= 0 ? best : 0;
    }
    hand.splice(idx, 1);
  }
}

/**
 * Goldfish N games (on the play, one land per turn, greedy casting: commander → ramp → card draw → biggest spell).
 * Card draw resolves (one-shot draws N; engines draw about one card every other turn), so the report measures how
 * smoothly the deck flows: dead turns, wasted mana, cards stuck in hand, mana spent.
 * cards: simCard[] (the 99), commander: simCard | null. Returns aggregated odds/means.
 */
export function goldfish(cards, commander, { games = 2000, turns = 7, seed = 42, identity = [] } = {}) {
  const rand = rng(seed);
  const T = turns;
  const acc = {
    mull: 0, mulls: 0,
    landDrops: Array(T + 1).fill(0), // P(lands on battlefield ≥ t at end of turn t)
    mana: Array(T + 1).fill(0), // mean mana available at turn t
    spent: 0, cmdOnCurve: 0, cmdPlusOne: 0, cmdNever: 0, rampByT3: 0, screwT4: 0, floodT6: 0, stuckT5: 0, colorScrewT4: 0,
    deadTurns: 0, wasted: 0, seenT6: 0, emptyHandT6: 0,
  };
  const basic = { name: 'Terreno básico (buscado)', land: true, mv: 0, etbTapped: false, colors: [...identity], pips: {}, ramp: 0 };
  for (let g = 0; g < games; g++) {
    let lib;
    let hand;
    let m = 0;
    for (;;) {
      lib = shuffle(cards.slice(), rand);
      hand = lib.splice(0, 7);
      if (keepable(hand) || m >= 3) break;
      m++;
    }
    if (m >= 2) bottom(hand, m - 1); // first mulligan is free in Commander
    if (m) acc.mull++;
    acc.mulls += m;

    const lands = []; // {colors, amount, ready}
    const rocks = []; // {colors, amount, ready}
    let cmdCast = 0;
    let rampCast = 0;
    let spent = 0;
    let seen = hand.length;
    let landsSeen = hand.filter((c) => c.land).length;
    let engines = 0;
    const draw = (n) => {
      for (let i = 0; i < n && lib.length; i++) {
        const c = lib.shift();
        hand.push(c);
        seen++;
        if (c.land) landsSeen++;
      }
    };
    for (let t = 1; t <= T; t++) {
      if (t > 1) draw(1);
      for (let e = 0; e < engines; e++) if (rand() < 0.5) draw(1);
      // land drop: prefer an untapped land that adds a color we lack
      const have = new Set([...lands, ...rocks].flatMap((s) => s.colors));
      const landIdx = hand
        .map((c, i) => [c, i])
        .filter(([c]) => c.land)
        .sort(([a], [b]) => (a.etbTapped - b.etbTapped) || (b.colors.filter((x) => !have.has(x)).length - a.colors.filter((x) => !have.has(x)).length))[0]?.[1];
      if (landIdx != null) {
        const [l] = hand.splice(landIdx, 1);
        lands.push({ colors: l.colors, amount: 1, ready: l.etbTapped ? t + 1 : t });
      }
      const sources = [...lands, ...rocks].filter((s) => s.ready <= t);
      let mana = sources.reduce((s, x) => s + x.amount, 0);
      acc.mana[t] += mana;
      const manaAtStart = mana;
      let castThisTurn = 0;
      // casting
      let progress = true;
      while (progress) {
        progress = false;
        const options = hand.map((c, i) => [c, i]).filter(([c]) => !c.land && castable(c, sources, mana));
        const pick =
          (commander && !cmdCast && castable(commander, sources, mana) ? [commander, -1] : null) ||
          options.filter(([c]) => c.ramp > 0).sort(([a], [b]) => a.mv - b.mv)[0] ||
          options.filter(([c]) => c.draw).sort(([a], [b]) => b.mv - a.mv)[0] ||
          options.sort(([a], [b]) => b.mv - a.mv)[0];
        if (!pick) break;
        const [c, i] = pick;
        if (i === -1) cmdCast = t;
        else hand.splice(i, 1);
        mana -= c.mv;
        castThisTurn++;
        if (c.drawN) draw(c.drawN);
        if (c.engine) engines++;
        spent += t <= 6 ? c.mv : 0;
        if (c.ramp > 0) {
          if (t <= 3) rampCast++;
          if (c.rampKind === 'land') {
            lands.push({ colors: c.colors, amount: 1, ready: t + 1 });
            if (c.landToHand) hand.push(basic);
          } else rocks.push({ colors: c.colors.length ? c.colors : [], amount: c.ramp, ready: c.rampKind === 'dork' ? t + 1 : t });
          if (c.rampKind === 'rock') {
            // an untapped rock can be used right away
            const r = rocks[rocks.length - 1];
            sources.push(r);
            mana += r.amount;
          }
        }
        progress = true;
      }
      if (t >= 2 && t <= 5 && !castThisTurn) acc.deadTurns++;
      if (t >= 2 && t <= 6) acc.wasted += Math.max(0, Math.min(mana, manaAtStart));
      const landCount = lands.length;
      if (landCount >= t) acc.landDrops[t]++;
      if (t === 4) {
        if (landCount <= 2) acc.screwT4++;
        const colorsNow = new Set([...lands, ...rocks].flatMap((s) => s.colors));
        if (identity.some((c) => !colorsNow.has(c))) acc.colorScrewT4++;
      }
      if (t === 5) acc.stuckT5 += hand.filter((c) => !c.land && c.mv > landCount + rocks.reduce((s, r) => s + r.amount, 0)).length;
      if (t === 6 && seen && landsSeen / seen >= 0.6) acc.floodT6++;
      if (t === 6) {
        acc.seenT6 += seen;
        if (!hand.some((c) => !c.land)) acc.emptyHandT6++;
      }
    }
    if (commander) {
      if (cmdCast && cmdCast <= Math.max(1, commander.mv)) acc.cmdOnCurve++;
      if (cmdCast && cmdCast <= Math.max(1, commander.mv) + 1) acc.cmdPlusOne++;
      if (!cmdCast) acc.cmdNever++;
    }
    if (rampCast) acc.rampByT3++;
    acc.spent += spent;
  }
  const p = (x) => Math.round((x / games) * 1000) / 10; // %
  const mean = (x) => Math.round((x / games) * 100) / 100;
  return {
    games,
    seed,
    onThePlay: true,
    mulliganPct: p(acc.mull),
    avgMulligans: mean(acc.mulls),
    landDropOnTimePct: Object.fromEntries([1, 2, 3, 4, 5].map((t) => [`T${t}`, p(acc.landDrops[t])])),
    avgMana: Object.fromEntries([2, 3, 4, 5, 6].map((t) => [`T${t}`, mean(acc.mana[t])])),
    commanderOnCurvePct: commander ? p(acc.cmdOnCurve) : null,
    commanderByNextTurnPct: commander ? p(acc.cmdPlusOne) : null,
    rampByT3Pct: p(acc.rampByT3),
    screwT4Pct: p(acc.screwT4),
    colorScrewT4Pct: p(acc.colorScrewT4),
    floodT6Pct: p(acc.floodT6),
    stuckCardsT5: mean(acc.stuckT5),
    manaSpentByT6: mean(acc.spent),
    deadTurnsT2toT5: mean(acc.deadTurns), // turns 2–5 in which nothing was cast (0–4)
    wastedManaT2toT6: mean(acc.wasted), // mana left unused, turns 2–6
    cardsSeenByT6: mean(acc.seenT6),
    outOfGasT6Pct: p(acc.emptyHandT6), // no spell left in hand at the end of T6
  };
}

/** One number for "how smoothly the deck runs" from a goldfish report (0–100). */
export function goldfishScore(r) {
  const dead = r.deadTurnsT2toT5 ?? 0;
  const out = r.outOfGasT6Pct ?? 0;
  return Math.round(
    (0.12 * (100 - r.mulliganPct) +
      0.12 * r.landDropOnTimePct.T4 +
      0.1 * (r.commanderByNextTurnPct ?? 70) +
      0.12 * (100 - r.screwT4Pct) +
      0.1 * (100 - r.colorScrewT4Pct) +
      0.08 * (100 - r.floodT6Pct) +
      0.14 * Math.min(100, (r.manaSpentByT6 / 18) * 100) +
      0.11 * (100 - (dead / 4) * 100) +
      0.11 * (100 - out)) * 10,
  ) / 10;
}
