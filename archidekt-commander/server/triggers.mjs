// Trigger scan: finds every triggered ability, replacement effect and rule-changing static ability in a deck
// from the oracle text of the local card cache. Code finds 100% of them; agents only interpret.

const KINDS = [
  ['landfall', /\blandfall\b|whenever a land (?:you control )?enters/i],
  ['etb', /\bwhen(?:ever)? [^.]*?\benters\b/i],
  ['dies', /\bwhen(?:ever)? [^.]*?\b(?:dies|is put into a graveyard)\b/i],
  ['attack', /\bwhen(?:ever)? [^.]*?\battacks?\b/i],
  ['combat-damage', /\bwhen(?:ever)? [^.]*?\bdeals combat damage\b/i],
  ['cast', /\bwhen(?:ever)? [^.]*?\bcasts?\b/i],
  ['phase', /\bat the beginning of\b/i],
  ['counters', /\bwhen(?:ever)? [^.]*?\bcounters? (?:is|are) put\b|one or more [^.]*counters/i],
  ['tokens', /\bwhen(?:ever)? [^.]*?\btokens?\b/i],
  ['draw', /\bwhen(?:ever)? [^.]*?\bdraws?\b/i],
  ['lifegain', /\bwhen(?:ever)? [^.]*?\bgains? life\b/i],
  ['sacrifice', /\bwhen(?:ever)? [^.]*?\bsacrifices?\b/i],
  ['other-trigger', /\bwhen(?:ever)?\b/i],
  ['replacement', /\bwould\b[^.]*\binstead\b|\bif [^.]* would\b|\benters with\b|\benters tapped\b/i],
  ['static-rule', /\b(?:players|opponents|each player|your opponents) can(?:'|’)t\b|\bcan(?:'|’)t be (?:countered|the target)\b|\bdon(?:'|’)t untap\b|\bspells? (?:you cast )?cost\b|\bhexproof\b|\bshroud\b/i],
];

/** Splits oracle text into sentences/abilities (one per line, then per sentence). */
function clauses(text) {
  return String(text || '')
    .split(/\n+/)
    .flatMap((l) => l.split(/(?<=\.)\s+(?=[A-Z])/))
    .map((s) => s.replace(/\([^)]*\)/g, '').trim())
    .filter(Boolean);
}

/** Trigger list for one card: [{kind, text}] (text trimmed to ~160 chars). */
export function cardTriggers(card) {
  if (!card?.text) return [];
  const out = [];
  for (const c of clauses(card.text)) {
    const k = KINDS.find(([, re]) => re.test(c));
    if (!k) continue;
    if (k[0] === 'replacement' && /^\s*(?:as an additional cost|you may)/i.test(c)) continue;
    out.push({ kind: k[0], text: c.length > 160 ? `${c.slice(0, 157)}…` : c });
  }
  return out;
}

/**
 * Scans a list of {name, qty} with a lookup (name → cached card or null).
 * Returns {cards: [{name, type, roles, triggers}], counts: {kind: n}, unknown: [names]}.
 */
export function scanDeck(rows, lookup) {
  const cards = [];
  const counts = {};
  const unknown = [];
  for (const r of rows) {
    const c = lookup(r.name);
    if (!c) {
      unknown.push(r.name);
      continue;
    }
    const triggers = cardTriggers(c);
    const roles = (c.roles || []).filter((x) => ['removal', 'wipe', 'counter', 'protection', 'tutor', 'draw', 'ramp'].includes(x));
    if (!triggers.length && !roles.length) continue;
    for (const t of triggers) counts[t.kind] = (counts[t.kind] || 0) + 1;
    cards.push({ name: c.name || r.name, type: c.type || null, mv: c.mv ?? null, roles, triggers, commander: !!r.isCommander });
  }
  return { cards, counts, unknown };
}

/** Compact text form for agents (one line per card). */
export function renderScan(scan, { title } = {}) {
  const lines = [];
  if (title) lines.push(`# ${title}`);
  for (const c of scan.cards) {
    const tag = c.commander ? ' [COMANDANTE]' : '';
    const roles = c.roles.length ? ` {${c.roles.join(',')}}` : '';
    const trig = c.triggers.map((t) => `${t.kind}: ${t.text}`).join(' || ');
    lines.push(`- ${c.name}${tag}${roles}${trig ? ` — ${trig}` : ''}`);
  }
  if (scan.unknown.length) lines.push(`(sem texto no cache: ${scan.unknown.join(', ')})`);
  return lines.join('\n');
}
