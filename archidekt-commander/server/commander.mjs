// Pure helpers: deck parsing, card matching, Commander validation. No I/O.

export const FORMATS = {
  1: 'standard', 2: 'modern', 3: 'commander', 4: 'legacy', 5: 'vintage', 6: 'pauper', 7: 'custom',
  14: 'oathbreaker', 15: 'pioneer', 17: 'paupercommander', 20: 'brawl', 23: 'predh',
};
export const FORMAT_IDS = Object.fromEntries(Object.entries(FORMATS).map(([k, v]) => [v, Number(k)]));
export const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G'];
const COLOR_NAMES = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G', w: 'W', u: 'U', b: 'B', r: 'R', g: 'G' };

export const deckUrl = (id) => `https://archidekt.com/decks/${id}`;

export function formatName(id) {
  return FORMATS[id] || (id == null ? null : `format ${id}`);
}

export function formatId(name) {
  if (name == null) return 3;
  if (typeof name === 'number') return name;
  const id = FORMAT_IDS[String(name).toLowerCase().replace(/[\s_-]/g, '')];
  if (!id) throw new Error(`Formato desconhecido: ${name}. Use um de: ${Object.values(FORMATS).join(', ')}`);
  return id;
}

/** Normalize colors from ["W","U"], ["White"], "WU", or {W: n} to a "WUBRG"-ordered string. */
export function normColors(c) {
  const set = new Set();
  const add = (x) => {
    const k = COLOR_NAMES[String(x).toLowerCase()];
    if (k) set.add(k);
  };
  if (Array.isArray(c)) c.forEach(add);
  else if (typeof c === 'string') [...c].forEach(add);
  else if (c && typeof c === 'object') for (const [k, v] of Object.entries(c)) if (v) add(k);
  return COLOR_ORDER.filter((x) => set.has(x)).join('') || 'C';
}

export const frontFace = (name) => String(name || '').split(' // ')[0].trim();
export const fold = (s) => String(s || '').trim().toLocaleLowerCase('en-US');

export function nameMatches(oracleName, wanted) {
  const a = fold(oracleName);
  const w = fold(wanted);
  return a === w || fold(frontFace(oracleName)) === fold(frontFace(wanted));
}

export function typeLine(o = {}) {
  const left = [...(o.superTypes || []), ...(o.types || [])].join(' ');
  const sub = (o.subTypes || []).join(' ');
  return sub ? `${left} — ${sub}` : left;
}

export function oracleText(o = {}) {
  if (o.text) return String(o.text);
  if (Array.isArray(o.faces)) return o.faces.map((f) => f?.text || '').join('\n');
  return '';
}

/** Archidekt stores descriptions as Quill JSON; return plain text. */
export function descriptionText(d) {
  if (!d) return '';
  if (typeof d === 'string') {
    try {
      const j = JSON.parse(d);
      if (j && Array.isArray(j.ops)) return j.ops.map((op) => (typeof op.insert === 'string' ? op.insert : '')).join('').trim();
    } catch {
      /* plain text */
    }
    return d;
  }
  if (Array.isArray(d.ops)) return d.ops.map((op) => (typeof op.insert === 'string' ? op.insert : '')).join('').trim();
  return '';
}

/**
 * Parse GET /decks/{id}/ into a normalized structure.
 * rows: [{relId, qty, name, cardid, set, number, mv, type, colorIdentity, category, categories, included,
 *         isCommander, modifier, owned, oracle, raw}]
 */
export function parseDeck(deck) {
  const cats = new Map();
  for (const c of deck.categories || []) cats.set(c.name, { premier: !!c.isPremier, included: c.includedInDeck !== false });
  const rows = [];
  for (const r of deck.cards || []) {
    if (r.deletedAt) continue;
    const card = r.card || {};
    const o = card.oracleCard || {};
    const categories = Array.isArray(r.categories) ? r.categories : [];
    const first = categories[0] || o.defaultCategory || 'Uncategorized';
    const info = cats.get(first);
    rows.push({
      relId: r.id,
      qty: Number(r.quantity) || 0,
      name: o.name || card.name || `card ${card.id}`,
      cardid: card.id,
      set: card.edition?.editioncode || null,
      number: card.collectorNumber || null,
      mv: o.cmc ?? null,
      type: typeLine(o),
      colorIdentity: normColors(o.colorIdentity),
      category: first,
      categories,
      // A companion starts the game outside the deck: it never counts toward the 100.
      included: !r.companion && (info ? info.included : !/^(maybeboard|sideboard)$/i.test(first)),
      isCommander: info ? info.premier : /^commander$/i.test(first),
      modifier: r.modifier || 'Normal',
      companion: !!r.companion,
      flippedDefault: !!r.flippedDefault,
      owned: card.owned ?? null,
      oracle: o,
    });
  }
  const commanders = rows.filter((r) => r.isCommander && r.included);
  const identity = normColors(commanders.flatMap((c) => c.oracle.colorIdentity || []));
  return {
    id: deck.id,
    name: deck.name,
    format: formatName(deck.deckFormat),
    deckFormat: deck.deckFormat,
    edhBracket: deck.edhBracket ?? null,
    private: !!deck.private,
    owner: deck.owner?.username ?? null,
    description: descriptionText(deck.description),
    categories: [...cats.entries()].map(([name, v]) => ({ name, ...v })),
    rows,
    commanders,
    identity: commanders.length ? identity : null,
    mainCount: rows.filter((r) => r.included).reduce((s, r) => s + r.qty, 0),
    otherCount: rows.filter((r) => !r.included).reduce((s, r) => s + r.qty, 0),
  };
}

/** Compact text rendering of a parsed deck. */
export function renderDeck(p, { includeMaybeboard = true } = {}) {
  const lines = [];
  lines.push(`# ${p.name} (id ${p.id}) — ${deckUrl(p.id)}`);
  lines.push(
    `Formato: ${p.format} | Bracket: ${p.edhBracket ?? '-'} | ${p.private ? 'privado' : 'público'} | dono: ${p.owner ?? '?'}`,
  );
  lines.push(`Comandante(s): ${p.commanders.map((c) => c.name).join(' + ') || '(nenhum)'} | Identidade de cor: ${p.identity ?? '?'}`);
  lines.push(`Cartas no deck: ${p.mainCount} | Fora do deck (maybe/side): ${p.otherCount}`);
  if (p.description) lines.push(`Descrição: ${p.description.slice(0, 300)}${p.description.length > 300 ? '…' : ''}`);
  lines.push('Linha: qtd nome | MV | tipo | rel=deckRelationId card=cardid set owned');
  const groups = new Map();
  for (const r of p.rows) {
    if (!includeMaybeboard && !r.included) continue;
    if (!groups.has(r.category)) groups.set(r.category, []);
    groups.get(r.category).push(r);
  }
  const order = [...groups.keys()].sort((a, b) => {
    const ra = groups.get(a)[0];
    const rb = groups.get(b)[0];
    const rank = (r) => (r.isCommander ? 0 : r.included ? 1 : 2);
    return rank(ra) - rank(rb) || a.localeCompare(b);
  });
  for (const cat of order) {
    const rs = groups.get(cat).sort((a, b) => (a.mv ?? 0) - (b.mv ?? 0) || a.name.localeCompare(b.name));
    const total = rs.reduce((s, r) => s + r.qty, 0);
    const tag = rs[0].isCommander ? ' [commander]' : rs[0].included ? '' : ' [fora do deck]';
    lines.push(`\n## ${cat} (${total})${tag}`);
    for (const r of rs) {
      const fin = r.modifier && r.modifier !== 'Normal' ? ` ${r.modifier}` : '';
      lines.push(`${r.qty} ${r.name} | ${r.mv ?? '-'} | ${r.type} | rel=${r.relId} card=${r.cardid} ${r.set ?? ''}${fin} owned=${r.owned ?? '?'}`);
    }
  }
  return lines.join('\n');
}

/** Compact summary of a card printing from /cards/v2/. */
export function cardSummary(c) {
  const o = c.oracleCard || {};
  return {
    cardid: c.id,
    name: o.name,
    set: c.edition?.editioncode ?? null,
    number: c.collectorNumber ?? null,
    finishes: c.options || [],
    type: typeLine(o),
    mv: o.cmc ?? null,
    manaCost: o.manaCost ?? null,
    colorIdentity: normColors(o.colorIdentity),
    commanderLegal: o.legalities ? o.legalities.commander ?? 'unknown' : 'unknown',
    gameChanger: !!o.gameChanger,
  };
}

export function finishToModifier(f) {
  if (!f) return 'Normal';
  const k = String(f).toLowerCase();
  if (k.startsWith('foil')) return 'Foil';
  if (k.startsWith('etch')) return 'Etched';
  return 'Normal';
}

// ---------- Commander validation ----------

const hasType = (o, t) => (o.types || []).some((x) => fold(x) === fold(t));
const hasSuper = (o, t) => (o.superTypes || []).some((x) => fold(x) === fold(t));
const hasSub = (o, t) => (o.subTypes || []).some((x) => fold(x) === fold(t));
// Keyword at line start or after a comma in a keyword list, e.g. "Partner", "Flying, partner".
const kw = (re) => new RegExp(`(^|,\\s*)${re}`, 'im');
const PARTNER_WITH = kw("partner with ([^\\n(]+?)\\s*(?:\\(|$)");
const PARTNER_PLAIN = kw("partner(?:\\s*[—–-]\\s*([^\\n(,]+?))?\\s*(?=\\(|,|$)");
const FRIENDS = kw('friends forever\\b');
const CHOOSE_BG = kw('choose a background\\b');
const DOCTORS_COMPANION = kw("doctor['’]s companion\\b");

/** Returns null when the two commanders may legally be paired, else a reason (rule 702.124 and variants). */
export function pairingProblem(a, b) {
  const ta = oracleText(a.oracle);
  const tb = oracleText(b.oracle);
  const isBg = (r) => hasType(r.oracle, 'Enchantment') && hasSub(r.oracle, 'Background');
  const isDoctor = (r) => hasType(r.oracle, 'Creature') && hasSub(r.oracle, 'Time Lord') && hasSub(r.oracle, 'Doctor');
  const pwA = ta.match(PARTNER_WITH);
  const pwB = tb.match(PARTNER_WITH);
  if (pwA && pwB && nameMatches(b.name, pwA[2]) && nameMatches(a.name, pwB[2])) return null;
  const plA = ta.match(PARTNER_PLAIN);
  const plB = tb.match(PARTNER_PLAIN);
  if (plA && plB && fold(plA[2] || '') === fold(plB[2] || '')) return null;
  if (FRIENDS.test(ta) && FRIENDS.test(tb)) return null;
  if ((CHOOSE_BG.test(ta) && isBg(b)) || (CHOOSE_BG.test(tb) && isBg(a))) return null;
  if ((DOCTORS_COMPANION.test(ta) && isDoctor(b)) || (DOCTORS_COMPANION.test(tb) && isDoctor(a))) return null;
  return `${a.name} + ${b.name} não formam uma dupla válida (Partner, Partner with, Friends forever, Choose a Background + Background ou Doctor's companion + Time Lord Doctor).`;
}

function copyLimit(row) {
  const o = row.oracle;
  if (hasSuper(o, 'Basic') && hasType(o, 'Land')) return Infinity; // incl. Wastes and snow basics
  const text = oracleText(o);
  if (/a deck can have any number of cards named/i.test(text)) return Infinity;
  const m = text.match(/a deck can have up to (\w+) cards named/i);
  if (m) {
    const words = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    return words[m[1].toLowerCase()] ?? (Number(m[1]) || 1);
  }
  return 1;
}

function canBeCommander(row) {
  const o = row.oracle;
  const legendaryCreature = hasSuper(o, 'Legendary') && hasType(o, 'Creature');
  return legendaryCreature || /can be your commander/i.test(oracleText(o)) || hasSub(o, 'Background');
}

export function validateCommander(p) {
  const errors = [];
  const warnings = [];
  const main = p.rows.filter((r) => r.included);

  if (p.deckFormat !== 3) warnings.push(`O deck está no formato "${p.format}", não commander.`);

  // count
  if (p.mainCount !== 100) errors.push(`O deck tem ${p.mainCount} cartas (precisa de exatamente 100, incluindo o(s) comandante(s)).`);

  // commander(s)
  if (p.commanders.length === 0) errors.push('Nenhum comandante encontrado (categoria "Commander").');
  if (p.commanders.length > 2) errors.push(`Comandantes demais: ${p.commanders.map((c) => c.name).join(', ')}.`);
  for (const c of p.commanders) {
    if (!canBeCommander(c)) errors.push(`${c.name} não parece poder ser comandante (não é criatura lendária nem diz "can be your commander").`);
  }
  if (p.commanders.length === 1 && hasSub(p.commanders[0].oracle, 'Background')) {
    errors.push(`${p.commanders[0].name} é um Background: só pode ser comandante junto com uma criatura com "Choose a Background".`);
  }
  if (p.commanders.length === 2) {
    const problem = pairingProblem(p.commanders[0], p.commanders[1]);
    if (problem) errors.push(problem);
  }

  // companion: outside the 100, but must still respect color identity and legality
  const companions = p.rows.filter((r) => r.companion);
  if (companions.length > 1) errors.push(`Mais de um companheiro: ${companions.map((c) => c.name).join(', ')}.`);
  for (const c of companions) {
    if (!/\bcompanion\s*[—–-]/i.test(oracleText(c.oracle))) warnings.push(`${c.name} está marcado como companheiro mas não tem a habilidade Companion.`);
    const leg = c.oracle.legalities?.commander;
    if (leg != null && leg !== 'legal') errors.push(`Companheiro não é legal em Commander (${leg}): ${c.name}.`);
    warnings.push(`Companheiro ${c.name}: confira manualmente a condição de deckbuilding dele.`);
  }

  // singleton
  const byName = new Map();
  for (const r of main) {
    const k = fold(r.name);
    if (!byName.has(k)) byName.set(k, { row: r, qty: 0 });
    byName.get(k).qty += r.qty;
  }
  for (const { row, qty } of byName.values()) {
    const lim = copyLimit(row);
    if (qty > lim) errors.push(`Singleton: ${qty}x ${row.name} (máximo ${lim}).`);
  }

  // color identity
  if (p.identity) {
    const allowed = new Set(p.identity === 'C' ? [] : [...p.identity]);
    for (const r of [...main, ...companions]) {
      if (r.isCommander) continue;
      const off = r.colorIdentity === 'C' ? [] : [...r.colorIdentity].filter((c) => !allowed.has(c));
      if (off.length) errors.push(`Fora da identidade de cor (${p.identity}): ${r.name} [${r.colorIdentity}].`);
    }
  }

  // legality
  for (const { row } of byName.values()) {
    const leg = row.oracle.legalities?.commander;
    if (leg == null) warnings.push(`Legalidade desconhecida: ${row.name}.`);
    else if (leg !== 'legal') errors.push(`Não é legal em Commander (${leg}): ${row.name}.`);
  }

  const gameChangers = [...byName.values()].filter((x) => x.row.oracle.gameChanger).map((x) => x.row.name);
  if (gameChangers.length > 3) warnings.push(`${gameChangers.length} Game Changers: deck é no mínimo bracket 4.`);
  else if (gameChangers.length > 0) warnings.push(`${gameChangers.length} Game Changer(s): brackets 1–2 não permitem; bracket 3 permite até 3.`);

  return {
    deckId: p.id,
    name: p.name,
    valid: errors.length === 0,
    commanders: p.commanders.map((c) => c.name),
    companion: companions.map((c) => c.name),
    colorIdentity: p.identity,
    cardCount: p.mainCount,
    declaredBracket: p.edhBracket,
    gameChangers: { count: gameChangers.length, cards: gameChangers },
    errors,
    warnings,
  };
}

// ---------------------------------------------------------------- color identity (hard rule)

/** Color letters (WUBRG order) of a color identity in any shape; '' for colorless. */
export function ciLetters(ci) {
  if (ci == null) return '';
  if (typeof ci === 'string' && /^[WUBRGC]*$/i.test(ci)) return ['W', 'U', 'B', 'R', 'G'].filter((c) => ci.toUpperCase().includes(c)).join('');
  const n = normColors(ci);
  return n === 'C' ? '' : n;
}

/**
 * Commander rule 903.4: every card must be inside the commander's color identity.
 * deckIdentity: 'RG', 'C' (colorless commander) or null (unknown → nothing is allowed except colorless).
 */
export function withinIdentity(cardCi, deckIdentity) {
  const allowed = ciLetters(deckIdentity);
  return [...ciLetters(cardCi)].every((c) => allowed.includes(c));
}

/**
 * The deck's color identity from its commander(s), double-checked with the local card cache
 * (Scryfall). Returns 'RG' / 'C' or null when the deck has no commander.
 */
export function deckIdentityOf(deck, lookup = () => null) {
  if (!deck.commanders?.length) return null;
  const set = new Set(ciLetters(deck.identity));
  for (const c of deck.commanders) {
    for (const x of ciLetters(c.oracle?.colorIdentity)) set.add(x);
    const rec = lookup(c.name);
    if (rec?.ci) for (const x of ciLetters(rec.ci)) set.add(x);
  }
  return ['W', 'U', 'B', 'R', 'G'].filter((c) => set.has(c)).join('') || 'C';
}
