// Matchup simulator: plays the analyzed deck against public Archidekt decks of the same bracket, in volume,
// with the Forge rules engine, and aggregates win rate, why it lost, MVP and dead cards.
//
// Job files live in data/matchups/<jobId>/: job.json (config, pool, pods, tasks), decks/*.dck, logs/*.log,
// games.jsonl (one compact record per finished game). The job runs inside the MCP server process; if the server
// restarts, the job can be resumed (pending tasks only).

import fs from 'node:fs';
import path from 'node:path';
import { findCard } from './cache.mjs';
import { log } from './client.mjs';
import { validateCommander } from './commander.mjs';
import { buildDck, defaultWorkers, forgeLabel, forgeNames, forgeStatus, runSim } from './forge.mjs';
import { parseSimLog, storyLines } from './forgelog.mjs';
import { rng } from './simulate.mjs';
import { dataDir, ensureDir, normName, readJson, ToolError, writeFileAtomic, writeJson } from './store.mjs';

export const MODES = {
  moderado: { poolSize: 12, pods: 4, games: 160, minutes: 30, chunk: 5 },
  sem_limite: { poolSize: 24, pods: 8, games: 2000, minutes: 8 * 60, chunk: 5 },
  rapido: { poolSize: 6, pods: 2, games: 40, minutes: 10, chunk: 4 },
};
const CLOCK_SEC = 300;
const jobDir = (id, ...p) => dataDir('matchups', id, ...p);
const running = new Map(); // jobId → {stop, procs:Set, promise}

// ---------------- helpers ----------------

function shuffle(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Wilson 95% interval for k successes in n trials, in percentage points. */
export function wilson(k, n) {
  if (!n) return { p: null, lo: null, hi: null };
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const r = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const f = (x) => Math.round(x * 1000) / 10;
  return { p: f(p), lo: f((c - r) / d), hi: f((c + r) / d) };
}

const median = (xs) => {
  const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/** Next local occurrence of "HH:MM" (today if still ahead, else tomorrow). */
export function untilTime(hhmm, now = new Date()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new ToolError('input', '"until" deve ser um horário HH:MM (ex.: "07:30").');
  const t = new Date(now);
  t.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t;
}

const gcAllowed = (bracket, n) => (bracket <= 2 ? n === 0 : bracket === 3 ? n <= 3 : true);

// ---------------- opponent pool ----------------

/**
 * Draws `size` valid public decks of the given bracket. `getDeck(id)` returns a parsed deck (commander.mjs).
 * Filters: declared bracket, 100 cards, valid Commander deck, Game Changers consistent with the bracket,
 * edited in the last 18 months, distinct commanders (and not ours), every card known to Forge.
 */
export async function drawPool({ client, getDeck, target, bracket, size, rand, names = forgeNames(), maxPages = 8, onProgress }) {
  const cutoff = Date.now() - 548 * 24 * 3600 * 1000;
  const seenCmd = new Set(target.commanders.map((c) => normName(c.name)));
  const rejected = { bracket: 0, size: 0, old: 0, invalid: 0, gameChangers: 0, forge: 0, duplicate: 0, error: 0 };
  const candidates = [];
  const pages = shuffle(Array.from({ length: 30 }, (_, i) => i + 1), rand).slice(0, maxPages);
  for (const page of pages) {
    if (candidates.length >= size * 3) break;
    let body;
    try {
      body = await client.request('GET', '/decks/v3/', { auth: 'none', params: { deckFormat: 3, edhBracket: bracket, orderBy: '-updatedAt', pageSize: 60, page } });
    } catch (e) {
      rejected.error++;
      log(`matchups: search page ${page} failed: ${e.message}`);
      continue;
    }
    for (const d of body?.results || []) {
      if (d.id === target.id || d.private) continue;
      if (Number(d.edhBracket) !== Number(bracket)) {
        rejected.bracket++;
        continue;
      }
      if (Number(d.size) !== 100) {
        rejected.size++;
        continue;
      }
      if (Date.parse(d.updatedAt || 0) < cutoff) {
        rejected.old++;
        continue;
      }
      candidates.push(d);
    }
    onProgress?.(`${candidates.length} candidatos`);
  }
  const pool = [];
  for (const c of shuffle(candidates, rand)) {
    if (pool.length >= size) break;
    let p;
    try {
      p = await getDeck(c.id);
    } catch {
      rejected.error++;
      continue;
    }
    const v = validateCommander(p);
    if (!v.valid) {
      rejected.invalid++;
      continue;
    }
    const cmdKey = p.commanders.map((x) => normName(x.name)).sort().join('+');
    if (p.commanders.some((x) => seenCmd.has(normName(x.name)))) {
      rejected.duplicate++;
      continue;
    }
    const gcs = p.rows.filter((r) => r.included && r.oracle?.gameChanger).length;
    if (!gcAllowed(bracket, gcs)) {
      rejected.gameChangers++;
      continue;
    }
    const label = `${forgeLabel(p.commanders[0].name)}-${p.id}`.slice(0, 32);
    const dck = buildDck(p, label, { names });
    if (dck.missing.length) {
      rejected.forge++;
      continue;
    }
    for (const x of p.commanders) seenCmd.add(normName(x.name));
    pool.push({
      id: p.id,
      name: p.name,
      label,
      commander: p.commanders.map((x) => x.name).join(' + '),
      commanderKey: cmdKey,
      identity: p.identity,
      owner: p.owner,
      url: `https://archidekt.com/decks/${p.id}`,
      gameChangers: gcs,
      dck: dck.text,
      cards: p.rows.filter((r) => r.included).map((r) => r.name),
    });
    onProgress?.(`${pool.length}/${size} oponentes válidos`);
  }
  return { pool, rejected, candidates: candidates.length };
}

/** Groups the pool into pods of 3, each deck used about equally, preferring ≥3 different color identities. */
export function makePods(pool, podCount, rand, targetIdentity) {
  if (pool.length < 3) throw new ToolError('pool', `Só ${pool.length} oponente(s) válido(s) — preciso de pelo menos 3.`);
  let best = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    const order = [];
    while (order.length < podCount * 3) order.push(...shuffle(pool.map((_, i) => i), rand));
    const pods = [];
    let score = 0;
    for (let k = 0; k < podCount; k++) {
      let ids = order.slice(k * 3, k * 3 + 3);
      if (new Set(ids).size < 3) ids = shuffle(pool.map((_, i) => i), rand).slice(0, 3);
      const ident = new Set([targetIdentity, ...ids.map((i) => pool[i].identity)]);
      score += Math.min(ident.size, 3);
      pods.push(ids);
    }
    if (!best || score > best.score) best = { pods, score };
    if (score >= podCount * 3) break;
  }
  return best.pods;
}

// ---------------- game records ----------------

function wipeCards(game) {
  const out = [];
  for (const ev of game.timeline) {
    if (ev.e !== 'cast') continue;
    const c = findCard(ev.c);
    if (c?.roles?.includes('wipe')) out.push({ g: ev.g, p: ev.p, c: ev.c });
  }
  return out;
}

const shorten = (line, short) => {
  if (!short) return line;
  let out = line;
  for (const [label, name] of Object.entries(short)) out = out.split(label).join(name);
  return out;
};

/** Turns my parsed game into a compact record (all the aggregation needs). */
export function gameRecord(game, me, meta) {
  const p = game.players.find((x) => x.label === me);
  if (!p) return null;
  const won = game.winner === me;
  const lostAt = p.lost?.t ?? null;
  const myTurnsAtG = new Map();
  for (const ev of game.timeline) if (ev.e === 'turn' && ev.p === me) myTurnsAtG.set(ev.g, ev.t);
  const roundOfG = (g) => {
    let r = 0;
    for (const [gg, t] of myTurnsAtG) if (gg <= g) r = t;
    return r;
  };
  const castsByTurn = {};
  for (const c of p.casts) castsByTurn[c.t] = (castsByTurn[c.t] || 0) + 1;
  const firstCast = {};
  for (const c of p.casts) if (!(c.card in firstCast)) firstCast[c.card] = c.t;
  const landsBy4 = p.lands.filter((l) => l.t <= 4).length;
  const wipes = wipeCards(game).map((w) => ({ r: roundOfG(w.g), p: w.p, c: w.c }));
  const castsAfter = (r) => p.casts.filter((c) => c.t > r).length;
  const lastTurns = lostAt ? [lostAt - 2, lostAt - 1, lostAt].filter((t) => t >= 1) : [];
  const idleLate = lastTurns.filter((t) => !castsByTurn[t]).length;
  const topHurt = Object.entries(p.damageTakenCards || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  return {
    ...meta,
    won,
    draw: game.draw,
    winner: game.winner,
    rounds: p.turns,
    lostRound: lostAt,
    reason: p.lost?.reason || null,
    killer: p.lost?.killer || null,
    killerCard: p.lost?.killerCard || null,
    mull: p.mulligans,
    landsBy4,
    lands: p.lands.length,
    casts: p.casts.length,
    castsBy4: p.casts.filter((c) => c.t <= 4).length,
    firstCast,
    idleLate,
    wipes,
    castsAfterLastWipe: wipes.length ? castsAfter(wipes[wipes.length - 1].r) : null,
    dealt: p.damageDealt,
    taken: p.damageTaken,
    topHurt,
    lastAlive: !won && game.players.filter((x) => x.label !== game.winner && x.lost).every((x) => (x.lost?.g ?? 0) <= (p.lost?.g ?? 0)),
    ms: game.durationMs,
    story: storyLines(game, me, { maxLines: 14 }).map((l) => shorten(l, meta.short)),
  };
}

/** Why did this game end in a loss? One label per loss. */
export function lossCause(r) {
  if (r.won) return null;
  if (r.draw) return 'empate (tempo esgotado)';
  const reason = String(r.reason || '');
  if (/commander/i.test(reason)) return 'dano de comandante';
  if (/poison/i.test(reason)) return 'veneno';
  if (/library|draw/i.test(reason)) return 'grimório vazio';
  if (/conced/i.test(reason)) return 'concedeu';
  if (r.landsBy4 < 3 || r.mull >= 2) return 'travou de mana';
  if (r.lostRound != null && r.lostRound <= 5) return 'morreu cedo';
  const recentWipe = r.wipes.some((w) => r.lostRound != null && w.r >= r.lostRound - 3 && w.r < r.lostRound);
  if (recentWipe && (r.castsAfterLastWipe ?? 0) <= 1) return 'wipe sem recuperação';
  if (r.idleLate >= 2 && r.lands >= 5) return 'ficou sem gás';
  return 'perdeu a corrida';
}

// ---------------- aggregation ----------------

export function aggregate(records, { deckCards = [], pool = [], meLabel } = {}) {
  const n = records.length;
  const wins = records.filter((r) => r.won).length;
  const draws = records.filter((r) => r.draw).length;
  const wr = wilson(wins, n);
  const byPod = {};
  const bySeat = {};
  for (const r of records) {
    (byPod[r.pod] ??= { games: 0, wins: 0 }).games++;
    if (r.won) byPod[r.pod].wins++;
    (bySeat[r.seat] ??= { games: 0, wins: 0 }).games++;
    if (r.won) bySeat[r.seat].wins++;
  }
  const causes = {};
  for (const r of records) {
    const c = lossCause(r);
    if (c) causes[c] = (causes[c] || 0) + 1;
  }
  const losses = n - wins;
  const causeList = Object.entries(causes)
    .sort((a, b) => b[1] - a[1])
    .map(([cause, k]) => ({ cause, games: k, pctOfLosses: losses ? Math.round((k / losses) * 1000) / 10 : 0 }));

  // who / what kills us
  const labelToDeck = new Map(pool.map((d) => [d.label, d]));
  const killers = {};
  const hurtCards = {};
  for (const r of records) {
    if (!r.won && r.killer) killers[r.killer] = (killers[r.killer] || 0) + 1;
    for (const [c, v] of r.topHurt || []) hurtCards[c] = (hurtCards[c] || 0) + v;
  }
  const killerList = Object.entries(killers)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([label, k]) => ({ commander: labelToDeck.get(label)?.commander || label, deckId: labelToDeck.get(label)?.id ?? null, kills: k }));
  const hurtList = Object.entries(hurtCards)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([card, dmg]) => ({ card, damage: dmg }));

  // per-card stats (skip basic lands)
  const basics = /^(snow-covered )?(plains|island|swamp|mountain|forest|wastes)$/i;
  const cards = [];
  for (const name of new Set(deckCards)) {
    if (basics.test(name)) continue;
    const key = name.split(' // ')[0];
    let castG = 0;
    let castW = 0;
    let expected = 0;
    let firstTurns = [];
    for (const r of records) {
      const t = r.firstCast[name] ?? r.firstCast[key];
      expected += Math.min(1, (7 + (r.rounds || 0)) / 99);
      if (t != null) {
        castG++;
        if (r.won) castW++;
        firstTurns.push(t);
      }
    }
    const notG = n - castG;
    const notW = wins - castW;
    const wrCast = castG ? (castW / castG) * 100 : null;
    const wrNot = notG ? (notW / notG) * 100 : null;
    cards.push({
      card: name,
      castGames: castG,
      castRate: n ? Math.round((castG / n) * 1000) / 10 : 0,
      useVsDraw: expected ? Math.round((castG / expected) * 100) / 100 : null,
      wrWhenCast: wrCast == null ? null : Math.round(wrCast * 10) / 10,
      wrWhenNot: wrNot == null ? null : Math.round(wrNot * 10) / 10,
      delta: wrCast != null && wrNot != null ? Math.round((wrCast - wrNot) * 10) / 10 : null,
      medianTurn: median(firstTurns),
    });
  }
  const minN = Math.max(15, Math.round(n * 0.1));
  const mvp = cards
    .filter((c) => c.castGames >= minN && c.delta != null)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 8);
  const dead = cards
    .filter((c) => c.useVsDraw != null && n >= 12)
    .sort((a, b) => a.useVsDraw - b.useVsDraw)
    .slice(0, 8)
    .map((c) => ({ ...c, smallSample: c.castGames < minN }));

  const winRounds = records.filter((r) => r.won).map((r) => r.rounds);
  const lossRounds = records.filter((r) => !r.won && r.lostRound).map((r) => r.lostRound);
  return {
    games: n,
    wins,
    draws,
    winRate: wr,
    baselinePct: 25,
    medianWinRound: median(winRounds),
    medianLossRound: median(lossRounds),
    tempo: {
      medianLandsBy4: median(records.map((r) => r.landsBy4)),
      medianCastsBy4: median(records.map((r) => r.castsBy4)),
      mulliganRate: n ? Math.round((records.filter((r) => r.mull > 0).length / n) * 1000) / 10 : null,
    },
    bySeat: Object.fromEntries(Object.entries(bySeat).map(([k, v]) => [`assento ${Number(k) + 1}`, { ...v, winRate: wilson(v.wins, v.games).p }])),
    byPod: Object.entries(byPod).map(([pod, v]) => ({ pod: Number(pod), ...v, winRate: wilson(v.wins, v.games).p })),
    lossCauses: causeList,
    killers: killerList,
    hurtBy: hurtList,
    mvp,
    dead,
    minSampleForCards: minN,
    meLabel,
  };
}

/** Picks key games for a closer look: typical loss, worst loss, closest loss, typical win. */
export function keyGames(records, max = 4) {
  const out = [];
  const losses = records.filter((r) => !r.won && !r.draw);
  const wins = records.filter((r) => r.won);
  const pick = (label, r) => r && !out.some((o) => o.ref === r.ref) && out.push({ label, ref: r.ref, ...r });
  if (losses.length) {
    const counts = {};
    for (const r of losses) counts[lossCause(r)] = (counts[lossCause(r)] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    const typical = losses.filter((r) => lossCause(r) === top);
    const mr = median(typical.map((r) => r.lostRound));
    pick(`derrota típica (${top})`, typical.sort((a, b) => Math.abs(a.lostRound - mr) - Math.abs(b.lostRound - mr))[0]);
    pick('pior derrota', [...losses].sort((a, b) => (a.lostRound ?? 99) - (b.lostRound ?? 99))[0]);
    pick('derrota apertada', losses.filter((r) => r.lastAlive).sort((a, b) => (b.lostRound ?? 0) - (a.lostRound ?? 0))[0]);
  }
  if (wins.length) {
    const mr = median(wins.map((r) => r.rounds));
    pick('vitória típica', [...wins].sort((a, b) => Math.abs(a.rounds - mr) - Math.abs(b.rounds - mr))[0]);
  }
  return out.slice(0, max).map((r) => ({
    label: r.label,
    ref: r.ref,
    pod: r.pod,
    seat: r.seat + 1,
    seed: r.seed,
    result: r.won ? `venceu na rodada ${r.rounds}` : r.draw ? 'empate' : `perdeu na rodada ${r.lostRound} (${lossCause(r)})${r.killerCard ? `, último golpe: ${r.killerCard}` : ''}`,
    story: r.story,
  }));
}

// ---------------- job lifecycle ----------------

export function readJob(id) {
  const j = readJson(jobDir(id, 'job.json'), null);
  if (!j) throw new ToolError('not_found', `Simulação ${id} não encontrada.`);
  return j;
}
const saveJob = (j) => writeJson(jobDir(j.id, 'job.json'), j, { pretty: true });

export function readRecords(id) {
  const f = jobDir(id, 'games.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function listJobs() {
  const root = dataDir('matchups');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((id) => readJson(path.join(root, id, 'job.json'), null))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((j) => ({ id: j.id, deck: j.target.name, mode: j.mode, state: running.has(j.id) ? 'rodando' : j.state, games: j.done?.games ?? 0, createdAt: j.createdAt }));
}

/** Creates the job: draws the pool, writes .dck files and the task list. Does not start running. */
export const newJobId = (target, swaps = []) => `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${target.id}${swaps.length ? '-ab' : ''}`;

export async function createJob({ id, client, getDeck, target, bracket, mode = 'moderado', games, minutes, until, seed, swaps = [], compareTo = null, onProgress }) {
  const st = forgeStatus();
  if (!st.ready) throw new ToolError('setup', 'O Forge ainda não está instalado. Rode forge_setup e espere terminar.');
  const m = MODES[mode];
  if (!m) throw new ToolError('input', `Modo inválido: ${mode} (use ${Object.keys(MODES).join(', ')}).`);
  id ??= newJobId(target, swaps);
  const baseSeed = Number.isInteger(seed) ? seed : Math.floor(Math.random() * 1e6);
  const rand = rng(baseSeed);
  ensureDir(jobDir(id, 'decks'));
  ensureDir(jobDir(id, 'logs'));

  const meLabel = `alvo-${target.id}`;
  const meDck = buildDck(target, meLabel, { swaps });
  if (meDck.count !== 100) throw new ToolError('input', `O deck alvo tem ${meDck.count} cartas (precisa de 100).`);

  let pool;
  let pods;
  let tasks;
  let rejected = null;
  let base = null;
  if (compareTo) {
    base = readJob(compareTo);
    if (base.target.id !== target.id) throw new ToolError('input', 'O teste A/B precisa usar o mesmo deck da simulação base.');
    pool = base.pool;
    pods = base.pods;
    const doneRefs = new Set(readRecords(compareTo).map((r) => r.task));
    tasks = base.tasks.filter((t) => doneRefs.has(t.i)).map((t) => ({ ...t, state: 'pendente' }));
  } else {
    const drawn = await drawPool({ client, getDeck, target, bracket, size: m.poolSize, rand, onProgress });
    pool = drawn.pool;
    rejected = { ...drawn.rejected, candidates: drawn.candidates };
    pods = makePods(pool, Math.min(m.pods, Math.max(1, Math.floor(pool.length / 3) + 1)), rand, target.identity);
    const totalGames = Math.max(4, games ?? m.games);
    // Small enough chunks that every pod and seat gets games even in short runs.
    const perTask = Math.max(1, Math.min(m.chunk, Math.floor(totalGames / (pods.length * 4)) || 1));
    tasks = [];
    let i = 0;
    for (let made = 0; made < totalGames; ) {
      for (let p = 0; p < pods.length && made < totalGames; p++) {
        for (let seat = 0; seat < 4 && made < totalGames; seat++) {
          const n = Math.min(perTask, totalGames - made);
          tasks.push({ i, pod: p, seat, games: n, seed: baseSeed + i * 7919, state: 'pendente' });
          made += n;
          i++;
        }
      }
    }
  }
  for (const d of pool) {
    const text = d.dck ?? fs.readFileSync(jobDir(compareTo, 'decks', `${d.label}.dck`), 'utf8');
    writeFileAtomic(jobDir(id, 'decks', `${d.label}.dck`), text);
  }
  writeFileAtomic(jobDir(id, 'decks', `${meLabel}.dck`), meDck.text);

  const deadline = until ? untilTime(until) : new Date(Date.now() + (minutes ?? m.minutes) * 60_000);
  const job = {
    id,
    createdAt: new Date().toISOString(),
    mode,
    bracket,
    seed: baseSeed,
    deadline: deadline.toISOString(),
    workers: defaultWorkers(),
    state: 'pronto',
    target: { id: target.id, name: target.name, commander: target.commanders.map((c) => c.name).join(' + '), identity: target.identity, label: meLabel, missingInForge: meDck.missing, cards: target.rows.filter((r) => r.included).map((r) => r.name) },
    swaps,
    compareTo,
    pool: pool.map(({ dck, ...rest }) => rest),
    poolRejected: rejected,
    pods,
    tasks,
    done: { games: 0, tasks: 0, failedTasks: 0 },
  };
  if (meDck.missing.length) job.warning = `Cartas do seu deck que o Forge não conhece (jogará sem elas): ${meDck.missing.join(', ')}`;
  saveJob(job);
  return job;
}

const preparing = new Map(); // jobId → {step, promise}

/**
 * Validates inputs synchronously, then draws the pool and starts the games in the background.
 * Returns the job id right away (the opponent draw takes ~1 min because of Archidekt's rate limit).
 */
export function launchJob(opts) {
  const st = forgeStatus();
  if (!st.ready) throw new ToolError('setup', 'O Forge ainda não está instalado. Rode forge_setup e espere terminar.');
  if (!MODES[opts.mode]) throw new ToolError('input', `Modo inválido: ${opts.mode} (use ${Object.keys(MODES).join(', ')}).`);
  if (opts.until) untilTime(opts.until);
  const id = newJobId(opts.target, opts.swaps);
  ensureDir(jobDir(id));
  writeJson(jobDir(id, 'job.json'), { id, createdAt: new Date().toISOString(), state: 'sorteando oponentes', mode: opts.mode, target: { id: opts.target.id, name: opts.target.name }, tasks: [], done: { games: 0, tasks: 0, failedTasks: 0 }, deadline: new Date().toISOString(), pool: [], pods: [] }, { pretty: true });
  const prep = { step: 'sorteando oponentes', error: null };
  prep.promise = createJob({ ...opts, id, onProgress: (s) => (prep.step = s) })
    .then(() => {
      preparing.delete(id);
      startJob(id);
    })
    .catch((e) => {
      prep.error = String(e?.message || e);
      const j = readJson(jobDir(id, 'job.json'), {});
      j.state = `falhou: ${prep.error}`;
      saveJob({ ...j, id });
      log(`matchups: create ${id} failed: ${prep.error}`);
      setTimeout(() => preparing.delete(id), 60_000).unref?.();
    });
  preparing.set(id, prep);
  return { id, status: 'sorteando oponentes e preparando os decks (≈1–2 min); depois as partidas começam sozinhas' };
}

export const waitPrepared = (id) => preparing.get(id)?.promise ?? Promise.resolve();

/** Runs pending tasks with a worker pool until done, deadline or stop. */
export function startJob(id) {
  if (running.has(id)) return { started: false, status: 'já está rodando' };
  const job = readJob(id);
  const control = { stopped: false, procs: new Set() };
  const deadline = Date.parse(job.deadline);
  job.state = 'rodando';
  job.startedAt ??= new Date().toISOString();
  saveJob(job);
  const pool = new Map(job.pool.map((d) => [d.label, d]));
  const owners = new Map();
  const addOwner = (cards, label) => {
    for (const c of cards || []) {
      const k = c.toLowerCase();
      owners.set(k, owners.has(k) && owners.get(k) !== label ? 'unknown' : label);
    }
  };
  addOwner(job.target.cards, job.target.label);
  for (const d of job.pool) addOwner(d.cards, d.label);
  for (const [k, v] of owners) if (v === 'unknown') owners.delete(k);
  // Readable names in the key-game stories: "edgar-markov-27267770" → "Edgar Markov".
  const short = { [job.target.label]: 'você' };
  for (const d of job.pool) short[d.label] = d.commander.split(',')[0].split(' + ')[0];

  const runTask = async (t) => {
    const opp = job.pods[t.pod].map((i) => job.pool[i].label);
    const order = [...opp];
    order.splice(t.seat, 0, job.target.label);
    const logFile = jobDir(id, 'logs', `task-${t.i}.log`);
    const proc = runSim({
      deckDir: jobDir(id, 'decks'),
      deckFiles: order.map((l) => `${l}.dck`),
      games: t.games,
      seed: t.seed,
      clockSec: CLOCK_SEC,
      logFile,
      timeoutMs: (t.games * CLOCK_SEC + 180) * 1000,
    });
    control.procs.add(proc);
    const res = await proc.promise;
    control.procs.delete(proc);
    const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const parsed = parseSimLog(text, { owners });
    const lines = [];
    parsed.games.forEach((g, gi) => {
      const rec = gameRecord(g, job.target.label, { task: t.i, ref: `${t.i}.${gi + 1}`, pod: t.pod, seat: t.seat, seed: t.seed, game: gi + 1, short });
      if (rec) {
        delete rec.short;
        lines.push(JSON.stringify(rec));
      }
    });
    if (lines.length) fs.appendFileSync(jobDir(id, 'games.jsonl'), `${lines.join('\n')}\n`);
    const fresh = readJob(id);
    const ft = fresh.tasks.find((x) => x.i === t.i);
    if (!parsed.games.length && control.stopped) {
      saveJob(fresh); // interrupted by stop: stays pending, a resume runs it again
      return;
    }
    ft.state = parsed.games.length ? 'ok' : 'falhou';
    ft.games_done = parsed.games.length;
    ft.ms = res.ms;
    if (!parsed.games.length) {
      ft.error = res.error || `Forge saiu com código ${res.code}${res.killed ? ' (interrompido)' : ''}`;
      fresh.done.failedTasks++;
    }
    fresh.done.games += parsed.games.length;
    fresh.done.tasks++;
    saveJob(fresh);
    // Keep disk use small: logs of finished tasks are compressed into the record; keep only the last 40.
    try {
      const logs = fs.readdirSync(jobDir(id, 'logs')).sort((a, b) => Number(a.match(/\d+/)) - Number(b.match(/\d+/)));
      for (const f of logs.slice(0, Math.max(0, logs.length - 40))) fs.unlinkSync(jobDir(id, 'logs', f));
    } catch {
      /* best effort */
    }
  };

  const promise = (async () => {
    const queue = job.tasks.filter((t) => t.state === 'pendente');
    const workers = Array.from({ length: Math.max(1, job.workers) }, async () => {
      while (queue.length && !control.stopped && Date.now() < deadline) {
        const t = queue.shift();
        try {
          await runTask(t);
        } catch (e) {
          log(`matchups task ${t.i} failed: ${e.message}`);
          const fresh = readJob(id);
          const ft = fresh.tasks.find((x) => x.i === t.i);
          ft.state = 'falhou';
          ft.error = e.message;
          fresh.done.failedTasks++;
          saveJob(fresh);
        }
      }
    });
    await Promise.all(workers);
    const fresh = readJob(id);
    const pending = fresh.tasks.filter((t) => t.state === 'pendente').length;
    fresh.state = control.stopped ? 'parado' : pending ? 'prazo atingido' : 'concluído';
    fresh.finishedAt = new Date().toISOString();
    saveJob(fresh);
    running.delete(id);
  })();
  running.set(id, { control, promise });
  return { started: true, status: 'rodando em segundo plano', workers: job.workers, deadline: job.deadline };
}

export function stopJob(id) {
  const r = running.get(id);
  if (!r) return { stopped: false, status: 'não está rodando' };
  r.control.stopped = true;
  for (const p of r.control.procs) p.stop();
  return { stopped: true, status: 'parando (partidas em andamento são descartadas)' };
}

export const waitJob = (id) => running.get(id)?.promise ?? Promise.resolve();

export function jobStatus(id) {
  const j = readJob(id);
  const prep = preparing.get(id);
  if (prep) return { id, state: prep.error ? `falhou: ${prep.error}` : 'preparando', step: prep.step, deck: j.target?.name };
  const total = j.tasks.reduce((s, t) => s + t.games, 0);
  const doneTasks = j.tasks.filter((t) => t.state !== 'pendente');
  const msPerGame = doneTasks.length ? doneTasks.reduce((s, t) => s + (t.ms || 0), 0) / Math.max(1, j.done.games) : null;
  const left = total - j.done.games;
  const etaMin = msPerGame ? Math.round((left * msPerGame) / Math.max(1, j.workers) / 60000) : null;
  const deadlineMin = Math.max(0, Math.round((Date.parse(j.deadline) - Date.now()) / 60000));
  return {
    id: j.id,
    state: running.has(id) ? 'rodando' : j.state === 'rodando' ? 'interrompido (servidor reiniciou — use resumeJobId para continuar)' : j.state,
    deck: j.target.name,
    mode: j.mode,
    gamesDone: j.done.games,
    gamesPlanned: total,
    failedTasks: j.done.failedTasks,
    workers: j.workers,
    secondsPerGame: msPerGame ? Math.round(msPerGame / 100) / 10 : null,
    etaMinutes: etaMin == null ? null : Math.min(etaMin, deadlineMin),
    deadline: j.deadline,
    warning: j.warning || null,
  };
}

/** Full report (aggregates + key games + opponents), sized for the main Claude context. */
export function jobReport(id, { keyGameCount = 4 } = {}) {
  const j = readJob(id);
  const recs = readRecords(id);
  if (!recs.length) throw new ToolError('empty', 'Ainda não há partidas terminadas nesta simulação.');
  const agg = aggregate(recs, { deckCards: j.target.cards, pool: j.pool, meLabel: j.target.label });
  const oppStats = j.pool.map((d, i) => {
    const inPods = j.pods.map((p, k) => (p.includes(i) ? k : -1)).filter((k) => k >= 0);
    const games = recs.filter((r) => inPods.includes(r.pod));
    const theyWon = games.filter((r) => r.winner === d.label).length;
    return { deckId: d.id, commander: d.commander, identity: d.identity, url: d.url, games: games.length, theirWins: theyWon };
  });
  const out = {
    id: j.id,
    deck: { id: j.target.id, name: j.target.name, commander: j.target.commander },
    mode: j.mode,
    bracket: j.bracket,
    state: jobStatus(id).state,
    engine: 'Forge (IA contra IA, regras completas)',
    summary: agg,
    keyGames: keyGames(recs, keyGameCount),
    opponents: oppStats.filter((o) => o.games),
    swaps: j.swaps,
    notes: [
      'A IA do Forge pilota todos os decks: decks reativos (counters, remoção instantânea) tendem a render menos que nas mãos de um jogador.',
      '"Carta morta" usa uso ÷ chance de ter comprado; o log do Forge não mostra a mão, então carta não comprada e carta presa na mão se confundem.',
      `Cartas com menos de ${agg.minSampleForCards} partidas lançadas não viram recomendação sozinhas.`,
    ],
  };
  if (j.compareTo) {
    const baseRecs = readRecords(j.compareTo);
    const refs = new Set(recs.map((r) => r.ref));
    const paired = baseRecs.filter((r) => refs.has(r.ref));
    const bw = paired.filter((r) => r.won).length;
    const aw = recs.filter((r) => r.won).length;
    const n1 = paired.length;
    const n2 = recs.length;
    const p1 = n1 ? bw / n1 : 0;
    const p2 = n2 ? aw / n2 : 0;
    const se = Math.sqrt((p1 * (1 - p1)) / Math.max(1, n1) + (p2 * (1 - p2)) / Math.max(1, n2));
    const diff = (p2 - p1) * 100;
    const lo = diff - 196 * se;
    const hi = diff + 196 * se;
    out.comparison = {
      baseJob: j.compareTo,
      baseWinRate: n1 ? Math.round(p1 * 1000) / 10 : null,
      newWinRate: n2 ? Math.round(p2 * 1000) / 10 : null,
      diffPp: Math.round(diff * 10) / 10,
      ci95: [Math.round(lo * 10) / 10, Math.round(hi * 10) / 10],
      verdict: lo > 0 ? 'melhorou' : hi < 0 ? 'piorou' : 'sem diferença detectável',
      pairedGames: n1,
    };
  }
  return out;
}
