// Deck snapshots: card lists saved to data/snapshots/<deckId>/<timestamp>.json, plus diffs.

import fs from 'node:fs';
import path from 'node:path';
import { dataDir, fileStamp, normName, readJson, ToolError, writeJson } from './store.mjs';

const dirOf = (deckId) => dataDir('snapshots', String(Number(deckId)));

/** Snapshot rows of a parsed deck (from parseDeck). */
export function saveSnapshot(deck, note = null) {
  if (!Number.isInteger(Number(deck.id))) throw new ToolError('input', 'deck sem id numérico.');
  const takenAt = new Date();
  const id = fileStamp(takenAt);
  const snap = {
    deckId: deck.id,
    name: deck.name,
    takenAt: takenAt.toISOString(),
    note: note || null,
    count: deck.mainCount,
    cards: deck.rows.map((r) => ({ name: r.name, qty: r.qty, categories: r.categories.length ? r.categories : [r.category], included: r.included })),
  };
  let file = path.join(dirOf(deck.id), `${id}.json`);
  for (let i = 1; fs.existsSync(file); i++) file = path.join(dirOf(deck.id), `${id}-${i}.json`);
  writeJson(file, snap, { pretty: true });
  return { id: path.basename(file, '.json'), file, takenAt: snap.takenAt, cards: snap.cards.length, count: snap.count };
}

export function listSnapshots(deckId) {
  const dir = dirOf(deckId);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .sort()
    .map((f) => {
      const s = readJson(path.join(dir, f), null);
      return s ? { id: f.replace(/\.json$/, ''), takenAt: s.takenAt, note: s.note, count: s.count, name: s.name } : null;
    })
    .filter(Boolean);
}

export function loadSnapshot(deckId, id) {
  const list = listSnapshots(deckId);
  if (!list.length) throw new ToolError('not_found', `Nenhum snapshot para o deck ${deckId}. Use deck_snapshot primeiro.`);
  const pick = !id || id === 'latest' ? list[list.length - 1] : list.find((s) => s.id === id);
  if (!pick) throw new ToolError('not_found', `Snapshot "${id}" não existe. Disponíveis: ${list.slice(-10).map((s) => s.id).join(', ')}`);
  return { id: pick.id, ...readJson(path.join(dirOf(deckId), `${pick.id}.json`)) };
}

function aggregate(cards) {
  const m = new Map();
  for (const c of cards) {
    const k = normName(c.name);
    const cur = m.get(k) || { name: c.name, qty: 0, main: 0, categories: new Set() };
    cur.qty += c.qty;
    if (c.included !== false) cur.main += c.qty;
    for (const cat of c.categories || []) cur.categories.add(cat);
    m.set(k, cur);
  }
  return m;
}

/** Diff snapshot → current deck. */
export function diffSnapshot(snap, deck) {
  const a = aggregate(snap.cards);
  const b = aggregate(deck.rows.map((r) => ({ name: r.name, qty: r.qty, categories: r.categories.length ? r.categories : [r.category], included: r.included })));
  const added = [];
  const removed = [];
  const changed = [];
  const moved = [];
  for (const [k, now] of b) {
    const was = a.get(k);
    if (!was) added.push({ name: now.name, qty: now.qty, categories: [...now.categories] });
    else {
      if (was.qty !== now.qty || was.main !== now.main) changed.push({ name: now.name, from: was.qty, to: now.qty, mainFrom: was.main, mainTo: now.main });
      const wc = [...was.categories].sort().join('|');
      const nc = [...now.categories].sort().join('|');
      if (wc !== nc) moved.push({ name: now.name, from: [...was.categories], to: [...now.categories] });
    }
  }
  for (const [k, was] of a) if (!b.has(k)) removed.push({ name: was.name, qty: was.qty, categories: [...was.categories] });
  return { snapshot: snap.id, takenAt: snap.takenAt, countThen: snap.count, countNow: deck.mainCount, added, removed, changed, moved, unchanged: !added.length && !removed.length && !changed.length && !moved.length };
}
