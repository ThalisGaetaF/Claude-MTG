// Phase 4: matchup simulator (Forge). Units for the log parser, zip reader, trigger scan and aggregation, plus an
// end-to-end job (pool draw → pods → games → report → A/B) with tests/fake-forge.mjs standing in for Java+Forge.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// A real Forge 2.0.15 log excerpt (4-player Commander, trimmed).
const REAL_LOG = `Simulation mode
Ai(1)-toph vs Ai(2)-atraxa vs Ai(3)-edgar vs Ai(4)-talrand - one game of Commander
Mulligan: Ai(1)-toph has mulliganed down to 7 cards.
Mulligan: Ai(1)-toph has kept a hand of 7 cards
Mulligan: Ai(2)-atraxa has kept a hand of 7 cards
Mulligan: Ai(3)-edgar has kept a hand of 7 cards
Mulligan: Ai(4)-talrand has kept a hand of 7 cards
Turn: Turn 1 (Ai(1)-toph)
Phase: Ai(1)-toph's Main phase, precombat
Land: Ai(1)-toph played Rootbound Crag (96)
Turn: Turn 2 (Ai(2)-atraxa)
Land: Ai(2)-atraxa played Undergrowth Stadium (187)
Add To Stack: Ai(2)-atraxa cast The Ozolith
Resolve Stack: The Ozolith
Turn: Turn 3 (Ai(3)-edgar)
Land: Ai(3)-edgar played Path of Ancestry (212)
Turn: Turn 4 (Ai(4)-talrand)
Land: Ai(4)-talrand played Island (345)
Turn: Turn 5 (Ai(1)-toph)
Land: Ai(1)-toph played Forest (39)
Add To Stack: Ai(1)-toph cast Krosan Grip targeting [The Ozolith (149)]
Turn: Turn 6 (Ai(2)-atraxa)
Turn: Turn 7 (Ai(3)-edgar)
Add To Stack: Ai(3)-edgar cast Olivia Voldaren
Combat: Ai(3)-edgar assigned Cordial Vampire (296), Sanctum Seeker (204) and Edgar Markov (302) to attack Ai(1)-toph.
Combat: Ai(1)-toph assigned Toph, Hardheaded Teacher (100) to block Cordial Vampire (296).
Damage: Edgar Markov (302) deals 37 combat damage to Ai(1)-toph.
Life: Life: Ai(1)-toph 40 > 3
Damage: Sanctum Seeker (204) deals 9 combat damage to Ai(1)-toph.
Life: Life: Ai(1)-toph 3 > -6
Turn: Turn 8 (Ai(4)-talrand)
Damage: Vampire Token (427) deals 50 combat damage to Ai(4)-talrand.
Life: Life: Ai(4)-talrand 40 > -10
Turn: Turn 9 (Ai(2)-atraxa)
Damage: Welcoming Vampire (237) deals 45 damage to Ai(2)-atraxa.
Life: Life: Ai(2)-atraxa 40 > -5
Game Outcome: Match Duration 0m : 25s
Game Outcome: Turn 14
Game Outcome: Ai(1)-toph has lost because life total reached 0
Game Outcome: Ai(2)-atraxa has lost because life total reached 0
Game Outcome: Ai(3)-edgar has won because all opponents have lost
Game Outcome: Ai(4)-talrand has lost because life total reached 0
Match Result: Ai(1)-toph: 0 Ai(2)-atraxa: 0 Ai(3)-edgar: 1 Ai(4)-talrand: 0
Game Result: Game 1 ended in 28325 ms. Ai(3)-edgar has won!
`;

/** Tiny zip writer (deflate) for the reader test. */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** Synthetic Archidekt deck (raw API shape) with 1 commander + 99 basics/cards. */
function rawDeck(id, commander, ci, extra = [], { bracket = 3, gc = 0 } = {}) {
  const cards = [];
  let rid = id * 1000;
  const card = (name, q, cat, o = {}) =>
    cards.push({ id: rid++, quantity: q, categories: [cat], card: { id: rid, oracleCard: { name, cmc: 2, colorIdentity: o.ci || [], types: o.types || ['Creature'], superTypes: o.supers || [], subTypes: [], text: o.text || '', legalities: { commander: 'legal' }, gameChanger: !!o.gc } } });
  card(commander, 1, 'Commander', { ci: ci.split(''), supers: ['Legendary'] });
  let used = 1;
  for (const [i, n] of extra.entries()) {
    card(n, 1, 'Main', { ci: [], gc: i < gc });
    used++;
  }
  card('Forest', 100 - used, 'Main', { types: ['Land'], supers: ['Basic'] });
  return { id, name: `${commander} deck`, deckFormat: 3, edhBracket: bracket, owner: { username: 'u' }, categories: [{ name: 'Commander', isPremier: true, includedInDeck: true }, { name: 'Main', isPremier: false, includedInDeck: true }], cards };
}

export async function runPhase4({ check }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'archidekt-p4-'));
  const prevHome = process.env.ARCHIDEKT_HOME;
  const prevEnv = { FORGE_JAVA: process.env.FORGE_JAVA, FORGE_JAR: process.env.FORGE_JAR, FORGE_WORKERS: process.env.FORGE_WORKERS };
  process.env.ARCHIDEKT_HOME = home;
  try {
    const { parseSimLog, storyLines } = await import('../server/forgelog.mjs');
    const { zipEntries, zipRead } = await import('../server/zip.mjs');
    const { cardTriggers, scanDeck, renderScan } = await import('../server/triggers.mjs');
    const forge = await import('../server/forge.mjs');
    const M = await import('../server/matchups.mjs');
    const { parseDeck } = await import('../server/commander.mjs');

    console.log('\n# Phase 4 units (matchups / Forge)');
    // ---- parser ----
    const owners = new Map([['welcoming vampire', 'edgar']]);
    const r = parseSimLog(REAL_LOG, { owners });
    check('forge log: one game parsed', r.games.length === 1, r.games.length);
    const g = r.games[0];
    check('forge log: winner and first player', g.winner === 'edgar' && g.firstPlayer === 'toph', [g.winner, g.firstPlayer]);
    const toph = g.players.find((p) => p.label === 'toph');
    check('forge log: mulligan counted', toph.mulligans === 1, toph.mulligans);
    check('forge log: lands/casts per own turn', toph.lands.length === 2 && toph.casts[0].card === 'Krosan Grip' && toph.casts[0].t === 2, toph);
    check('forge log: death taken from first life ≤ 0 (own turn 2)', toph.lost?.t === 2 && toph.lost.g === 7, toph.lost);
    check('forge log: killer from damage source id (attack line)', toph.lost.killer === 'edgar' && toph.lost.killerCard === 'Sanctum Seeker', toph.lost);
    check('forge log: damage taken per owner', toph.damageTaken.edgar === 46, toph.damageTaken);
    const talrand = g.players.find((p) => p.label === 'talrand');
    check('forge log: token damage on its controller\'s turn → active player', talrand.damageTaken.talrand === 50 || talrand.damageTaken.unknown === undefined, talrand.damageTaken);
    const atraxa = g.players.find((p) => p.label === 'atraxa');
    check('forge log: name→owner fallback for unseen ids', atraxa.damageTaken.edgar === 45, atraxa.damageTaken);
    const story = storyLines(g, 'toph');
    check('forge log: story has one line per own round', story.length === 2 && /Krosan Grip/.test(story[1]) && /edgar atacou você com 3/.test(story[1]), story);
    const draw = parseSimLog('Turn: Turn 1 (Ai(1)-a)\nTurn: Turn 2 (Ai(2)-b)\nGame Result: Game 1 ended in 5 ms. Game is a draw.\n');
    check('forge log: draw when nobody won', draw.games[0].draw === true && draw.games[0].winner === null, draw.games[0]);
    check('forge log: incomplete tail flagged', parseSimLog(REAL_LOG + 'Turn: Turn 1 (Ai(1)-toph)\n').incompleteTail === true);

    // ---- zip ----
    const zip = makeZip({ 'a/x.txt': 'Name:Sol Ring\nManaCost:1', 'b/y.txt': 'Name:Toph, Hardheaded Teacher\n' });
    const ents = zipEntries(zip);
    check('zip: entries listed', ents.length === 2 && ents[1].name === 'b/y.txt', ents);
    check('zip: deflate entry read', zipRead(zip, ents[0]).toString() === 'Name:Sol Ring\nManaCost:1');
    const app = path.join(home, 'fakeapp');
    fs.mkdirSync(path.join(app, 'res', 'cardsfolder'), { recursive: true });
    fs.writeFileSync(path.join(app, 'res', 'cardsfolder', 'cardsfolder.zip'), zip);
    check('forge: names indexed from cardsfolder.zip', forge.indexForgeNames(app) === 2);
    const { normName } = await import('../server/store.mjs');
    const names = new Map(['Sol Ring', 'Lim-Dûl\'s Vault', 'Ojer Kaslem, Deepest Growth'].map((n) => [normName(n), n]));
    check('forge: accent-insensitive name', forge.toForgeName('Lim-Dul\'s Vault', names) === 'Lim-Dûl\'s Vault');
    check('forge: DFC front face', forge.toForgeName('Ojer Kaslem, Deepest Growth // Temple of Cultivation', names) === 'Ojer Kaslem, Deepest Growth');
    check('forge: unknown → null', forge.toForgeName('Not A Card', names) === null);
    check('forge: label is log-safe', forge.forgeLabel("Atraxa, Praetors' Voice") === 'atraxa-praetors-voice');

    // ---- dck ----
    const toDeck = parseDeck(rawDeck(10, 'Sol Ring', 'C'));
    const dnames = new Map([['sol ring', 'Sol Ring'], ['forest', 'Forest']]);
    const dck = forge.buildDck(toDeck, 'alvo-10', { names: dnames });
    check('dck: commander + main sections', /\[Commander\]\n1 Sol Ring\n\[Main\]\n99 Forest/.test(dck.text) && dck.count === 100 && !dck.missing.length, dck.text);
    const dck2 = forge.buildDck(toDeck, 'x', { names: new Map([['forest', 'Forest']]) });
    check('dck: missing cards reported', dck2.missing.includes('Sol Ring'), dck2.missing);
    const sw = forge.buildDck(toDeck, 'x', { names: new Map([...dnames, ['island', 'Island']]), swaps: [{ out: 'Forest', in: 'Island' }] });
    check('dck: swaps applied (98 Forest + 1 Island)', /98 Forest/.test(sw.text) && /1 Island/.test(sw.text) && sw.count === 100, sw.text);

    // ---- triggers ----
    const t1 = cardTriggers({ text: 'Landfall — Whenever a land you control enters, create a 1/1 token.\nFlying' });
    check('triggers: landfall found', t1.length === 1 && t1[0].kind === 'landfall', t1);
    const t2 = cardTriggers({ text: 'If a creature would die, exile it instead. At the beginning of your upkeep, draw a card.' });
    check('triggers: replacement + phase', t2.map((x) => x.kind).join(',') === 'replacement,phase', t2);
    const scan = scanDeck([{ name: 'A' }, { name: 'B' }, { name: 'C' }], (n) => (n === 'A' ? { name: 'A', text: 'When A enters, draw a card.', roles: [] } : n === 'B' ? { name: 'B', text: 'Destroy target creature.', roles: ['removal'] } : null));
    check('triggers: scan keeps trigger + role cards, lists unknown', scan.cards.length === 2 && scan.unknown[0] === 'C' && scan.counts.etb === 1, scan);
    check('triggers: render one line per card', renderScan(scan).split('\n').length === 3);

    // ---- stats ----
    const w = M.wilson(40, 160);
    check('stats: wilson 40/160 ≈ 25% [19–32]', w.p === 25 && w.lo > 18 && w.lo < 20 && w.hi > 31 && w.hi < 33, w);
    const now = new Date(2026, 9, 11, 22, 0, 0);
    check('stats: until 07:30 → next morning', M.untilTime('07:30', now).getDate() === 12);
    check('stats: until 23:00 → today', M.untilTime('23:00', now).getDate() === 11);
    let badUntil = false;
    try {
      M.untilTime('25:00');
    } catch {
      badUntil = true;
    }
    check('stats: invalid until rejected', badUntil);
    const base = { won: false, draw: false, reason: 'life total reached 0', landsBy4: 4, mull: 0, lostRound: 9, wipes: [], castsAfterLastWipe: null, idleLate: 0, lands: 8 };
    check('cause: mana screw', M.lossCause({ ...base, landsBy4: 2 }) === 'travou de mana');
    check('cause: early death', M.lossCause({ ...base, lostRound: 4 }) === 'morreu cedo');
    check('cause: wipe without recovery', M.lossCause({ ...base, wipes: [{ r: 7 }], castsAfterLastWipe: 1 }) === 'wipe sem recuperação');
    check('cause: out of gas', M.lossCause({ ...base, idleLate: 2 }) === 'ficou sem gás');
    check('cause: commander damage', M.lossCause({ ...base, reason: 'commander damage' }) === 'dano de comandante');
    check('cause: default race', M.lossCause(base) === 'perdeu a corrida');
    check('cause: win → null', M.lossCause({ ...base, won: true }) === null);

    // ---- end-to-end job with fake Forge ----
    console.log('\n# Phase 4 end-to-end (fake Forge)');
    const fake = path.join(here, 'fake-forge.mjs');
    fs.chmodSync(fake, 0o755);
    process.env.FORGE_JAVA = process.platform === 'win32' ? process.execPath : fake;
    process.env.FORGE_JAR = fake;
    process.env.FORGE_WORKERS = '2';
    if (process.platform === 'win32') {
      check('e2e skipped on Windows (fake java needs a shebang)', true);
      return;
    }
    const cardNames = ['Toph, Hardheaded Teacher', 'Forest', 'Lotus Cobra', 'Edgar Markov', 'Talrand, Sky Summoner', 'Atraxa, Praetors\' Voice', 'Yuriko, the Tiger\'s Shadow', 'Krenko, Mob Boss', 'Big Card', 'Old Card', 'Gc One', 'Gc Two', 'Gc Three', 'Gc Four', 'Ponder'];
    fs.mkdirSync(path.join(home, 'data', 'forge'), { recursive: true });
    fs.writeFileSync(path.join(home, 'data', 'forge', 'names.json'), JSON.stringify(Object.fromEntries(cardNames.map((n) => [normName(n), n]))));
    check('e2e: forge status ready with FORGE_JAVA/FORGE_JAR', forge.forgeStatus().ready === true, forge.forgeStatus());
    const decks = {
      1: parseDeck(rawDeck(1, 'Toph, Hardheaded Teacher', 'RG', ['Lotus Cobra', 'Ponder'])),
      2: parseDeck(rawDeck(2, 'Edgar Markov', 'WBR', ['Ponder'])),
      3: parseDeck(rawDeck(3, 'Talrand, Sky Summoner', 'U', ['Ponder'])),
      4: parseDeck(rawDeck(4, "Atraxa, Praetors' Voice", 'WUBG', ['Ponder'])),
      5: parseDeck(rawDeck(5, "Yuriko, the Tiger's Shadow", 'UB', ['Ponder'])),
      6: parseDeck(rawDeck(6, 'Krenko, Mob Boss', 'R', ['Unknown To Forge'])), // rejected: forge
      7: parseDeck(rawDeck(7, 'Edgar Markov', 'WBR', ['Ponder'])), // rejected: duplicate commander
      8: parseDeck(rawDeck(8, 'Krenko, Mob Boss', 'R', ['Gc One', 'Gc Two', 'Gc Three', 'Gc Four'], { gc: 4 })), // rejected: game changers
    };
    const listRows = Object.values(decks)
      .map((d) => ({ id: d.id, edhBracket: 3, size: 100, private: false, updatedAt: new Date().toISOString() }))
      .concat([{ id: 99, edhBracket: 4, size: 100, updatedAt: new Date().toISOString() }, { id: 98, edhBracket: 3, size: 60, updatedAt: new Date().toISOString() }, { id: 97, edhBracket: 3, size: 100, updatedAt: '2020-01-01T00:00:00Z' }]);
    let searches = 0;
    const client = {
      request: async (method, p, { params }) => {
        searches++;
        return params.page === 1 || searches === 1 ? { results: listRows } : { results: [] };
      },
    };
    const getDeck = async (id) => decks[id];
    const started = M.launchJob({ client, getDeck, target: decks[1], bracket: 3, mode: 'rapido', games: 16, seed: 5 });
    check('e2e: launch returns job id immediately', /^\d{14}-1$/.test(started.id), started);
    await M.waitPrepared(started.id);
    const job = M.readJob(started.id);
    const poolIds = job.pool.map((d) => d.id);
    check('e2e: pool keeps the 4 valid decks (one Edgar only)', poolIds.length === 4 && [3, 4, 5].every((x) => poolIds.includes(x)) && (poolIds.includes(2) !== poolIds.includes(7)), poolIds);
    check('e2e: rejected counts (bracket, size, old, forge, duplicate, game changers)', job.poolRejected.bracket >= 1 && job.poolRejected.size >= 1 && job.poolRejected.old >= 1 && job.poolRejected.forge === 1 && job.poolRejected.duplicate === 1 && job.poolRejected.gameChangers === 1, job.poolRejected);
    check('e2e: pods of 3 distinct opponents', job.pods.every((p) => p.length === 3 && new Set(p).size === 3), job.pods);
    check('e2e: tasks cover 16 games, all 4 seats', job.tasks.reduce((s, t) => s + t.games, 0) === 16 && new Set(job.tasks.map((t) => t.seat)).size === 4, job.tasks);
    check('e2e: .dck files written', fs.readdirSync(path.join(home, 'data', 'matchups', started.id, 'decks')).length === 5);
    await M.waitJob(started.id);
    const st = M.jobStatus(started.id);
    check('e2e: job finished with all games', st.state === 'concluído' && st.gamesDone === 16 && st.failedTasks === 0, st);
    const rep = M.jobReport(started.id);
    check('e2e: report win rate with CI', rep.summary.games === 16 && rep.summary.winRate.p != null && rep.summary.winRate.lo <= rep.summary.winRate.p, rep.summary.winRate);
    check('e2e: report seats and causes', Object.keys(rep.summary.bySeat).length === 4 && rep.summary.lossCauses.length >= 1, rep.summary);
    check('e2e: killers resolved to commanders', rep.summary.killers.length >= 1 && rep.summary.killers.every((k) => k.commander && !/^alvo/.test(k.commander)), rep.summary.killers);
    check('e2e: key games with story lines', rep.keyGames.length >= 2 && rep.keyGames.every((k) => k.story.length >= 1), rep.keyGames);
    check('e2e: card stats include Lotus Cobra', rep.summary.dead.some((c) => c.card === 'Lotus Cobra') || rep.summary.mvp.some((c) => c.card === 'Lotus Cobra'), rep.summary);
    check('e2e: opponents listed with links', rep.opponents.length === 4 && rep.opponents.every((o) => o.url.startsWith('https://archidekt.com/decks/')), rep.opponents);
    const sz = JSON.stringify(rep).length;
    check('e2e: report stays compact (< 20 kB)', sz < 20000, sz);

    // A/B: same pods and seeds, modified list
    const ab = M.launchJob({ client, getDeck, target: decks[1], bracket: 3, mode: 'rapido', swaps: [{ out: 'Ponder', in: 'Lotus Cobra' }], compareTo: started.id });
    await M.waitPrepared(ab.id);
    const abJob = M.readJob(ab.id);
    check('e2e A/B: reuses base pool, pods and seeds', JSON.stringify(abJob.pods) === JSON.stringify(job.pods) && abJob.tasks.map((t) => t.seed).join() === job.tasks.map((t) => t.seed).join(), abJob.tasks);
    const abDck = fs.readFileSync(path.join(home, 'data', 'matchups', ab.id, 'decks', 'alvo-1.dck'), 'utf8');
    check('e2e A/B: swapped list written', !/Ponder/.test(abDck) && (abDck.match(/Lotus Cobra/g) || []).length === 2, abDck);
    await M.waitJob(ab.id);
    const abRep = M.jobReport(ab.id);
    check('e2e A/B: comparison with verdict', abRep.comparison && abRep.comparison.pairedGames === 16 && typeof abRep.comparison.verdict === 'string', abRep.comparison);
    check('e2e: list jobs shows both', M.listJobs().length === 2);

    // stop + resume
    const long = M.launchJob({ client, getDeck, target: decks[1], bracket: 3, mode: 'rapido', games: 40, seed: 9 });
    await M.waitPrepared(long.id);
    const stopped = M.stopJob(long.id);
    await M.waitJob(long.id);
    check('e2e: stop works', stopped.stopped === true && M.readJob(long.id).state === 'parado', M.readJob(long.id).state);
    const resumed = M.startJob(long.id);
    await M.waitJob(long.id);
    check('e2e: resume runs the pending tasks', resumed.started === true && M.jobStatus(long.id).gamesDone === 40, M.jobStatus(long.id));
  } finally {
    if (prevHome === undefined) delete process.env.ARCHIDEKT_HOME;
    else process.env.ARCHIDEKT_HOME = prevHome;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// Standalone: node tests/phase4-tests.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let passed = 0;
  let failed = 0;
  const check = (name, cond, extra) => {
    if (cond) {
      passed++;
      console.log(`  ok   ${name}`);
    } else {
      failed++;
      console.log(`  FAIL ${name}${extra !== undefined ? `\n       ${JSON.stringify(extra).slice(0, 800)}` : ''}`);
    }
  };
  await runPhase4({ check });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
