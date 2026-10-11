// Phase 2 end-to-end tests: card cache job, translation, LigaMagic prices, EDHREC analysis funnel,
// snapshots and the personal wiki. All external services are local mocks (tests/mock-external.mjs).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDirs = [];
const tmp = (tag) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `archidekt-p2-${tag}-`));
  tmpDirs.push(d);
  return d;
};

async function waitJob(proc, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    const r = await proc.call('cards_cache_status');
    if (r.json && !r.json.job.running && r.json.job.step === 'done') return r.json;
    if (Date.now() - t0 > timeoutMs) return r.json;
    await sleep(100);
  }
}

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

export async function runPhase2(opts) {
  try {
    await phase2(opts);
  } finally {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  }
}

async function phase2({ McpProc, baseEnv, check, ext, mockState, archBase, MOCK_USER }) {
  const extLog = async () => (await fetch(`${ext.origin}/__test/log`)).json();
  const reset = () => fetch(`${ext.origin}/__test/reset`);
  const creds = { ARCHIDEKT_API_BASE: archBase, ARCHIDEKT_EMAIL: MOCK_USER.email, ARCHIDEKT_PASSWORD: MOCK_USER.password };

  // ---------------- pure units ----------------
  console.log('\n# Phase 2 units');
  {
    const liga = await import('../server/ligamagic.mjs');
    check('parseBRL thousands', liga.parseBRL('R$ 7.499,00') === 7499 && liga.parseBRL('R$ 67,83') === 67.83 && liga.parseBRL('R$ 1.250,50') === 1250.5);
    check('parseBRL zero/garbage → null', liga.parseBRL('R$ 0,00') === null && liga.parseBRL('—') === null && liga.parseBRL(undefined) === null);
    check('decodeHtml entities', liga.decodeHtml('Dragon&#39;s &amp; &quot;x&quot;') === 'Dragon\'s & "x"');
    const { commanderSlug, pageSlug } = await import('../server/edhrec.mjs');
    check('EDHREC slug rules', commanderSlug('Quintorius, History Chaser') === 'quintorius-history-chaser' && commanderSlug('Toph, the First Metalbender') === 'toph-the-first-metalbender' && commanderSlug("Atraxa, Praetors' Voice") === 'atraxa-praetors-voice');
    check('EDHREC partner slug alphabetical', pageSlug(['Tymna the Weaver', 'Thrasios, Triton Hero']) === 'thrasios-triton-hero-tymna-the-weaver');
    const { normName, levenshtein } = await import('../server/store.mjs');
    check('normName strips accents/punctuation', normName("  Relâmpago!! ") === 'relampago' && normName("Kodama's Reach") === 'kodamas reach' && normName('Valakut Awakening // Valakut Stoneforge') === 'valakut awakening valakut stoneforge');
    check('levenshtein', levenshtein('sol rign', 'sol ring') === 2 && levenshtein('abc', 'abc') === 0);
    const { rolesForSlug, resolveTagRoles, textRoles, pips, producedColors, etbTapped } = await import('../server/roles.mjs');
    check('tag whitelist: removal children, graveyard not removal', rolesForSlug('removal-creature').includes('removal') && !rolesForSlug('graveyard-removal').includes('removal') && rolesForSlug('graveyard-removal').includes('gy-hate'));
    check('tag whitelist ignores flavor tags', rolesForSlug('flavor-text-reference').length === 0);
    const tr = resolveTagRoles([{ id: 'a', slug: 'removal', parent_ids: [] }, { id: 'b', slug: 'odd-child', parent_ids: ['a'] }, { id: 'c', slug: 'grandchild', parent_ids: ['b'] }, { id: 'x', slug: 'loop', parent_ids: ['y'] }, { id: 'y', slug: 'loop2', parent_ids: ['x'] }]);
    check('tag roles inherited through parents (cycles safe)', tr.get('c')?.roles.includes('removal') && !tr.has('x'), [...tr.entries()]);
    const real = [
      { id: 'draw', slug: 'draw', parent_ids: [] }, { id: 'pd', slug: 'pure-draw', parent_ids: ['draw'] }, { id: 'can', slug: 'cantrip', parent_ids: ['pd'] }, { id: 'canc', slug: 'cantrip-artifact', parent_ids: ['can'] },
      { id: 'rd', slug: 'repeatable-draw', parent_ids: ['draw'] }, { id: 'rpd', slug: 'repeatable-pure-draw', parent_ids: ['pd', 'rd'] }, { id: 'fd', slug: 'force-draw', parent_ids: [] },
      { id: 'tut', slug: 'tutor', parent_ids: [] }, { id: 'tto', slug: 'tutor-to', parent_ids: ['tut'] }, { id: 'tbf', slug: 'tutor-to-battlefield', parent_ids: ['tto'] }, { id: 'tl', slug: 'tutor-land', parent_ids: ['tut'] },
      { id: 'tlbf', slug: 'tutor-land-to-battlefield', parent_ids: ['tbf', 'tl'] }, { id: 'tlb', slug: 'tutor-land-basic', parent_ids: ['tl'] }, { id: 'th', slug: 'tutor-to-hand', parent_ids: ['tto'] },
      { id: 'prot', slug: 'protection', parent_ids: [] }, { id: 'pc', slug: 'protects-creature', parent_ids: ['prot'] }, { id: 'dpc', slug: 'damage-prevention-creature', parent_ids: ['pc'] },
      { id: 'ps', slug: 'protects-self', parent_ids: [] }, { id: 'ward', slug: 'ward', parent_ids: ['ps'] }, { id: 'gi', slug: 'gains-indestructible', parent_ids: ['ps'] }, { id: 'rs', slug: 'regenerates-self', parent_ids: ['ps'] },
      { id: 'rec', slug: 'recursion', parent_ids: [] }, { id: 'rean', slug: 'reanimate', parent_ids: ['rec'] }, { id: 'rc', slug: 'recursion-creature', parent_ids: ['rec'] }, { id: 'rself', slug: 'recursion-self', parent_ids: ['rec'] },
      { id: 'reanc', slug: 'reanimate-creature', parent_ids: ['rean', 'rc'] }, { id: 'reans', slug: 'reanimate-self', parent_ids: ['rean', 'rself'] }, { id: 'regs', slug: 'regrowth-self', parent_ids: ['rself'] },
      { id: 'rem', slug: 'removal', parent_ids: [] }, { id: 'sw', slug: 'sweeper', parent_ids: ['rem'] }, { id: 'sw1', slug: 'sweeper-one-sided', parent_ids: ['sw'] }, { id: 'spot', slug: 'spot-removal', parent_ids: ['rem'] },
      { id: 'rb', slug: 'removal-burn', parent_ids: ['rem'] }, { id: 'rcre', slug: 'removal-creature', parent_ids: ['rem'] }, { id: 'bc', slug: 'burn-creature', parent_ids: ['rb', 'rcre'] }, { id: 'fight', slug: 'removal-fight', parent_ids: ['bc'] },
      { id: 'dn', slug: 'disenchant-naturalize', parent_ids: [] }, { id: 'cs', slug: 'counterspell', parent_ids: [] }, { id: 'hcs', slug: 'hate-counterspell', parent_ids: [] }, { id: 'cssm', slug: 'counterspell-with-set-mechanic', parent_ids: ['cs'] },
      { id: 'ev', slug: 'evasion', parent_ids: [] }, { id: 'ge', slug: 'gives-evasion', parent_ids: [] }, { id: 'gf', slug: 'gives-flying', parent_ids: ['ge'] },
      { id: 'hate', slug: 'hate', parent_ids: [] }, { id: 'hg', slug: 'hate-graveyard', parent_ids: ['hate'] }, { id: 'hatt', slug: 'hate-attacker', parent_ids: ['hate'] },
      { id: 'rtg', slug: 'repeatable-token-generator', parent_ids: [] }, { id: 'rat', slug: 'repeatable-artifact-tokens', parent_ids: ['rtg'] }, { id: 'rnt', slug: 'repeatable-noncreature-tokens', parent_ids: [] }, { id: 'rt', slug: 'repeatable-treasures', parent_ids: ['rnt', 'rat'] },
      { id: 'burn', slug: 'burn', parent_ids: [] }, { id: 'bp', slug: 'burn-player', parent_ids: ['burn'] }, { id: 'mp', slug: 'mana-producer', parent_ids: [] }, { id: 'md', slug: 'mana-dork', parent_ids: ['mp'] },
      { id: 'sac', slug: 'sacrifice-outlet', parent_ids: [] }, { id: 'rso', slug: 'repeatable-sacrifice-outlet', parent_ids: ['sac'] }, { id: 'fso', slug: 'free-sacrifice-outlet', parent_ids: ['rso'] },
    ];
    const rr = resolveTagRoles(real);
    const R = (id) => rr.get(id)?.roles || [];
    check('real tags: cantrip (and its children) give no draw; repeatable-pure-draw does', !R('can').includes('draw') && !R('canc').includes('draw') && R('rpd').includes('draw') && R('pd').includes('draw'), [R('can'), R('canc'), R('rpd')]);
    check('real tags: force-draw gives no draw', !R('fd').includes('draw'), R('fd'));
    check('real tags: land tutors → ramp, never tutor (blocked through every parent)', ['tl', 'tlb', 'tlbf'].every((id) => R(id).includes('ramp') && !R(id).includes('tutor')) && R('th').includes('tutor') && R('tbf').includes('tutor'), [R('tlbf'), R('tlb')]);
    check('real tags: protects-self / ward / gains-* / regenerates-self are not protection', ['ps', 'ward', 'gi', 'rs'].every((id) => !R(id).includes('protection')) && R('dpc').includes('protection'), [R('ward'), R('dpc')]);
    check('real tags: *-self recursion is not recursion', ['rself', 'reans', 'regs'].every((id) => !R(id).includes('recursion')) && R('reanc').includes('recursion'), [R('reans'), R('reanc')]);
    check('real tags: sweeper subtree → wipe only', R('sw').join() === 'wipe' && R('sw1').join() === 'wipe' && R('spot').includes('removal') && !R('spot').includes('wipe'), [R('sw'), R('sw1')]);
    check('real tags: burn-creature/removal-fight = removal, not burn; burn-player = burn', R('bc').includes('removal') && !R('bc').includes('burn') && R('fight').includes('removal') && R('bp').includes('burn'), [R('bc'), R('fight')]);
    check('real tags: hate-counterspell no counter; counterspell child counts', !rr.has('hcs') && R('cssm').includes('counter'), [R('hcs')]);
    check('real tags: evasion alone nothing; gives-evasion subtree → evasion', !rr.has('ev') && R('gf').includes('evasion'), [R('ev'), R('gf')]);
    check('real tags: only hate-graveyard is gy-hate', R('hg').includes('gy-hate') && !rr.has('hatt') && !rr.has('hate'), [R('hatt')]);
    check('real tags: treasures → ramp + tokens; disenchant → removal; mana-dork → ramp (mana-producer alone not)', R('rt').includes('ramp') && R('rt').includes('tokens') && R('dn').includes('removal') && R('md').includes('ramp') && !rr.has('mp'), [R('rt'), R('md')]);
    check('real tags: sac outlets inherit', R('fso').includes('sac-outlet'), R('fso'));
    check('text: cantrip / force-draw / self-recursion / self-evasion excluded', !textRoles('Scry 1.\nDraw a card.', 'Instant', 'Opt').includes('draw') && !textRoles('Target player draws two cards.', 'Sorcery').includes('draw') && textRoles('Draw two cards.', 'Sorcery').includes('draw') && !textRoles("You may cast Gravecrawler from your graveyard as long as you control a Zombie.", 'Creature — Zombie', 'Gravecrawler').includes('recursion') && !textRoles('Flashback {2}{U} (You may cast this card from your graveyard for its flashback cost. Then exile it.)', 'Sorcery').includes('recursion') && !textRoles("This creature can't be blocked.", 'Creature').includes('evasion') && textRoles("Target creature can't be blocked this turn.", 'Instant').includes('evasion'));
    check('text: basic-land search (even to hand) = ramp, not tutor', textRoles('Search your library for a basic land card, reveal it, put it into your hand, then shuffle.', 'Sorcery').join() === 'ramp' && textRoles('Search your library for a basic Forest card, put it onto the battlefield.', 'Sorcery').join() === 'ramp' && textRoles('Search your library for a creature card, reveal it, put it into your hand.', 'Sorcery').includes('tutor'));
    check('text: self "can\'t be the target" is not protection', !textRoles("This creature can't be the target of spells or abilities your opponents control.", 'Creature').includes('protection') && textRoles("Creatures you control can't be the targets of spells or abilities your opponents control.", 'Enchantment').includes('protection'));
    check('text heuristics', textRoles('Destroy all creatures.', 'Sorcery').includes('wipe') && textRoles('Counter target spell.', 'Instant').includes('counter') && textRoles('{T}: Add {G}.', 'Basic Land — Forest').length === 0);
    check('pips: hybrid half, phyrexian full', pips('{2}{G}{G}').G === 2 && pips('{W/U}').W === 0.5 && pips('{G/P}').G === 1);
    check('produced colors', producedColors({ text: '{T}: Add {R} or {G}.', typeLine: 'Land' }).join('') === 'RG' && producedColors({ text: '', typeLine: 'Basic Land — Forest' }).join('') === 'G');
    check('ETB tapped detection', etbTapped('This land enters tapped.') === 'tapped' && etbTapped("As this enters, you may pay 3 life. If you don't, it enters tapped.") === 'conditional' && etbTapped('{T}: Add {G}.') === null);
  }

  // ---------------- cache job (auto-start disabled) ----------------
  console.log('\n# Card cache (manual job, auto-start disabled)');
  await reset();
  const h1 = tmp('cache');
  const p1 = new McpProc(baseEnv({ ...creds, ARCHIDEKT_HOME: h1 }));
  try {
    await p1.init();
    await sleep(500);
    let r = await p1.call('cards_cache_status');
    check('status before update: idle, no meta', r.json?.job?.running === false && r.json?.meta === null && r.json?.fresh === false, r.text);
    check('ARCHIDEKT_NO_AUTO_CACHE=1 → no Scryfall traffic on start', !(await extLog()).some((x) => x.path.startsWith('/scryfall')));
    r = await p1.call('card_search_local', { roles: ['ramp'] });
    check('card_search_local without cache → clear error', r.isError && /cards_cache_update/.test(r.text), r.text);

    await ext.setFlags({ slowMs: 400, next429: true });
    const t0 = Date.now();
    r = await p1.call('cards_cache_update', {});
    check('cards_cache_update returns immediately with "iniciado"', r.json?.status === 'iniciado' && r.json.started === true && Date.now() - t0 < 2000, r.text);
    r = await p1.call('cards_cache_status');
    check('status shows running job with step', r.json?.job?.running === true && typeof r.json.job.step === 'string', r.text);
    r = await p1.call('cards_cache_update', {});
    check('second update while running → "em andamento"', r.json?.started === false && /andamento/.test(r.json?.status), r.text);
    await ext.setFlags({ slowMs: 0 });
    const st = await waitJob(p1);
    check('job finishes without errors', st?.meta?.errors?.length === 0 && st.job.step === 'done', st);
    check('Scryfall 429 → backs off and retries once', (await extLog()).filter((x) => x.path === '/scryfall/bulk-data').length === 2);
    check('cache counts (32 paper cards: digital + token skipped)', st?.meta?.counts?.cards === 32, st?.meta?.counts);
    check('cache counts PT names + tags', st?.meta?.counts?.ptNames >= 10 && st.meta.counts.cardsTagged >= 10 && st.meta.counts.enWithPt >= 9, st?.meta?.counts);
    check('progress recorded PT pages', st?.job?.progress?.ptPages === 3, st?.job);
    const dataDir = path.join(h1, 'data');
    check('cache files written under ARCHIDEKT_HOME/data', ['cards.json', 'pt-names.json', 'cache-meta.json'].every((f) => fs.existsSync(path.join(dataDir, f))));
    check('no leftover temp files (atomic writes)', !listFiles(h1).some((f) => f.endsWith('.tmp')), listFiles(h1));
    const cj = JSON.parse(fs.readFileSync(path.join(dataDir, 'cards.json'), 'utf8')).cards;
    const card = (n) => cj.find((c) => c.name === n);
    check('compact record fields', ['oid', 'name', 'mv', 'cost', 'type', 'text', 'colors', 'ci', 'kw', 'legal', 'gc', 'rank', 'usd', 'roles'].every((k) => k in card('Sol Ring')), card('Sol Ring'));
    check('roles from tag + child tag + grandchild', card('Lightning Bolt').roles.includes('removal') && card('Sol Ring').roles.includes('ramp') && card('Blasphemous Act').roles.includes('wipe'), [card('Lightning Bolt'), card('Blasphemous Act')]);
    check('raw tags kept short', card('Lightning Bolt').tags.length <= 8 && card('Lightning Bolt').tags.includes('burn-creature'), card('Lightning Bolt').tags);
    check('non-whitelisted tags ignored', !card('Colossal Dreadmaw').tags && card('Colossal Dreadmaw').roles.length === 0, card('Colossal Dreadmaw'));
    const has = (n, r) => !!card(n)?.roles?.includes(r);
    check('real tags: removal root empty, roles flow from descendants', has('Beast Within', 'removal') && has('Lightning Bolt', 'removal') && has('Lightning Bolt', 'burn') && has('Demonic Tutor', 'tutor') && has('Eternal Witness', 'recursion') && has('Heroic Intervention', 'protection') && has('Omnath, Locus of Rage', 'tokens'), cj.filter((c) => ['Beast Within', 'Demonic Tutor', 'Eternal Witness', 'Heroic Intervention'].includes(c.name)));
    check('rule: cantrip / force-draw give no draw; draw-engine does', !has('Opt', 'draw') && !has('Howling Mine', 'draw') && !has('Relic of Progenitus', 'draw') && has('The One Ring', 'draw'), [card('Opt'), card('Howling Mine'), card('Relic of Progenitus')]);
    check('rule: land tutors are ramp, not tutor (incl. tutor-land-to-battlefield)', ['Rampant Growth', 'Cultivate', "Kodama's Reach"].every((n) => has(n, 'ramp') && !has(n, 'tutor')), [card('Cultivate')]);
    check('rule: protects-self subtree is not protection', !has('Darksteel Myr', 'protection'), card('Darksteel Myr'));
    check('rule: self-recursion is not recursion', !has('Gravecrawler', 'recursion'), card('Gravecrawler'));
    check('rule: sweeper → wipe, not single-target removal', has('Blasphemous Act', 'wipe') && !has('Blasphemous Act', 'removal'), card('Blasphemous Act'));
    check('rule: hate-counterspell is not a counter; hate-artifact is not gy-hate', !has('Destiny Spinner', 'counter') && has('Counterspell', 'counter') && !has('Beast Within', 'gy-hate') && has('Scavenging Ooze', 'gy-hate'), [card('Destiny Spinner'), card('Beast Within')]);
    check('rule: "evasion" tag alone (own flying) gives no evasion role', !has("Atraxa, Praetors' Voice", 'evasion'), card("Atraxa, Praetors' Voice"));
    check('rule: one-shot tokens from text (no token-generator root); opponent token is not ours', has('Avenger of Zendikar', 'tokens') && !has('Beast Within', 'tokens'), card('Avenger of Zendikar'));
    check('rule: mana-producer tag alone is not ramp (basic lands)', !has('Forest', 'ramp') && !has('Temple of Abandon', 'ramp'), card('Forest'));
    check('DFC: faces + joined text', card('Valakut Awakening // Valakut Stoneforge')?.faces?.length === 2 && /\/\//.test(card('Valakut Awakening // Valakut Stoneforge').text), card('Valakut Awakening // Valakut Stoneforge'));
    check('digital-only and token layouts skipped', !card('Digital Only Thing') && !card('Beast'));
    check('legality, game changer, rank kept', card('Mana Crypt').legal === 'banned' && card('The One Ring').gc === true && card('Sol Ring').rank === 1);
    const ptj = JSON.parse(fs.readFileSync(path.join(dataDir, 'pt-names.json'), 'utf8'));
    check('pt-names: PT → EN and most common EN → PT', ptj.pt['anel solar'] === 'Sol Ring' && ptj.en['Lightning Bolt'] === 'Relâmpago' && ptj.pt['raio'] === 'Lightning Bolt', ptj.en);
    check('pt-names: DFC face printed names', ptj.pt['despertar de valakut'] === 'Valakut Awakening // Valakut Stoneforge');
    check('Scryfall requests use honest UA', (await extLog()).filter((x) => x.path.startsWith('/scryfall')).every((x) => x.ua === 'archidekt-commander-mcp/0.7'));
    r = await p1.call('cards_cache_update', {});
    check('fresh cache → "já atualizado em <data>"', r.json?.started === false && /já atualizado em \d{4}-/.test(r.json?.status), r.text);

    // ---- translation ----
    r = await p1.call('card_translate', { names: ['Anel Solar', 'RELAMPAGO', 'sol rign', 'Despertar de Valakut', 'Raio Lunar', 'Xyzzy Nada Qwerty'] });
    const tx = r.json?.results || [];
    check('translate PT exact (cache)', tx[0]?.en === 'Sol Ring' && tx[0].source === 'cache' && tx[0].confidence === 1, tx[0]);
    check('translate accent/case-insensitive', tx[1]?.en === 'Lightning Bolt' && tx[1].pt === 'Relâmpago', tx[1]);
    check('translate typo → close match', tx[2]?.en === 'Sol Ring' && tx[2].how === 'close' && tx[2].confidence < 1, tx[2]);
    check('translate DFC face', tx[3]?.en === 'Valakut Awakening // Valakut Stoneforge', tx[3]);
    check('translate falls back to LigaMagic', tx[4]?.en === 'Moonlight Bolt' && tx[4].source === 'ligamagic', tx[4]);
    check('unresolved names reported', r.json?.unresolved?.includes('Xyzzy Nada Qwerty') && tx[5]?.unresolved === true, r.json);
    r = await p1.call('card_translate', { names: ['Sol Ring', 'Cultivate'], to: 'pt' });
    check('translate EN → PT', r.json?.results?.[0]?.result === 'Anel Solar' && r.json.results[1].result === 'Cultivar', r.text);
    r = await p1.call('card_translate', { names: [] });
    check('translate empty list → error', r.isError, r.text);

    // ---- lookup & local search ----
    r = await p1.call('card_lookup', { name: 'Fera Interior' });
    check('card_lookup PT name → full cached info', r.json?.name === 'Beast Within' && r.json.pt === 'Fera Interior' && r.json.roles.includes('removal') && r.json.legal === 'legal' && r.json.source === 'cache' && r.json.translation?.en === 'Beast Within', r.text);
    check('card_lookup → ligamagicUrl (card page, EN name)', /\?view=cards\/card&card=Beast%20Within$/.test(r.json?.ligamagicUrl || ''), r.json?.ligamagicUrl);
    r = await p1.call('card_lookup', { name: 'Sol Ring' });
    check('card_lookup EN: ci C, rank, gc', r.json?.ci === 'C' && r.json.rank === 1 && r.json.gc === false, r.text);
    r = await p1.call('card_lookup', { name: 'Nonexistent Card Zzzq' });
    check('card_lookup unknown → error', r.isError && /não encontrada/.test(r.text), r.text);
    r = await p1.call('card_search_local', { roles: ['ramp'], colorIdentity: 'G', maxMv: 3 });
    const rampNames = r.json?.cards?.map((c) => c.name) || [];
    check('search: green ramp ≤ 3 MV sorted by EDHREC rank', rampNames[0] === 'Sol Ring' && ['Rampant Growth', 'Cultivate', 'Lotus Cobra', "Kodama's Reach"].every((n) => rampNames.includes(n)) && !rampNames.includes('Mana Crypt'), rampNames);
    r = await p1.call('card_search_local', { roles: ['remoção'], colorIdentity: 'RG' });
    const remNames = r.json?.cards?.map((c) => c.name) || [];
    check('search: PT role alias + identity subset', remNames.includes('Lightning Bolt') && remNames.includes('Beast Within') && !remNames.includes('Counterspell'), remNames);
    r = await p1.call('card_search_local', { text: 'graveyard', type: 'criatura', colorIdentity: 'G' });
    check('search: text + PT type alias', r.json?.cards?.some((c) => c.name === 'Scavenging Ooze') && r.json.cards.every((c) => /Creature/.test(c.type)), r.text);
    r = await p1.call('card_search_local', { roles: ['ramp'], commanderLegal: false, excludeNames: ['Sol Ring'], sort: 'mv', limit: 2 });
    check('search: banned allowed when commanderLegal=false, exclude, limit, sort mv', r.json?.cards?.[0]?.name === 'Mana Crypt' && r.json.shown === 2 && !r.json.cards.some((c) => c.name === 'Sol Ring'), r.text);
    r = await p1.call('card_search_local', { roles: ['dragões'] });
    check('search: unknown role → error', r.isError && /Papel desconhecido/.test(r.text), r.text);

    // ---- prices ----
    let n0 = (await extLog()).filter((x) => x.path.startsWith('/liga')).length;
    r = await p1.call('card_price_br', { names: ['Anel Solar', 'Cultivate', 'Toph, the First Metalbender', 'Relâmpago', 'Unknown Card Qwe'] });
    const pr = r.json?.results || [];
    check('price: aggregate row, thousands format', pr[0]?.en === 'Sol Ring' && pr[0].pt === 'Anel Solar' && pr[0].min === 7.09 && pr[0].avg === 67.83 && pr[0].max === 7499, pr[0]);
    check('price: Art Card rows skipped, variants sorted (≤5)', pr[0]?.variants?.length === 2 && pr[0].variants.every((v) => !/art card/i.test(v.variant)) && pr[0].variants[0].variant === '#249' && pr[0].variants[1].min === 12, pr[0]?.variants);
    check('price: url + fetchedAt + source', /\/liga\/\?view=cards\/card/.test(pr[0]?.url) && !Number.isNaN(Date.parse(pr[0]?.fetchedAt)) && pr[0].source === 'LigaMagic', pr[0]);
    check('price: every result has ligamagicUrl (card page, also not-found)', pr.length === 5 && pr.every((x) => /\?view=cards\/card&card=/.test(x.ligamagicUrl || '')) && /card=Sol%20Ring$/.test(pr[0].ligamagicUrl), pr.map((x) => x.ligamagicUrl));
    check('price: EN input', pr[1]?.min === 2.49 && pr[1].avg === 13.01 && pr[1].max === 149.4, pr[1]);
    check('price: card without PT name (no mtg-name-aux)', pr[2]?.en === 'Toph, the First Metalbender' && pr[2].pt === null && pr[2].min === 12.35 && pr[2].variants.length === 1, pr[2]);
    check('price: R$ 0,00 → null', pr[3]?.min === null && pr[3].avg === 3.5, pr[3]);
    check('price: not found reported', pr[4]?.found === false, pr[4]);
    check('price: totalBRL sums min/avg', r.json?.totalBRL?.min === 21.93 && r.json.totalBRL.avg === 122.5 && r.json.totalBRL.incomplete === true, r.json?.totalBRL);
    let n1 = (await extLog()).filter((x) => x.path.startsWith('/liga')).length;
    r = await p1.call('card_price_br', { names: ['Sol Ring'] });
    const n2 = (await extLog()).filter((x) => x.path.startsWith('/liga')).length;
    check('price: 24 h disk cache hit (no new request)', r.json?.results?.[0]?.cached === true && n2 === n1 && fs.existsSync(path.join(dataDir, 'ligamagic-prices.json')), { n0, n1, n2, t: r.text });
    check('price: single card has no totalBRL', r.json && !('totalBRL' in r.json));
    r = await p1.call('card_price_br', { names: ['Blocked Card', 'Cultivar Nope'] });
    check('price: 403/Cloudflare → clear blocked message, rest skipped', /bloqueou/.test(r.json?.blocked || '') && /bloqueou/.test(r.json.results[0].error) && /não consultado/.test(r.json.results[1].error), r.text);
    const n3 = (await extLog()).filter((x) => x.path.startsWith('/liga')).length;
    r = await p1.call('card_price_br', { names: ['Captcha Card'] });
    const n4 = (await extLog()).filter((x) => x.path.startsWith('/liga')).length;
    check('price: captcha page (200) detected as blocked, no retry loop', /bloqueou/.test(r.json?.blocked || '') && n4 - n3 === 1, { r: r.text, n3, n4 });
    r = await p1.call('card_price_br', { names: Array.from({ length: 31 }, (_, i) => `Card ${i}`) });
    check('price: >30 names → error', r.isError && /30/.test(r.text), r.text);

    // ---- wiki ----
    r = await p1.call('wiki_list');
    check('wiki_list creates README + deck template', r.json?.pages?.some((x) => x.page === 'README') && r.json.pages.some((x) => x.page === '_templates/deck'), r.text);
    const tpl = fs.readFileSync(path.join(h1, 'wiki', '_templates', 'deck.md'), 'utf8');
    check('deck template sections', ['Plano de vitória', 'Bracket', 'Peças-chave', 'Histórico de mudanças', 'Partidas', 'Pontos fracos conhecidos'].every((x) => tpl.includes(x)));
    r = await p1.call('wiki_write', { page: 'decks/omnath-analise', content: '# Omnath Análise\n\n## Plano de vitória\nLandfall + Elementais.', mode: 'replace' });
    check('wiki_write create', r.json?.created === true && r.json.page === 'decks/omnath-analise', r.text);
    r = await p1.call('wiki_write', { page: 'Decks/Omnath-Analise.md', content: '| 2026-10-11 | -Dreadmaw +Bolt | curva |', mode: 'append' });
    check('wiki_write append (case + .md normalized)', r.json?.created === false && r.json.page === 'decks/omnath-analise', r.text);
    r = await p1.call('wiki_read', { page: 'decks/omnath-analise' });
    check('wiki_read content', r.json?.content?.includes('Landfall + Elementais') && r.json.content.includes('+Bolt'), r.text);
    r = await p1.call('wiki_write', { page: 'meta/grupo', content: 'Amigo joga Mono-Black ARISTOCRATS e Voltron.', mode: 'append' });
    r = await p1.call('wiki_search', { query: 'aristócrats' });
    check('wiki_search accent/case-insensitive with line numbers', r.json?.results?.find((x) => x.page === 'meta/grupo')?.matches?.[0]?.line === 1, r.text);
    const bad = ['../segredo', '..\\segredo', '/etc/passwd', 'C:/Windows/x', 'decks/../../x', 'a/b/c/d', 'decks/fo?o', 'con', 'decks//x', '~/x', '.', 'decks/.hidden'];
    let allRejected = true;
    for (const page of bad) {
      const w = await p1.call('wiki_write', { page, content: 'x', mode: 'replace' });
      if (!w.isError) allRejected = false;
    }
    check('wiki path traversal / invalid names rejected', allRejected);
    check('nothing written outside wiki/', !fs.existsSync(path.join(h1, 'segredo.md')) && !fs.existsSync(path.join(path.dirname(h1), 'x.md')) && listFiles(path.join(h1, 'wiki')).every((f) => f.endsWith('.md')));
    r = await p1.call('wiki_write', { page: 'cartas/grande', content: 'x'.repeat(205 * 1024), mode: 'replace' });
    check('wiki 200 KB limit', r.isError && /200 KB/.test(r.text), r.text);
    r = await p1.call('wiki_write', { page: 'cartas/x', content: 'x', mode: 'merge' });
    check('wiki invalid mode → error', r.isError, r.text);
    r = await p1.call('wiki_read', { page: 'decks/nao-existe' });
    check('wiki_read missing page → error', r.isError && /não existe/.test(r.text), r.text);

    // ---- analysis ----
    n0 = (await extLog()).filter((x) => x.path.startsWith('/edhrec')).length;
    r = await p1.call('deck_analyze', { deckId: 1003, targetBracket: 2 });
    const a = r.json || {};
    check('analyze: diagnosis lines (PT-BR) + freshness note', Array.isArray(a.diagnosis) && a.diagnosis.length >= 5 && /nota geral/.test(a.diagnosis[0]) && /Simulação/.test(a.diagnosis[2]) && /Calculado agora/.test(a.freshness || ''), a.diagnosis);
    check('analyze: role counts (oTags + cache + text)', a.roles?.ramp?.count === 4 && a.roles.removal.cards.includes('Beast Within') && a.roles.wipe.cards.includes('Blasphemous Act') && a.roles.recursion.cards.includes('Eternal Witness'), a.roles);
    check('analyze: role status vs target', a.roles?.ramp?.status === 'baixo' && a.roles.ramp.target === '10-12', a.roles?.ramp);
    check('analyze: mana (lands, tapped, curve, pips/sources)', a.mana?.lands === 36 && a.mana.tappedLands.includes('Temple of Abandon') && a.mana.curve['7+'] >= 1 && a.mana.sources.G >= 31 && a.mana.pips.G > 0, a.mana);
    check('analyze: GC + combos + bracket estimate', a.power?.gameChangers?.includes('The One Ring') && a.power.combos.length === 1 && a.power.estimatedBracket >= 3, a.power);
    check('analyze: bracket issue for target 2', a.issues?.some((i) => i.area === 'bracket'), a.issues);
    check('analyze: issues sorted by impact', a.issues?.every((x, i, arr) => i === 0 || arr[i - 1].impact >= x.impact), a.issues);
    check('analyze: no playgroup/opponent meta check (focus is the deck itself)', !('meta' in a) && !a.issues?.some((i) => i.area === 'meta' || /voltron|aristocrat/i.test(i.problem + i.fix)), a.issues);
    check('analyze: fluidity report (early plays, top end, color requirements, odds)', a.fluidity && typeof a.fluidity.earlyPlays.count === 'number' && Array.isArray(a.fluidity.colorRequirements) && a.fluidity.odds.earlyPlayByT2 >= 0, a.fluidity);
    check('analyze: EDHREC reference + type mix', a.edhrec?.found === true && a.edhrec.numDecks === 5000 && a.typeMix?.edhrec?.creature === 30 && a.reference?.edhrec?.decks === 5000, a.edhrec);
    check('analyze: simulation of the current deck (2000 games)', a.simulation?.games === 2000 && typeof a.simulation.score === 'number' && typeof a.simulation.outOfGasT6Pct === 'number', a.simulation);
    check('analyze: scorecard with 7 areas graded 0–10 + overall', a.scorecard?.areas?.length === 7 && a.scorecard.areas.every((x) => x.grade >= 0 && x.grade <= 10 && typeof x.key === 'string') && a.scorecard.overall >= 0 && a.scorecard.overall <= 10, a.scorecard);
    check('analyze: plan engine (landfall enablers × payoffs, closers, draw engines)', a.plan?.themes?.some((t) => t.theme === 'landfall' && t.payoffs >= 1 && t.enablers >= 1) && typeof a.plan.closers.count === 'number' && typeof a.plan.rampToGas.ramp === 'number', a.plan);
    const all = Object.fromEntries((a.cards?.all || []).map((l) => { const m = /^(.*) (\d+) \((.*)\)$/.exec(l); return m ? [m[1], { value: Number(m[2]), verdict: m[3] }] : [l, null]; }));
    check('analyze: every nonland card valued by the own model (0–100 + verdict), commander excluded', Object.keys(all).length > 5 && Object.values(all).every((c) => c && c.value >= 0 && c.value <= 100 && c.verdict) && !all['Omnath, Locus of Rage'], a.cards?.all?.slice(0, 3));
    check('analyze: Dreadmaw valued below Lotus Cobra', all['Colossal Dreadmaw']?.value < all['Lotus Cobra']?.value, [all['Colossal Dreadmaw'], all['Lotus Cobra']]);
    check('analyze: GC flagged for bracket 2 (weakest list explains why)', (a.cards?.weakest || []).some((c) => c.name === 'The One Ring' && /Game Changer/.test(c.why)), a.cards?.weakest);
    check('analyze: weakest/strongest lists with LigaMagic links', a.cards?.weakest?.length > 0 && a.cards.strongest.length > 0 && a.cards.weakest.every((c) => /view=cards\/card/.test(c.ligamagicUrl)), a.cards?.weakest?.[0]);
    const opts = a.options || [];
    const optIns = opts.flatMap((o) => o.swaps.map((s) => s.in.name));
    check('analyze: improvement options (ranked, each with swaps, effect and apply)', opts.length >= 1 && opts.every((o, i) => o.rank === i + 1 && o.title && o.problem && o.swaps.length >= 1 && o.swaps.length <= 4 && o.effect?.simulation?.score && Array.isArray(o.apply?.swaps) && o.apply.confirm === true && o.apply.swaps.length === o.swaps.length), opts.map((o) => [o.id, o.swaps.length]));
    check('analyze: options stay inside the color identity, legal and bracket-safe (no Counterspell/Demonic Tutor/Mana Crypt/GC)', optIns.length > 0 && !optIns.some((n) => ['Counterspell', 'Demonic Tutor', 'Mana Crypt', 'The One Ring'].includes(n)), optIns);
    check('analyze: option swaps explain out/in and link LigaMagic', opts.every((o) => o.swaps.every((s) => /sai .* entra /.test(s.why) && /view=cards\/card/.test(s.in.ligamagicUrl) && /view=cards\/card/.test(s.out.ligamagicUrl))), opts[0]?.swaps?.[0]);
    check('analyze: no notes from earlier sessions (wiki is not read)', !('wikiPage' in a), Object.keys(a));
    check('analyze: internals stripped', !('_scored' in a) && !('_landTarget' in a));
    check('analyze: deck NOT changed', mockState.decks.get(1003).cards.some((c) => c.card.oracleCard.name === 'The One Ring'));
    r = await p1.call('deck_analyze', { deckId: 1003, lock: ['Colossal Dreadmaw'], exclude: optIns.slice(0, 1) });
    n1 = (await extLog()).filter((x) => x.path.startsWith('/edhrec')).length;
    check('analyze: lock/exclude respected in the options', !(r.json?.options || []).some((o) => o.swaps.some((s) => s.out.name === 'Colossal Dreadmaw' || s.in.name === optIns[0])), r.json?.options?.map((o) => o.swaps.map((s) => `${s.out.name}>${s.in.name}`)));
    const commanderHits = (await extLog()).filter((x) => x.path === '/edhrec/pages/commanders/omnath-locus-of-rage.json').length;
    check('EDHREC commander pages always live: the second analysis fetches them again, none stored on disk', commanderHits >= 2 && n1 > n0 && !fs.existsSync(path.join(dataDir, 'edhrec', 'omnath-locus-of-rage.json')), { n0, n1, commanderHits });
    r = await p1.call('deck_analyze', { deckId: 1003, targetBracket: 4 });
    check('analyze with a high target bracket: no bracket issue', !r.json?.issues?.some((i) => i.area === 'bracket'), r.json?.issues);
    r = await p1.call('deck_analyze', { deckId: 2001 });
    check('analyze: EDHREC 404 handled gracefully', r.json?.edhrec?.found === false && Array.isArray(r.json.cards?.all), r.text.slice(0, 400));
    r = await p1.call('deck_analyze', { deckId: 2001 });
    const n404 = (await extLog()).filter((x) => x.path.includes('atraxa')).length;
    check('EDHREC 404 is not cached either (asked again on the next analysis)', n404 >= 2, n404);
    r = await p1.call('deck_analyze', { deckId: 999999 });
    check('analyze: missing deck → error', r.isError && /404/.test(r.text), r.text);
    r = await p1.call('deck_analyze', { deckId: 1003, targetBracket: 9 });
    check('analyze: bad targetBracket → error', r.isError, r.text);

    r = await p1.call('deck_cut_candidates', { deckId: 1003, count: 3 });
    const cuts = r.json?.cuts || [];
    check('cuts: lowest score first, Dreadmaw included', cuts.length >= 1 && cuts.some((c) => c.name === 'Colossal Dreadmaw') && cuts.every((c, i) => i === 0 || cuts[i - 1].score <= c.score), cuts);
    check('cuts: commander and under-target roles protected', !cuts.some((c) => /Omnath|Sol Ring|Lotus Cobra|Cultivate|Rampant Growth/.test(c.name)) && r.json.protectedRoles.some((p) => p.startsWith('ramp')), r.json);
    check('cuts: no lands when lands are not in surplus', !cuts.some((c) => /Forest|Mountain|Temple/.test(c.name)), cuts);
    check('cuts: weak protected cards listed separately with warning', (r.json?.alsoConsider || []).every((c) => /abaixo da meta/.test(c.warning)), r.json?.alsoConsider);

    let nArch = mockState.log.length;
    r = await p1.call('deck_upgrade_candidates', { deckId: 1003, count: 6, targetBracket: 2 });
    const up = r.json?.candidates || [];
    const upNames = up.map((c) => c.name);
    check('upgrades: owned first (Lightning Bolt owned)', up[0]?.name === 'Lightning Bolt' && up[0].owned > 0, up.slice(0, 3));
    check('upgrades: off-identity, banned and in-deck cards excluded', !upNames.includes('Demonic Tutor') && !upNames.includes('Mana Crypt') && !upNames.includes('Sol Ring') && !upNames.includes('Lotus Cobra'), upNames);
    check('upgrades: EDHREC + cache sources, fills gaps, replacement cut', up.some((c) => c.sources.some((x) => /EDHREC/.test(x))) && up.some((c) => c.fills.length) && up.some((c) => c.replaces?.name), up);
    check('upgrades: LigaMagic price attached', up.find((c) => c.name === 'Lightning Bolt')?.priceBRL?.avg === 3.5 && r.json.source === 'preços: LigaMagic', up[0]);
    check('upgrades: collection checked via Archidekt', mockState.log.slice(nArch).some((x) => x.path.startsWith('/collection/')), mockState.log.slice(nArch).map((x) => x.path));
    check('upgrades: PT names included', up.find((c) => c.name === 'Lightning Bolt')?.pt === 'Relâmpago', up[0]);
    r = await p1.call('deck_upgrade_candidates', { deckId: 1003, role: 'gy-hate', withPrices: false });
    const gy = r.json?.candidates?.map((c) => c.name) || [];
    check('upgrades: role focus (gy-hate)', gy.includes('Scavenging Ooze') && gy.includes('Relic of Progenitus') && r.json.candidates.every((c) => c.roles.includes('gy-hate')) && !('priceBRL' in (r.json.candidates[0] || {})), r.text);
    r = await p1.call('deck_upgrade_candidates', { deckId: 1003, ownedOnly: true, withPrices: false });
    check('upgrades: ownedOnly', r.json?.candidates?.length >= 1 && r.json.candidates.every((c) => c.owned > 0), r.text);
    r = await p1.call('deck_upgrade_candidates', { deckId: 1003, role: 'nada' });
    check('upgrades: bad role → error', r.isError, r.text);

    // ---- PT names in writes ----
    r = await p1.call('archidekt_update_deck_cards', {
      deckId: 1003,
      changes: [
        { action: 'add', cardName: 'Relâmpago', category: 'Removal' },
        { action: 'remove', cardName: 'Testemunha Eterna' },
        { action: 'add', cardName: 'Alcance de Kodama', category: 'Ramp' },
        { action: 'add', cardName: 'Mountain' },
        { action: 'set_quantity', cardName: 'Floresta', quantity: 29 },
      ],
    });
    const u = r.json || {};
    check('update_deck_cards with PT names verified', u.verification === 'verified' && u.applied?.length === 5, r.text);
    check('translations reported', u.translations?.length === 4 && u.translations.some((t) => t.input === 'Relâmpago' && t.en === 'Lightning Bolt') && u.translations.some((t) => t.input === 'Testemunha Eterna'), u.translations);
    check('5 changes: no snapshot on disk, undo returned', !('snapshot' in u) && !fs.existsSync(path.join(dataDir, 'snapshots')) && u.undo?.some((x) => x.action === 'remove' && x.cardName === 'Lightning Bolt') && u.undo.some((x) => x.action === 'add' && x.cardName === 'Eternal Witness'), u.undo);
    r = await p1.call('archidekt_update_deck_cards', { deckId: 1003, changes: [{ action: 'remove', cardName: 'Relampago' }] });
    check('small batch: PT remove works', u && r.json?.verification === 'verified' && !r.json.snapshot && r.json.translations?.[0]?.en === 'Lightning Bolt', r.text);

    r = await p1.call('archidekt_search_collection', { cardNames: ['Anel Solar', 'Sol Ring'] });
    check('search_collection accepts PT names', r.json?.results?.[0]?.name === 'Sol Ring' && r.json.results[0].totalOwned === r.json.results[1].totalOwned && r.json.results[0].translation?.input === 'Anel Solar', r.text);
    r = await p1.call('archidekt_search_cards', { name: 'Anel Solar' });
    check('search_cards accepts PT names', r.json?.count === 2 && r.json.translation?.en === 'Sol Ring', r.text);
    r = await p1.call('archidekt_collection_add', { cardName: 'Cultivar', quantity: 1 });
    check('collection_add accepts PT names', r.json?.verification === 'verified' && r.json.added.name === 'Cultivate' && r.json.translation?.input === 'Cultivar', r.text);
    r = await p1.call('archidekt_create_deck', { name: 'Teste PT', commander: 'Omnath, Locus of Rage' });
    check('create_deck still works (EN commander)', r.json?.verification === 'verified', r.text);
    if (r.json?.deckId) await p1.call('archidekt_delete_deck', { deckId: r.json.deckId, confirm: true });
    check('stdout clean in phase 2', p1.badLines.length === 0, p1.badLines);
  } finally {
    await p1.close();
  }

  // ---------------- auto-start enabled ----------------
  console.log('\n# Card cache auto-start');
  await reset();
  {
    const h2 = tmp('auto');
    const env = baseEnv({ ARCHIDEKT_HOME: h2 });
    delete env.ARCHIDEKT_NO_AUTO_CACHE;
    const p2 = new McpProc(env);
    try {
      const t0 = Date.now();
      await p2.init();
      check('initialize not blocked by cache job', Date.now() - t0 < 3000);
      await sleep(400);
      const st = await waitJob(p2);
      check('auto-start builds the cache on first run', st?.meta?.counts?.cards === 32 && /started \(auto/.test(p2.stderr), { st, err: p2.stderr.slice(-400) });
      check('auto-start logs only to stderr', p2.badLines.length === 0);
    } finally {
      await p2.close();
    }
    // a fresh cache is not rebuilt on next start
    await reset();
    const p2b = new McpProc(env);
    try {
      await p2b.init();
      await sleep(600);
      check('fresh cache → no rebuild on restart', !(await extLog()).some((x) => x.path === '/scryfall/bulk-data') && !/started \(auto/.test(p2b.stderr), p2b.stderr);
    } finally {
      await p2b.close();
    }
  }

  // ---------------- partial failure + legacy bulk format ----------------
  console.log('\n# Card cache partial failure');
  await reset();
  {
    const h3 = tmp('partial');
    await ext.setFlags({ legacyBulk: true, failPtPage: 2 });
    const p3 = new McpProc(baseEnv({ ARCHIDEKT_HOME: h3 }));
    try {
      await p3.init();
      await p3.call('cards_cache_update', { force: true });
      const st = await waitJob(p3);
      check('legacy download_uri (plain JSON array) parsed', st?.meta?.counts?.cards === 32 && st.meta.counts.cardsTagged >= 10, st?.meta);
      check('PT step failure recorded, cards kept', st?.meta?.errors?.some((e) => /pt-names/.test(e)) && fs.existsSync(path.join(h3, 'data', 'cards.json')), st?.meta?.errors);
      const ptj = JSON.parse(fs.readFileSync(path.join(h3, 'data', 'pt-names.json'), 'utf8'));
      check('partial PT names saved (page 1)', ptj.partial === true && ptj.pt['anel solar'] === 'Sol Ring' && !ptj.pt['relampago'], ptj);
      const r = await p3.call('cards_cache_status');
      check('status exposes errors and sizes', r.json?.meta?.errors?.length === 1 && typeof r.json.sizesMB.cards === 'number', r.text);
    } finally {
      await p3.close();
    }
    await reset();
    const h4 = tmp('down');
    await ext.setFlags({ bulkDown: true });
    const p4 = new McpProc(baseEnv({ ARCHIDEKT_HOME: h4 }));
    try {
      await p4.init();
      await p4.call('cards_cache_update', {});
      const st = await waitJob(p4);
      check('bulk-data down: error recorded, no cards.json, updatedAt null', st?.meta?.errors?.some((e) => /bulk-data/.test(e)) && !fs.existsSync(path.join(h4, 'data', 'cards.json')) && st.meta.updatedAt === null, st?.meta);
      const r = await p4.call('cards_cache_update', {});
      check('failed cache is not "fresh" → can retry', r.json?.started === true, r.text);
      await waitJob(p4);
    } finally {
      await p4.close();
    }
  }

  // ---------------- no cache: remote fallbacks ----------------
  console.log('\n# No cache: remote fallbacks');
  await reset();
  {
    const h5 = tmp('nocache');
    const p5 = new McpProc(baseEnv({ ...creds, ARCHIDEKT_HOME: h5 }));
    try {
      await p5.init();
      let r = await p5.call('card_lookup', { name: 'Anel Solar' });
      check('card_lookup without cache → Scryfall fallback with PT', r.json?.name === 'Sol Ring' && r.json.source === 'scryfall' && r.json.pt === 'Anel Solar' && r.json.roles.includes('ramp'), r.text);
      r = await p5.call('card_translate', { names: ['Fera Interior'] });
      check('card_translate without cache → scryfall-fuzzy', r.json?.results?.[0]?.en === 'Beast Within' && r.json.results[0].source === 'scryfall-fuzzy' && r.json.results[0].pt === 'Fera Interior', r.text);
      r = await p5.call('archidekt_search_cards', { name: 'Anel Solar' });
      check('search_cards PT name via Scryfall when no cache', r.json?.count === 2 && r.json.translation?.source === 'scryfall-fuzzy', r.text);
      r = await p5.call('archidekt_update_deck_cards', { deckId: 1003, changes: [{ action: 'add', cardName: 'Testemunha Eterna', category: 'Creatures' }] });
      check('update_deck_cards PT add via Scryfall when no cache', r.json?.verification === 'verified' && r.json.translations?.[0]?.source === 'scryfall-fuzzy', r.text);
      r = await p5.call('deck_analyze', { deckId: 1003 });
      check('deck_analyze works without cache (with note, no options)', Array.isArray(r.json?.cards?.all) && r.json.notes.some((l) => /cards_cache_update/.test(l)) && r.json.options.length === 0, r.text.slice(0, 500));
      r = await p5.call('deck_upgrade_candidates', { deckId: 1003, count: 3, withPrices: false });
      check('upgrades without cache: unverified EDHREC cards are never suggested (identity cannot be confirmed)', !r.isError && (r.json?.candidates || []).length === 0 && r.json.notes.some((n) => /identidade de cor/.test(n)), r.text);
    } finally {
      await p5.close();
    }
  }

  // ---------------- default home location ----------------
  console.log('\n# Storage location');
  {
    const store = await import('../server/store.mjs');
    const saved = { ...process.env };
    const fakeHome = tmp('home');
    try {
      delete process.env.ARCHIDEKT_HOME;
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      check('default home ~/.archidekt', store.homeDir() === path.join(fakeHome, '.archidekt'), store.homeDir());
      fs.mkdirSync(path.join(fakeHome, 'Projects', 'archidekt-mcp'), { recursive: true });
      check('prefers ~/Projects/archidekt-mcp when it exists', store.homeDir() === path.join(fakeHome, 'Projects', 'archidekt-mcp'), store.homeDir());
      process.env.ARCHIDEKT_HOME = path.join(fakeHome, 'custom');
      check('ARCHIDEKT_HOME wins', store.homeDir() === path.join(fakeHome, 'custom'));
      const f = path.join(fakeHome, 'custom', 'data', 'x.json');
      store.writeJson(f, { a: 1 });
      store.writeJson(f, { a: 2 });
      check('atomic write replaces existing file', store.readJson(f).a === 2 && fs.readdirSync(path.dirname(f)).length === 1);
    } finally {
      for (const k of ['ARCHIDEKT_HOME', 'HOME', 'USERPROFILE']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }
}

// ---------------- review fixes (phase 2 hardening) ----------------
export async function runReviewFixes({ McpProc, baseEnv, check, ext, archBase, MOCK_USER }) {
  const dirs = [];
  const mk = (tag) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `archidekt-rv-${tag}-`));
    dirs.push(d);
    return d;
  };
  const creds = { ARCHIDEKT_API_BASE: archBase, ARCHIDEKT_EMAIL: MOCK_USER.email, ARCHIDEKT_PASSWORD: MOCK_USER.password };
  const reset = () => fetch(`${ext.origin}/__test/reset`);
  const savedEnv = { ...process.env };
  try {
    console.log('\n# Review fixes: streaming, parsing, normalization');
    const zlib = await import('node:zlib');
    const { Readable } = await import('node:stream');
    const { bulkLines } = await import('../server/scryfall.mjs');
    const collect = async (chunks) => {
      const out = [];
      for await (const l of bulkLines(Readable.from(chunks))) out.push(l);
      return out;
    };
    const text = '{"a":"Relâmpago"}\n{"b":2}\n{"c":3}';
    const gz = zlib.gzipSync(Buffer.from(text));
    let lines = await collect([gz.subarray(0, 5), gz.subarray(5)]);
    check('bulkLines: gzip split across chunks, last line without newline', lines.length === 3 && JSON.parse(lines[0]).a === 'Relâmpago' && lines[2] === '{"c":3}', lines);
    const raw = Buffer.from(text);
    const cut = raw.indexOf(Buffer.from('â')) + 1; // split inside a multi-byte char
    lines = await collect([raw.subarray(0, cut), raw.subarray(cut)]);
    check('bulkLines: plain text, UTF-8 char split across chunks', JSON.parse(lines[0]).a === 'Relâmpago', lines);
    let err = null;
    try {
      await collect([gz.subarray(0, Math.floor(gz.length * 0.6))]);
    } catch (e) {
      err = e;
    }
    check('bulkLines: truncated gzip rejects (no silent partial data)', !!err, String(err));
    err = null;
    try {
      await collect((async function* () {
        yield Buffer.from('{"x":1}\n');
        throw new Error('connection reset');
      })());
    } catch (e) {
      err = e;
    }
    check('bulkLines: source error propagates', /connection reset/.test(String(err?.message)), String(err));

    const liga = await import('../server/ligamagic.mjs');
    check('parseBRL without thousands separator ("1499,00" → 1499)', liga.parseBRL('R$ 1499,00') === 1499 && liga.parseBRL('R$ 12.345.678,90') === 12345678.9 && liga.parseBRL('R$ 7,5') === 7.5);
    check('blocked detection: challenge pages yes, normal page mentioning recaptcha no', liga.looksBlocked(200, '<title>Just a moment...</title> cf-chl') && liga.looksBlocked(403, '') && !liga.looksBlocked(200, '<script src="recaptcha/api.js"></script><div>Nenhum resultado</div> access denied to admin area'));
    const dfcRows = [{ base: 'Valakut Awakening', auxBase: null, variant: null, min: 5 }, { base: 'Other', auxBase: null, variant: null }];
    check('rowsFor: DFC matches LigaMagic front-face row', liga.rowsFor(dfcRows, ['Valakut Awakening // Valakut Stoneforge', null]).length === 1);
    const { normName } = await import('../server/store.mjs');
    check('normName: Æ/œ ligatures', normName('Æther Vial') === 'aether vial' && normName('Ætherize') === normName('Aetherize'));
    const { commanderSlug } = await import('../server/edhrec.mjs');
    check('EDHREC slug: "&" dropped, Æ → ae, accents', commanderSlug('Minsc & Boo, Timeless Heroes') === 'minsc-boo-timeless-heroes' && commanderSlug('Lim-Dûl the Necromancer') === 'lim-dul-the-necromancer' && commanderSlug('Ærathi Berserker') === 'aerathi-berserker');

    // ---- EDHREC redirects ----
    const hR = mk('edh');
    Object.assign(process.env, { ARCHIDEKT_HOME: hR, EDHREC_BASE: `${ext.origin}/edhrec`, EDHREC_MIN_INTERVAL_MS: '0' });
    const edh = await import('../server/edhrec.mjs');
    const loop = await edh.commanderPageSafe(['Loop A']);
    check('EDHREC redirect loop terminates with an error', loop.found === false && /redirecionamentos/.test(loop.error || ''), loop);
    const red = await edh.commanderPageSafe(['Old Name']);
    const n0 = (await (await fetch(`${ext.origin}/__test/log`)).json()).filter((x) => x.path.includes('old-name')).length;
    const red2 = await edh.commanderPageSafe(['Old Name']);
    const n1 = (await (await fetch(`${ext.origin}/__test/log`)).json()).filter((x) => x.path.includes('old-name')).length;
    check('EDHREC redirect followed (live every time, no cache)', red.found && red.slug === 'omnath-locus-of-rage' && red2.found && n1 > n0, { red: red.slug, n0, n1 });

    // ---- analysis sanity ----
    const { analyzeDeck, cutCandidates } = await import('../server/analysis.mjs');
    const row = (name, o = {}) => ({ name, qty: o.qty ?? 1, mv: o.mv, type: o.type ?? 'Creature', category: o.cat ?? 'Main', categories: [], included: true, isCommander: !!o.cmd, oracle: { name, text: o.text ?? '', oTags: [] } });
    const deck = {
      id: 1, name: 'NaN test', identity: 'G', mainCount: 100,
      rows: [row('Cmdr', { cmd: true, mv: 'x', cat: 'Commander' }), row('Weird', { mv: undefined }), row('Odd', { mv: 'abc' }), row('Forest', { qty: 60, type: 'Basic Land — Forest', mv: 0 }), row('Bear', { mv: 2 })],
    };
    const an = analyzeDeck(deck, { edh: { found: true, slug: 'x', typeMix: {}, cards: new Map([['bear', { name: 'Bear', synergy: 'abc', inclusion: NaN }]]) } });
    check('analysis: no NaN anywhere (bad mv / EDHREC numbers)', !/NaN/.test(JSON.stringify(an.cards)) && Number.isFinite(an.mana.avgMv) && an.cards.every((c) => Number.isFinite(c.score)), an.cards);
    const cc = cutCandidates(an, 10);
    check('cuts: commander never a candidate; basics only with land surplus (60 lands here)', !cc.cuts.some((c) => c.name === 'Cmdr') && cc.cuts.some((c) => c.name === 'Forest'), cc.cuts);

    // ---- cache freshness, auto-update backoff, cross-process lock ----
    console.log('\n# Review fixes: cache job');
    const hC = mk('lock');
    Object.assign(process.env, { ARCHIDEKT_HOME: hC, SCRYFALL_API_BASE: `${ext.origin}/scryfall`, SCRYFALL_MIN_INTERVAL_MS: '0', SCRYFALL_RETRY_DELAY_MS: '0' });
    const cache = await import('../server/cache.mjs');
    fs.mkdirSync(path.join(hC, 'data'), { recursive: true });
    fs.writeFileSync(path.join(hC, 'data', 'cards.json'), '{"cards":[]}');
    const twoDays = new Date(Date.now() - 2 * 86400e3).toISOString();
    check('partial cache is fresh for 24 h only; complete cache for 7 days', !cache.isFresh({ updatedAt: twoDays, partial: true }) && cache.isFresh({ updatedAt: twoDays }));
    check('auto-update backs off right after a failed attempt', !cache.shouldAutoUpdate({ updatedAt: null, lastAttemptAt: new Date().toISOString(), errors: ['x'] }) && cache.shouldAutoUpdate({ updatedAt: null, lastAttemptAt: twoDays, errors: ['x'] }) && cache.shouldAutoUpdate(null));
    const lock = path.join(hC, 'data', 'cache-job.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, at: new Date().toISOString() }));
    let st = cache.startUpdate({ force: true });
    check('cross-process lock: another live server holds the job → not started', st.started === false && /outro processo/.test(st.status), st);
    fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: new Date().toISOString() }));
    await reset();
    await ext.setFlags({ failPtPageOnce: 2 });
    st = cache.startUpdate({ force: true });
    const meta = await cache.waitForJob();
    check('stale lock (dead pid) is taken over; lock released after the job', st.started === true && !fs.existsSync(lock), st);
    check('transient 5xx on a PT page is retried (no partial PT list)', meta?.errors?.length === 0 && meta.partial === false && cache.jobStatus().progress.ptPages === 3, meta);
    check('ambiguous PT name keeps alternatives', JSON.stringify(cache.resolveLocal('Opção')?.alternatives) === JSON.stringify(['Opt', 'Howling Mine']) && cache.resolveLocal('Opção').confidence < 1, cache.resolveLocal('Opção'));
    await reset();
    await ext.setFlags({ truncGz: true });
    st = cache.startUpdate({ force: true });
    const meta2 = await cache.waitForJob();
    check('truncated oracle_cards download → error recorded, previous cards.json kept', meta2?.errors?.some((e) => /oracle_cards/.test(e)) && JSON.parse(fs.readFileSync(path.join(hC, 'data', 'cards.json'), 'utf8')).cards.length === 32 && cache.jobStatus().lastErrors?.length >= 1, meta2?.errors);
    await reset();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  }

  // ---- over the wire: time budget, ambiguous PT writes, wiki hardening ----
  console.log('\n# Review fixes: tools');
  const hT = mk('tools');
  const p = new McpProc(baseEnv({ ...creds, ARCHIDEKT_HOME: hT, ARCHIDEKT_TOOL_BUDGET_MS: '4000', LIGAMAGIC_MIN_INTERVAL_MS: '1500' }));
  try {
    await p.init();
    let r = await p.call('cards_cache_update', {});
    for (let i = 0; i < 200; i++) {
      r = await p.call('cards_cache_status');
      if (r.json?.job?.step === 'done') break;
      await sleep(100);
    }
    const t0 = Date.now();
    r = await p.call('card_price_br', { names: ['Zz One', 'Zz Two', 'Zz Three', 'Zz Four', 'Zz Five', 'Zz Six'] });
    const dt = Date.now() - t0;
    const limited = (r.json?.results || []).filter((x) => /limite de tempo/.test(x.error || '')).length;
    check('card_price_br respects the per-call time budget (stops, reports, no failure)', !r.isError && dt < 7000 && limited >= 2 && /limite de tempo/.test(r.json.timeLimited || ''), { dt, r: r.text.slice(0, 600) });
    r = await p.call('card_price_br', { names: ['Zz One'] });
    check('prices fetched before the limit are cached (incl. "not found")', r.json?.results?.[0]?.cached === true && r.json.results[0].found === false, r.text);
    r = await p.call('card_price_br', { names: ['Login Form Card'] });
    check('page mentioning recaptcha (no results) is not treated as a block', !r.json?.blocked && r.json?.results?.[0]?.found === false, r.text);
    const t1 = Date.now();
    r = await p.call('deck_upgrade_candidates', { deckId: 1003, count: 10 });
    check('deck_upgrade_candidates stays within the budget with prices on', !r.isError && Date.now() - t1 < 9000 && (r.json?.notes || []).some((n) => /limite de tempo/.test(n)), { dt: Date.now() - t1, notes: r.json?.notes });
    r = await p.call('card_translate', { names: ['Opção'] });
    check('card_translate: ambiguous PT name → alternatives + lower confidence', r.json?.results?.[0]?.alternatives?.length === 2 && r.json.results[0].confidence < 1, r.text);
    r = await p.call('archidekt_update_deck_cards', { deckId: 1003, changes: [{ action: 'add', cardName: 'Opção' }] });
    check('write with ambiguous PT name is refused (asks for the English name)', /mais de uma carta/.test(r.text) && /Opt/.test(r.text), r.text);
    const outside = mk('outside');
    fs.mkdirSync(path.join(hT, 'wiki'), { recursive: true });
    let linked = true;
    try {
      fs.symlinkSync(outside, path.join(hT, 'wiki', 'fora'), 'junction');
    } catch {
      linked = false;
    }
    if (linked) {
      r = await p.call('wiki_write', { page: 'fora/x', content: 'segredo', mode: 'replace' });
      check('wiki: symlinked folder cannot lead writes outside the wiki', r.isError && !fs.existsSync(path.join(outside, 'x.md')), r.text);
    }
    let allBad = true;
    for (const page of ['decks/nul', 'AUX', 'meta/com1', 'decks/' + 'a'.repeat(81), 'decks/x\u0000y', 'decks/a b/../c']) {
      const w = await p.call('wiki_write', { page, content: 'x', mode: 'replace' });
      if (!w.isError) allBad = false;
    }
    check('wiki: reserved names, overlong segments, NUL rejected', allBad);
  } finally {
    await p.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
}
