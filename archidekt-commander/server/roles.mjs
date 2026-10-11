// Functional roles of cards: Scryfall oracle-tag whitelist, Archidekt oTags and oracle-text heuristics.
// Pure functions, no I/O.

export const CORE_ROLES = ['ramp', 'draw', 'removal', 'wipe', 'counter', 'tutor', 'protection', 'recursion', 'gy-hate'];
export const ROLES = [...CORE_ROLES, 'sac-outlet', 'tokens', 'landfall', 'lifegain', 'burn', 'evasion', 'anthem', 'wincon'];

// Tag slug → roles it grants by itself. Real Scryfall oracle tags are hierarchical (parent_ids) and the
// roots ("draw", "tutor", "protection", "recursion", "burn", "removal"…) have no direct taggings: cards
// carry only descendant tags, so roles flow down from ancestors (see resolveTagRoles).
// Checked in order; a slug may match several rules.
const TAG_RULES = [
  [/^(ramp|ramp-.+|.+-ramp|mana-rock|utility-mana-rock|manarock|mana-dork|manadork|extra-land|extra-land-drop|additional-land-drop|adds-multiple-mana|repeatable-treasures|treasure-generator|cost-reducer|mana-doubler)$/, ['ramp']],
  // Land tutors put lands into play/hand: that is ramp, not a "tutor" (see TAG_BLOCKS).
  [/^tutor-(land|basic)(-.+)?$/, ['ramp']],
  [/^(draw|pure-draw|burst-draw|repeatable-draw|draw-engine|repeatable-pure-draw|card-draw|card-advantage|repeatable-card-advantage|card-advantage-.+|tome|life-for-cards|curiosity|impulse|impulsive-draw|impulse-draw|wheel|draw-.+|.+-draw)$/, ['draw']],
  [/^(hate-graveyard|hate-graveyard-.+|single-minded-graveyard-hate|graveyard-hate|graveyard-exile|graveyard-removal|grave-hate|hoser-graveyard|graveyard-hoser|exile-graveyard)$/, ['gy-hate']],
  [/^(sweeper|sweeper-.+|.+-sweeper|board-wipe|boardwipe|board-wipe-.+|mass-removal|wrath|mass-bounce|mass-exile)$/, ['wipe']],
  [/^(removal|removal-.+|spot-removal|multi-removal|repeatable-removal|.+-removal|creature-removal|artifact-removal|enchantment-removal|planeswalker-removal|exile-removal|burn-creature|disenchant-naturalize|edict)$/, ['removal']],
  [/^(counterspell|counterspell-.+|hard-counter|soft-counter|counter-spell)$/, ['counter']],
  [/^(tutor|tutor-.+)$/, ['tutor']],
  [/^(protection|protects-creature|protects-all|protects-permanent|protects-planeswalker|gives-hexproof|gives-indestructible|gives-shroud|gives-protection|gives-ward|grants-hexproof|grants-indestructible|hexproof-granting|indestructible-granting|damage-prevention-creature|phasing|blink-protect)$/, ['protection']],
  [/^(recursion|recursion-.+|reanimate|reanimate-.+|reanimation|reanimation-.+|regrowth|regrowth-.+|raise-dead|gravedigger)$/, ['recursion']],
  [/^(sacrifice-outlet|sacrifice-outlet-.+|sac-outlet|repeatable-sacrifice-outlet|free-sacrifice-outlet)$/, ['sac-outlet']],
  // There is no "token-generator" root on Scryfall; one-shot token makers come from the text rules.
  [/^(repeatable-token-generator|repeatable-.+-tokens|token-generator|token-generator-.+|token-maker|token-creation|creates-tokens|makes-tokens)$/, ['tokens']],
  [/^(landfall|landfall-.+|lands-matter)$/, ['landfall']],
  [/^(extra-land|extra-land-drop|additional-land-drop)$/, ['landfall']],
  [/^(lifegain|life-gain|gain-life|repeatable-lifegain|lifegain-.+|gives-lifelink|drain-life)$/, ['lifegain']],
  // burn = damage/life loss to players; "burn-creature" is removal, not burn.
  [/^(burn|burn-player|burn-any|burn-opponent|burn-opponents|burn-each-opponent|burn-everyone|direct-damage|drain|life-drain|drain-life)$/, ['burn']],
  // Only tags that GRANT evasion: the plain "evasion" tag also marks creatures that merely have flying.
  [/^(gives-evasion|gives-flying|gives-trample|gives-menace|gives-shadow|gives-fear|gives-intimidate|gives-unblockable|gives-skulk|gives-horsemanship)$/, ['evasion']],
  [/^(anthem|anthem-.+|keyword-anthem|team-pump|overrun)$/, ['anthem']],
  [/^(win-condition|wincon|alternate-win-condition|alt-win|alternate-win|finisher|game-winner|infinite-combo)$/, ['wincon']],
];

// Exclusions: a matching tag gives NONE of these roles, neither its own nor inherited, and the block is
// inherited by every descendant (so e.g. tutor-land-to-battlefield, child of both tutor-land and
// tutor-to-battlefield, still is not a "tutor").
const ALL = '*';
const TAG_BLOCKS = [
  [/^(cantrip|cantrip-.+|force-draw|force-draw-.+)$/, ['draw']], // cantrips replace themselves; force-draw makes a player draw
  [/^tutor-(land|basic)(-.+)?$/, ['tutor']],
  [/^(protects-self|ward|ward-.+|gains-.+|regenerates-self|.+-self)$/, ['protection', 'recursion']], // self-protection / self-recursion
  [/^(sweeper|sweeper-.+|.+-sweeper|board-wipe|boardwipe|board-wipe-.+|mass-removal|wrath|mass-bounce|mass-exile)$/, ['removal']], // counted as wipe only
  [/^hate-counterspell(-.+)?$/, ALL], // "can't be countered": anti-counterspell
  [/graveyard/, ['removal']],
];

const normSlug = (slug) => String(slug || '').toLowerCase().trim().replace(/[\s_]+/g, '-');

function ownRoles(s) {
  const out = new Set();
  for (const [re, roles] of TAG_RULES) if (re.test(s)) for (const r of roles) out.add(r);
  if (s.includes('graveyard') && /(hate|exile|removal|hoser)/.test(s)) out.add('gy-hate');
  return out;
}

/** Roles this slug blocks for itself and all its descendants ('*' = all roles). */
export function blockedForSlug(slug) {
  const s = normSlug(slug);
  const out = new Set();
  for (const [re, roles] of TAG_BLOCKS) {
    if (!re.test(s)) continue;
    for (const r of roles === ALL ? ROLES : roles) out.add(r);
  }
  return out;
}

/** Roles a single tag slug grants by itself (not counting ancestors), after its own exclusions. */
export function rolesForSlug(slug) {
  const s = normSlug(slug);
  const blocked = blockedForSlug(s);
  return [...ownRoles(s)].filter((r) => !blocked.has(r));
}

/**
 * Given all oracle tags [{id, slug, parent_ids}], return Map tagId → {slug, roles[]} for the tags
 * that carry at least one role (own or inherited from an ancestor). Exclusions (TAG_BLOCKS) are
 * inherited too, and win over any role reached through another parent.
 */
export function resolveTagRoles(tags) {
  const byId = new Map(tags.map((t) => [t.id, t]));
  const memo = new Map();
  const EMPTY = { roles: new Set(), blocked: new Set() };
  const visit = (id, stack = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (stack.has(id)) return EMPTY;
    stack.add(id);
    const t = byId.get(id);
    const roles = new Set(t ? ownRoles(normSlug(t.slug)) : []);
    const blocked = new Set(t ? blockedForSlug(t.slug) : []);
    if (t) {
      for (const p of t.parent_ids || []) {
        const pv = visit(p, stack);
        for (const r of pv.roles) roles.add(r);
        for (const r of pv.blocked) blocked.add(r);
      }
    }
    for (const r of blocked) roles.delete(r);
    stack.delete(id);
    const res = { roles, blocked };
    memo.set(id, res);
    return res;
  };
  const out = new Map();
  for (const t of tags) {
    const { roles } = visit(t.id);
    if (roles.size) out.set(t.id, { slug: t.slug, roles: [...roles] });
  }
  return out;
}
const TEXT_RULES = {
  ramp: [
    /\badd (\{[wubrgc0-9x]\}|one mana|two mana|three mana|x mana|an amount of|mana of any|that much mana|\w+ mana)/,
    /search your library for (a|an|up to \w+|two|any number of) (basic )?(land|forest|plains|island|swamp|mountain)[^.]*onto the battlefield/,
    // Land tutors are ramp (not "tutor"), even when the land goes to hand.
    /search your library for (a|an|up to \w+|two|three|any number of|x) (basic |snow |nonbasic )*(lands?|forests?|plains|islands?|swamps?|mountains?)\b/,
    /you may play (an )?additional lands?/,
    /put (a|up to \w+) land cards? from your hand onto the battlefield/,
    /create (a|two|three|x|\w+) treasure tokens?/,
    /spells? you cast (cost|costs) \{\d\} less/,
  ],
  draw: [
    /draws? (two|three|four|five|six|seven|x|that many|\d+) cards/,
    /draw a card for each/,
    /whenever [^.]*,\s*(you may )?draw (a|two) cards?/,
    /at the beginning of [^.]*, (you may )?draw a card/,
    /exile the top (card|\w+ cards) of your library[^.]*(you may (play|cast)|until end of turn)/,
    /look at the top \w+ cards of your library[^.]*put (two|three|\w+) of them into your hand/,
    /\{t\}[^:]*: draw a card/,
  ],
  removal: [
    /(destroy|exile) (target|up to (one|two|three) target) (\w+ )?(creature|artifact|enchantment|planeswalker|permanent|nonland|noncreature|battle|land|attacking|tapped|token)/,
    /deals? (\d+|x|damage equal to [^.]+?) damage to (any target|target creature|target planeswalker|target attacking|another target)/,
    /(target player|target opponent|each opponent|each player) sacrifices (a|an|two) (creature|attacking|nonland|permanent|artifact|enchantment)/,
    /return (target|up to one target) (nonland permanent|creature|permanent|artifact|enchantment)[^.]* to (its|their) owner'?s'? hand/,
    /\bfights? (target|another target|up to one target)/,
    /target creature (gets|an opponent controls gets) -\d+\/-\d+/,
    /put target (creature|nonland permanent)[^.]* on (the bottom|top) of its owner'?s library/,
  ],
  wipe: [
    /(destroy|exile) (all|each) (other )?(creatures|nonland permanents|artifacts|enchantments|permanents|nontoken|non\w+ creatures|creatures and)/,
    /all (other )?creatures get -\d+\/-\d+/,
    /deals? (\d+|x) damage to each (other )?creature/,
    /return all (nonland permanents|creatures|other creatures)/,
    /each player sacrifices (all|that many|x)/,
  ],
  counter: [/counter target (spell|activated|triggered|noncreature|creature|instant|artifact|enchantment|ability)/, /counter (it|that spell) unless/],
  tutor: [/search your library for (a|an|up to (one|two|three)|any) (?!(basic|snow|nonbasic)\b)(?!lands?\b)(?!(forest|plains|island|swamp|mountain)s?\b)[^.]*?(card|cards)/],
  protection: [
    /(target|creatures|permanents|commander|equipped creature|enchanted creature|other)[^.]{0,40}(gains?|have|has) [^.]{0,30}(hexproof|indestructible|shroud|protection from)/,
    /\bphases? out\b/,
    /counter target spell[^.]* that targets/,
    /(creatures|permanents|you and|you control|commanders?)[^.]{0,30} can't be the targets? of/, // not "this creature can't be the target" (self)
    /prevent all (combat )?damage that would be dealt to (you|creatures you control)/,
  ],
  recursion: [
    /return [^.]*?(card|cards|creature|permanent)[^.]*? from (your|a|any) graveyard to (your hand|the battlefield)/,
    /(cast|play) [^.]* from your graveyard/,
    /return target [^.]* from your graveyard/,
  ],
  'sac-outlet': [/(^|\n|, )sacrifice (a|an|another|x|any number of) [^:.\n]{0,30}:/],
  'gy-hate': [
    /exile (all cards from )?(each opponent's|target player's|all|each player's|a player's) graveyards?/,
    /exile (target|up to \w+ target|all) cards? from (a|target|any|an opponent's|all|each) graveyards?/,
    /exile target card from a graveyard/,
    /if a (card|nontoken creature) would be put into (an opponent's|a) graveyard[^.]*, exile it instead/,
    /cards in graveyards (lose|can't)/,
    /players can't cast spells from graveyards/,
  ],
  tokens: [/create (a|an|one|two|three|four|five|x|that many|\d+|a number of) [^.]*tokens?/],
  landfall: [/\blandfall\b/, /whenever a land (you control )?enters( the battlefield)?( under your control)?/],
  lifegain: [/you gain (\d+|x|that much|\w+) life/, /\blifelink\b/],
  burn: [/deals? (\d+|x|\w+) damage to (each opponent|target player|any target|each player)/, /each opponent loses (\d+|x|\w+) life/],
  // Granting evasion only: "this creature can't be blocked" / own flying is not deck evasion.
  evasion: [/(creatures you control|target creature|equipped creature|enchanted creature|creatures|commander)[^.]{0,40}can't be blocked/, /(creatures you control|target creature|equipped creature|enchanted creature)[^.]{0,30}(gain|have|has|gets [^.]* and gains) (flying|trample|menace|shadow)/],
  anthem: [/creatures you control get \+\d+\/\+\d+/, /other [^.]{0,30} you control get \+\d+\/\+\d+/, /creatures you control get \+x\/\+x/],
  wincon: [/you win the game/, /each opponent loses the game/, /(an )?additional combat phase/, /extra combat/, /target player loses the game/, /each opponent loses (x|half)/],
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Clauses that make ANOTHER player draw (force-draw): not card advantage for you.
const OTHER_DRAWS = /(target player|target opponent|each opponent|an opponent|that player|its controller|its owner|defending player|that creature's controller)( may)? draws? [^.\n]*/g;
// Self-recursion (flashback-like, "return this card from your graveyard"): not a recursion role.
const SELF_RECURSION = /(return|put) (this card|this creature|this permanent|this artifact|this enchantment|it) from your graveyard[^.\n]*|(cast|play) (this card|this spell|this creature|this permanent|it) from your graveyard[^.\n]*/g;

/** Roles inferred from oracle text and type line. `name` (optional) lets self-references be recognized. */
export function textRoles(text, typeLine = '', name = '') {
  // Double-faced/split cards: evaluate each face with its own type (an MDFC's land face is not ramp).
  const faces = String(text || '').split(/\n\/\/\n/);
  if (faces.length > 1) {
    const types = String(typeLine || '').split('//');
    const out = new Set();
    faces.forEach((f, i) => textRoles(f, (types[i] ?? types[0] ?? '').trim(), name).forEach((r) => out.add(r)));
    return [...out];
  }
  let t = String(text || '').toLowerCase();
  // Card name (each face, and the short "Omnath" form) → "this card", so self-references read the same.
  const selfNames = new Set();
  for (const n of String(name || '').toLowerCase().split(' // ')) {
    if (n.trim().length >= 3) selfNames.add(n.trim());
    const short = n.split(',')[0].trim();
    if (short.length >= 3) selfNames.add(short);
  }
  for (const n of [...selfNames].sort((a, b) => b.length - a.length)) t = t.replace(new RegExp(`\\b${escapeRe(n)}\\b`, 'g'), 'this card');
  const type = String(typeLine || '').toLowerCase();
  const isLand = /\bland\b/.test(type.split('—')[0]);
  const out = new Set();
  const views = { draw: t.replace(OTHER_DRAWS, ''), recursion: t.replace(SELF_RECURSION, '') };
  for (const [role, res] of Object.entries(TEXT_RULES)) {
    const view = views[role] ?? t;
    if (res.some((re) => re.test(view))) out.add(role);
  }
  // Lands that only tap for mana are lands, not ramp; creature removal on a land (e.g. manlands) is rare.
  if (isLand) {
    out.delete('ramp');
    out.delete('tokens');
    if (!/(add \{[^}]+\}\{[^}]+\})/.test(t)) out.delete('ramp');
  }
  if (out.has('wipe') && !/(target)/.test(t)) out.delete('removal');
  return [...out];
}

/** Map Archidekt oTags (e.g. "Ramp", "Card Advantage", "Board Wipe") to roles. */
export function oTagRoles(oTags) {
  const out = new Set();
  for (const t of oTags || []) {
    const label = typeof t === 'string' ? t : t?.name || t?.label || t?.slug;
    for (const r of rolesForSlug(String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))) out.add(r);
  }
  return [...out];
}

/** Count color pips in a mana cost. Hybrid {W/U} counts half each; phyrexian {W/P} counts 1. */
export function pips(cost) {
  const out = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const m of String(cost || '').toUpperCase().matchAll(/\{([^}]+)\}/g)) {
    const sym = m[1];
    const cols = [...sym].filter((c) => 'WUBRG'.includes(c));
    if (!cols.length) continue;
    const w = /\//.test(sym) && !/\/P/.test(sym) && cols.length > 1 ? 1 / cols.length : 1;
    for (const c of new Set(cols)) out[c] += w;
  }
  return out;
}

const BASIC_COLORS = { plains: 'W', island: 'U', swamp: 'B', mountain: 'R', forest: 'G' };

/** Colors a land or mana source can produce, from text, subtypes and Archidekt manaProduction. */
export function producedColors({ text = '', typeLine = '', manaProduction = null } = {}) {
  const out = new Set();
  if (manaProduction && typeof manaProduction === 'object') {
    for (const [k, v] of Object.entries(manaProduction)) if (v && 'WUBRG'.includes(k.toUpperCase())) out.add(k.toUpperCase());
  }
  const t = String(text).toLowerCase();
  const type = String(typeLine).toLowerCase();
  for (const [sub, c] of Object.entries(BASIC_COLORS)) if (new RegExp(`\\b${sub}\\b`).test(type)) out.add(c);
  for (const m of t.matchAll(/add ([^.]*)/g)) {
    const seg = m[1];
    for (const s of seg.matchAll(/\{([wubrg])\}/g)) out.add(s[1].toUpperCase());
    if (/mana of any (one )?(color|type)|any combination of colors|one mana of any|mana of any of the|in any combination of/.test(seg)) 'WUBRG'.split('').forEach((c) => out.add(c));
  }
  // Fetch lands ("search your library for a Forest or Mountain card") count as sources of those colors.
  const fetch = t.match(/search your library for an? ([a-z ,]+?) card/);
  if (fetch && /\bland\b/.test(type)) for (const [sub, c] of Object.entries(BASIC_COLORS)) if (fetch[1].includes(sub)) out.add(c);
  if (/search your library for a basic land card/.test(t) && /\bland\b/.test(type)) 'WUBRG'.split('').forEach((c) => out.add(c));
  return [...out];
}

/** "tapped" | "conditional" | null */
export function etbTapped(text) {
  const t = String(text || '').toLowerCase();
  if (!/enters( the battlefield)? tapped/.test(t)) return null;
  if (/enters( the battlefield)? tapped unless|if you control two or (more|fewer)|you may pay [^.]*\. if you don't, it enters tapped|as [^.]* enters, you may/.test(t)) return 'conditional';
  return 'tapped';
}
