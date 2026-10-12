#!/usr/bin/env node
// Stand-in for "java -jar forge.jar sim ..." in tests: reads the same arguments and prints a Forge-like log.
// Winner of game g = seat (seed + g) % players. Every seat plays lands and casts the first cards of its deck.

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('-version')) {
  console.error('openjdk version "21.0.8" 2025-07-15');
  process.exit(0);
}
const at = (flag) => argv.indexOf(flag);
const dir = argv[at('-D') + 1];
const decks = [];
for (let i = at('-d') + 1; i < argv.length && !argv[i].startsWith('-'); i++) decks.push(argv[i]);
const games = Number(argv[at('-n') + 1] || 1);
const seed = at('-s') >= 0 ? Number(argv[at('-s') + 1]) : 0;

const lists = decks.map((f) => {
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  const label = /Name=(.+)/.exec(text)[1].trim();
  const cards = text
    .split('\n')
    .filter((l) => /^\d+ /.test(l))
    .map((l) => l.replace(/^\d+ /, '').trim());
  return { label, cards };
});
const P = (i) => `Ai(${i + 1})-${lists[i].label}`;
const out = [];
out.push('Simulation mode');
for (let g = 1; g <= games; g++) {
  const winner = (seed + g) % lists.length;
  for (let i = 0; i < lists.length; i++) out.push(`Mulligan: ${P(i)} has kept a hand of 7 cards`);
  let turn = 0;
  const life = lists.map(() => 40);
  const ids = lists.map((_, i) => 100 * (i + 1));
  for (let round = 1; round <= 6; round++) {
    for (let i = 0; i < lists.length; i++) {
      if (life[i] <= 0) continue;
      turn++;
      out.push(`Turn: Turn ${turn} (${P(i)})`);
      out.push(`Phase: ${P(i)}'s Main phase, precombat`);
      out.push(`Land: ${P(i)} played Forest (${ids[i]++})`);
      const card = lists[i].cards[round % lists[i].cards.length];
      out.push(`Add To Stack: ${P(i)} cast ${card}`);
      out.push(`Resolve Stack: ${card}`);
      if (i === winner && round >= 4) {
        for (let v = 0; v < lists.length; v++) {
          if (v === i || life[v] <= 0) continue;
          const id = ids[i]++;
          out.push(`Combat: ${P(i)} assigned Big Beast (${id}) to attack ${P(v)}.`);
          out.push(`Damage: Big Beast (${id}) deals 15 combat damage to ${P(v)}.`);
          const before = life[v];
          life[v] -= 15;
          out.push(`Life: Life: ${P(v)} ${before} > ${life[v]}`);
        }
      }
    }
  }
  out.push('Game Outcome: Match Duration 0m : 01s');
  out.push(`Game Outcome: Turn ${turn}`);
  for (let i = 0; i < lists.length; i++) out.push(`Game Outcome: ${P(i)} has ${i === winner ? 'won because all opponents have lost' : 'lost because life total reached 0'}`);
  out.push(`Game Result: Game ${g} ended in 1000 ms. ${P(winner)} has won!`);
  out.push('');
}
process.stdout.write(out.join('\n'));
