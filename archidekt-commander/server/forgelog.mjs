// Parser for Forge "sim" game logs (forge-gui-desktop ... sim -d a.dck b.dck ... -f commander).
// One log may hold several games; each ends with a "Game Result:" line. Pure functions, no I/O.
//
// Lines we read (Forge 2.0.x):
//   Mulligan: Ai(1)-x has kept a hand of 7 cards | has mulliganed down to 6 cards.
//   Turn: Turn 5 (Ai(1)-x)                       global turn counter, one per player turn
//   Land: Ai(1)-x played Forest (39)
//   Add To Stack: Ai(1)-x cast Sol Ring [targeting ...]
//   Combat: Ai(3)-y assigned A (296), B (204) and C (280) to attack Ai(1)-x.
//   Damage: Edgar Markov (302) deals 7 combat damage to Ai(1)-x.
//   Life: Life: Ai(1)-x 16 > 9
//   Game Outcome: Ai(1)-x has lost because life total reached 0 | has won because all opponents have lost
//   Game Result: Game 1 ended in 28325 ms. Ai(3)-y has won!

const PLAYER = /Ai\((\d+)\)-([^\s,.;:()]+)/;
const PLAYER_G = /Ai\((\d+)\)-([^\s,.;:()]+)/g;

const cardName = (s) => String(s || '').replace(/\s*\(\d+\)\s*$/, '').trim();
const cardId = (s) => {
  const m = /\((\d+)\)\s*$/.exec(String(s || ''));
  return m ? Number(m[1]) : null;
};

function newPlayer(label, seat) {
  return {
    label,
    seat, // 1-based position in Forge's order (Ai(n))
    mulligans: 0,
    turns: 0, // own turns started
    lands: [], // [{t: ownTurn, card}]
    casts: [], // [{t: ownTurn, card}]
    attacks: 0,
    damageTaken: {}, // source label | 'unknown' → amount
    damageTakenCards: {}, // source card name → amount
    damageDealt: 0, // to players
    commanderDamageTaken: 0,
    life: 40,
    minLife: 40,
    lost: null, // {g: globalTurn, t: ownTurn, reason, active}
  };
}

/** Splits raw log text into per-game chunks (each ends at a "Game Result:" line). */
export function splitGames(text) {
  const lines = String(text || '').split(/\r?\n/);
  const games = [];
  let cur = [];
  for (const line of lines) {
    cur.push(line);
    if (line.startsWith('Game Result:')) {
      games.push(cur);
      cur = [];
    }
  }
  return { games, rest: cur };
}

/**
 * Parses one game's lines. `owners` (optional) maps lower-case card name → player label, used when a damage
 * source's id was never seen on a land/attack line (names unique to one deck).
 */
export function parseGame(lines, { owners = null } = {}) {
  const players = new Map(); // label → state
  const idOwner = new Map(); // object id → label
  const bySeat = new Map();
  let active = null;
  let globalTurn = 0;
  let firstPlayer = null;
  const timeline = []; // compact events for replays/key games
  let winner = null;
  let resultLine = null;
  let durationMs = null;
  let outcomeTurn = null;

  const P = (seat, label) => {
    if (!players.has(label)) {
      const p = newPlayer(label, Number(seat));
      players.set(label, p);
      bySeat.set(Number(seat), p);
    }
    return players.get(label);
  };
  const ownerOf = (src) => {
    const id = cardId(src);
    if (id != null && idOwner.has(id)) return idOwner.get(id);
    const n = cardName(src).toLowerCase();
    if (owners && owners.has(n)) return owners.get(n);
    if (/\btoken$/i.test(cardName(src)) && active) return active; // tokens mostly hit on their controller's turn
    return 'unknown';
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    let m;
    if (line.startsWith('Mulligan:')) {
      if ((m = PLAYER.exec(line))) {
        const p = P(m[1], m[2]);
        if (/mulliganed down/.test(line)) p.mulligans++;
      }
    } else if (line.startsWith('Turn:')) {
      m = /Turn (\d+) \(Ai\((\d+)\)-([^\s,.;:()]+)\)/.exec(line);
      if (m) {
        globalTurn = Number(m[1]);
        const p = P(m[2], m[3]);
        active = p.label;
        p.turns++;
        timeline.push({ g: globalTurn, p: p.label, e: 'turn', t: p.turns });
        if (!firstPlayer) firstPlayer = p.label;
      }
    } else if (line.startsWith('Land:')) {
      m = /Ai\((\d+)\)-([^\s,.;:()]+) played (.+)$/.exec(line);
      if (m) {
        const p = P(m[1], m[2]);
        const id = cardId(m[3]);
        if (id != null) idOwner.set(id, p.label);
        p.lands.push({ t: p.turns, card: cardName(m[3]) });
        timeline.push({ g: globalTurn, p: p.label, e: 'land', c: cardName(m[3]) });
      }
    } else if (line.startsWith('Add To Stack:')) {
      m = /Ai\((\d+)\)-([^\s,.;:()]+) cast (.+?)(?: targeting .*)?$/.exec(line);
      if (m) {
        const p = P(m[1], m[2]);
        const c = cardName(m[3]);
        p.casts.push({ t: p.turns, card: c });
        timeline.push({ g: globalTurn, p: p.label, e: 'cast', c });
      }
    } else if (line.startsWith('Combat:')) {
      m = /^Combat: Ai\((\d+)\)-([^\s,.;:()]+) assigned (.+) to attack (.+?)\.?$/.exec(line);
      if (m) {
        const p = P(m[1], m[2]);
        p.attacks++;
        for (const part of m[3].split(/, | and /)) {
          const id = cardId(part);
          if (id != null) idOwner.set(id, p.label);
        }
        const target = PLAYER.exec(m[4]);
        timeline.push({ g: globalTurn, p: p.label, e: 'attack', n: m[3].split(/, | and /).length, to: target ? target[2] : cardName(m[4]) });
      }
    } else if (line.startsWith('Damage:')) {
      m = /^Damage: (.+?) deals (\d+) (combat )?damage to (.+?)\.?$/.exec(line);
      if (m) {
        const victim = PLAYER.exec(m[4]);
        if (victim && players.has(victim[2])) {
          const v = players.get(victim[2]);
          const src = ownerOf(m[1]);
          const n = Number(m[2]);
          v.damageTaken[src] = (v.damageTaken[src] || 0) + n;
          const cn = cardName(m[1]);
          v.damageTakenCards[cn] = (v.damageTakenCards[cn] || 0) + n;
          if (players.has(src)) players.get(src).damageDealt += n;
          v.lastHit = { src, card: cardName(m[1]), g: globalTurn };
        }
      }
    } else if (line.startsWith('Life:')) {
      m = /Ai\((\d+)\)-([^\s,.;:()]+) (-?\d+) > (-?\d+)/.exec(line);
      if (m) {
        const p = P(m[1], m[2]);
        p.life = Number(m[4]);
        p.minLife = Math.min(p.minLife, p.life);
        if (p.life <= 0 && !p.deadAt) p.deadAt = { g: globalTurn, t: p.turns, active, hit: p.lastHit ? { ...p.lastHit } : null };
      }
    } else if (line.startsWith('Game Outcome:')) {
      if ((m = /Ai\((\d+)\)-([^\s,.;:()]+) has (lost|won|conceded)(?: because)? ?(.*)$/.exec(line))) {
        const p = P(m[1], m[2]);
        if (m[3] === 'won') winner = p.label;
        else if (!p.lost) p.lost = { g: globalTurn, t: p.turns, reason: m[4] || m[3], active };
      } else if ((m = /^Game Outcome: Turn (\d+)/.exec(line))) {
        outcomeTurn = Number(m[1]);
      }
    } else if (line.startsWith('Game Result:')) {
      resultLine = line;
      m = /ended in (\d+) ms/.exec(line);
      if (m) durationMs = Number(m[1]);
      const w = /Ai\((\d+)\)-([^\s,.;:()]+) has won/.exec(line);
      if (w) winner = w[2];
    }
  }

  // Forge writes every outcome at the end of the game, so the elimination moment comes from the first life
  // line at or below 0 (deadAt). Other losses (poison, commander damage, empty library) fall back to the
  // player's last own turn.
  for (const p of players.values()) {
    if (p.lost) {
      const d = p.deadAt;
      if (d) Object.assign(p.lost, { g: d.g, t: d.t, active: d.active });
      else {
        const lastOwn = [...timeline].reverse().find((e) => e.p === p.label);
        if (lastOwn) p.lost.g = lastOwn.g;
      }
      const hit = d?.hit || p.lastHit;
      p.lost.killer = hit?.src && hit.src !== p.label && hit.src !== 'unknown' ? hit.src : p.lost.active !== p.label ? p.lost.active : null;
      p.lost.killerCard = hit?.card || null;
    }
    delete p.lastHit;
    delete p.deadAt;
  }

  const draw = !winner;
  return {
    players: [...players.values()].sort((a, b) => a.seat - b.seat),
    firstPlayer,
    winner,
    draw,
    globalTurns: globalTurn,
    outcomeTurn,
    durationMs,
    resultLine,
    timeline,
  };
}

/** Parses a whole sim log. Returns {games: [...], incompleteTail: boolean}. */
export function parseSimLog(text, opts = {}) {
  const { games, rest } = splitGames(text);
  return {
    games: games.map((g) => parseGame(g, opts)),
    incompleteTail: rest.some((l) => l.startsWith('Turn:')),
  };
}

/**
 * Elimination round of a player: the number of their own turns started before they lost
 * (a "round" = each player took one turn). Winners and survivors get null.
 */
export const lostRound = (p) => (p?.lost ? p.lost.t : null);

/**
 * Compact per-round story of a game from the point of view of `me` (one line per own turn):
 * "R3: Forest; Lotus Cobra, Farseek | vida 38 | Edgar atacou você (4)".
 */
export function storyLines(game, me, { maxLines = 16 } = {}) {
  const lines = [];
  const byRound = new Map();
  let round = 0;
  for (const ev of game.timeline) {
    if (ev.e === 'turn') {
      if (ev.p === me) round = ev.t;
      continue;
    }
    const r = Math.max(1, round);
    if (!byRound.has(r)) byRound.set(r, { mine: [], foes: [] });
    const slot = byRound.get(r);
    if (ev.p === me) {
      if (ev.e === 'land') slot.mine.push(`terreno ${ev.c}`);
      else if (ev.e === 'cast') slot.mine.push(ev.c);
      else if (ev.e === 'attack') slot.mine.push(`atacou ${ev.to} com ${ev.n}`);
    } else if (ev.e === 'attack' && ev.to === me) slot.foes.push(`${ev.p} atacou você com ${ev.n}`);
    else if (ev.e === 'cast') slot.foes.push(`${ev.p}: ${ev.c}`);
  }
  for (const [r, s] of [...byRound.entries()].sort((a, b) => a[0] - b[0])) {
    const foes = s.foes.length > 4 ? [...s.foes.slice(0, 4), `+${s.foes.length - 4}`] : s.foes;
    lines.push(`R${r}: ${s.mine.join('; ') || '—'}${foes.length ? ` | mesa: ${foes.join('; ')}` : ''}`);
  }
  if (lines.length > maxLines) return [...lines.slice(0, 3), `… (${lines.length - maxLines} rodadas)`, ...lines.slice(-(maxLines - 4))];
  return lines;
}

export { cardName as forgeCardName, PLAYER_G };
