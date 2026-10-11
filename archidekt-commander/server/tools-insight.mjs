// Phase 2 tools: card cache, translation, LigaMagic prices, deck analysis funnel, snapshots, personal wiki.

import { analyzeDeck, cardInfo, commanderThemes, cutCandidates, gapRoles, heuristicSynergy, ROLE_TARGETS, rolePt } from './analysis.mjs';
import { cacheSummary, findCard, getCache, jobStatus, ptNameOf, startUpdate } from './cache.mjs';
import { deckIdentityOf, normColors, withinIdentity } from './commander.mjs';
import { cardFluidity } from './fluidity.mjs';
import { CORE_ROLES } from './roles.mjs';
import { commanderPageSafe } from './edhrec.mjs';
import * as liga from './ligamagic.mjs';
import { ROLES, textRoles } from './roles.mjs';
import * as scryfall from './scryfall.mjs';
import { diffSnapshot, listSnapshots, loadSnapshot, saveSnapshot } from './snapshots.mjs';
import { envInt, normName, ToolError } from './store.mjs';
import { translateName } from './translate.mjs';
import * as wiki from './wiki.mjs';

const LOCAL = { readOnlyHint: true, openWorldHint: false };
const RO = { readOnlyHint: true, openWorldHint: true };
const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const inputError = (m) => new ToolError('input', m);

// Wall-clock budget for one tool call (MCP clients time out around 60 s). Slow network steps
// (LigaMagic at ≥2 s per card, collection lookups, remote translations) stop when it runs out and
// report what was skipped instead of making the whole call fail.
const budgetMs = () => envInt('ARCHIDEKT_TOOL_BUDGET_MS', 40_000);
const deadlineFromNow = () => Date.now() + budgetMs();
const TIME_LIMIT = 'não consultado (limite de tempo da chamada; repita para continuar — o que já foi consultado fica em cache)';

const ROLE_ALIASES = {
  remocao: 'removal', 'remoção': 'removal', removal: 'removal', compra: 'draw', draw: 'draw', 'card-draw': 'draw', 'card-advantage': 'draw',
  ramp: 'ramp', wipe: 'wipe', 'board-wipe': 'wipe', sweeper: 'wipe', counter: 'counter', counterspell: 'counter', tutor: 'tutor',
  protecao: 'protection', 'proteção': 'protection', protection: 'protection', recursao: 'recursion', 'recursão': 'recursion', recursion: 'recursion',
  'gy-hate': 'gy-hate', 'graveyard-hate': 'gy-hate', 'sac-outlet': 'sac-outlet', 'sacrifice-outlet': 'sac-outlet', tokens: 'tokens', token: 'tokens',
  landfall: 'landfall', lifegain: 'lifegain', burn: 'burn', evasion: 'evasion', 'evasão': 'evasion', anthem: 'anthem', wincon: 'wincon', finisher: 'wincon', finalizador: 'wincon',
};
const TYPE_ALIASES = { criatura: 'creature', artefato: 'artifact', encantamento: 'enchantment', instantanea: 'instant', 'instantânea': 'instant', feitico: 'sorcery', 'feitiço': 'sorcery', terreno: 'land', planinauta: 'planeswalker', lendaria: 'legendary', 'lendária': 'legendary' };

function role(r) {
  const k = String(r || '').trim().toLowerCase().replace(/\s+/g, '-');
  const v = ROLE_ALIASES[k] ?? (ROLES.includes(k) ? k : null);
  if (!v) throw inputError(`Papel desconhecido: "${r}". Use um de: ${ROLES.join(', ')}.`);
  return v;
}

function names(v, field, max) {
  if (!Array.isArray(v) || !v.length) throw inputError(`"${field}" deve ser uma lista não vazia.`);
  if (v.length > max) throw inputError(`Máximo de ${max} nomes por chamada.`);
  return v.map((x) => {
    if (typeof x !== 'string' || !x.trim()) throw inputError(`"${field}" só aceita textos não vazios.`);
    return x.trim();
  });
}

function intArg(v, field, { min = 1, max = 1000, dflt } = {}) {
  if (v === undefined || v === null) {
    if (dflt !== undefined) return dflt;
    throw inputError(`"${field}" é obrigatório.`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw inputError(`"${field}" deve ser inteiro entre ${min} e ${max}.`);
  return n;
}

const ciSubset = (cardCi, deckCi) => withinIdentity(cardCi, deckCi || 'C');
const cacheNote = () => (getCache()?.hasCards ? null : 'Cache local de cartas ausente: rode cards_cache_update (papéis vêm só do Archidekt/texto).');

function publicCard(rec) {
  return {
    name: rec.name,
    pt: ptNameOf(rec.name),
    mv: rec.mv,
    cost: rec.cost,
    type: rec.type,
    ci: rec.ci || 'C',
    roles: rec.roles,
    rank: rec.rank,
    gc: rec.gc,
    legal: rec.legal,
    usd: rec.usd,
  };
}

/** ctx: {client, getDeck, ownedRecords} from tools.mjs */
export function buildInsightTools(ctx) {
  const { client, getDeck, ownedRecords } = ctx;

  async function analysisFor(deckId, { targetBracket, plan } = {}) {
    const deck = await getDeck(deckId);
    const edh = deck.commanders.length ? await commanderPageSafe(deck.commanders.map((c) => c.name)) : { found: false, cards: new Map(), typeMix: {} };
    const analysis = analyzeDeck(deck, { lookup: findCard, edh, targetBracket, plan });
    return { deck, edh, analysis };
  }

  const strip = (a) => {
    const { _scored, _landTarget, ...rest } = a;
    return rest;
  };

  async function priceList(list, { deadline = deadlineFromNow() } = {}) {
    // list: [{en, pt, query}] → results; stops on blocking and when the time budget runs out
    // (cached prices are still returned after that).
    const out = [];
    let blocked = null;
    let timeLimited = 0;
    for (const item of list) {
      if (blocked) {
        out.push({ en: item.en, pt: item.pt, error: 'não consultado (LigaMagic bloqueou)' });
        continue;
      }
      if (deadline - Date.now() < 2500) {
        const hit = liga.cachedPrice(item);
        if (hit) out.push(hit);
        else {
          timeLimited++;
          out.push({ en: item.en, pt: item.pt, error: TIME_LIMIT });
        }
        continue;
      }
      try {
        out.push(await liga.priceFor(item, { deadline }));
      } catch (e) {
        if (e.kind === 'blocked') blocked = e.message;
        if (e.kind === 'budget' || e.kind === 'timeout') {
          timeLimited++;
          out.push({ en: item.en, pt: item.pt, error: e.kind === 'budget' ? TIME_LIMIT : e.message });
          continue;
        }
        out.push({ en: item.en, pt: item.pt, error: e.message });
      }
    }
    return { results: out, blocked, timeLimited };
  }

  return [
    // ---------------- cache ----------------
    {
      name: 'cards_cache_update',
      description: 'Atualiza o cache local de cartas (Scryfall: oracle cards + tags de função + nomes em PT) em SEGUNDO PLANO e responde na hora ("iniciado" ou "já atualizado em <data>"). force=true refaz mesmo se tiver < 7 dias. Acompanhe com cards_cache_status.',
      inputSchema: { type: 'object', properties: { force: { type: 'boolean', default: false } } },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      handler: async ({ force }) => {
        const r = startUpdate({ force: force === true });
        return { ...r, location: cacheSummary().location, hint: r.started ? 'Leva alguns minutos (download ~31 MB + ~230 páginas de nomes PT). Use cards_cache_status.' : undefined };
      },
    },
    {
      name: 'cards_cache_status',
      description: 'Status do cache local de cartas: job em andamento (etapa, progresso), última atualização, contagens, tamanhos, erros.',
      inputSchema: { type: 'object', properties: {} },
      annotations: LOCAL,
      handler: async () => ({ job: jobStatus(), ...cacheSummary() }),
    },

    // ---------------- translation / lookup / search ----------------
    {
      name: 'card_translate',
      description: 'Traduz nomes de cartas PT⇄EN. Ordem: cache local (exato, depois parecido) → Scryfall fuzzy → LigaMagic. Para cada nome: {input, en, pt, source, confidence}; lista os não resolvidos.',
      inputSchema: {
        type: 'object',
        properties: { names: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 }, to: { type: 'string', enum: ['en', 'pt'], default: 'en' } },
        required: ['names'],
      },
      annotations: RO,
      handler: async (args) => {
        const list = names(args.names, 'names', 50);
        const to = args.to ?? 'en';
        if (!['en', 'pt'].includes(to)) throw inputError('"to" deve ser "en" ou "pt".');
        const results = [];
        const deadline = deadlineFromNow();
        let limited = 0;
        for (const n of list) {
          const remote = deadline - Date.now() > 5000;
          let t = await translateName(n, { wantPt: true, remote, deadline });
          if (!remote && t.unresolved) {
            limited++;
            t = { ...t, reason: TIME_LIMIT };
          }
          results.push(t.unresolved ? t : { ...t, result: to === 'pt' ? t.pt ?? null : t.en });
        }
        const out = { to, results, unresolved: results.filter((r) => r.unresolved).map((r) => r.input), note: cacheNote() ?? undefined };
        if (limited) out.timeLimited = `${limited} nome(s) sem consulta remota por limite de tempo; repita só com eles.`;
        return out;
      },
    },
    {
      name: 'card_lookup',
      description: 'Ficha completa de uma carta (aceita nome em PT ou EN): nome EN+PT, custo, tipo, texto, identidade de cor, papéis/tags, legalidade em Commander, Game Changer, rank EDHREC. Usa o cache local; sem cache, consulta o Scryfall.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      annotations: RO,
      handler: async ({ name }) => {
        if (typeof name !== 'string' || !name.trim()) throw inputError('"name" é obrigatório.');
        let rec = findCard(name);
        let translation = null;
        if (!rec) {
          const t = await translateName(name);
          if (!t.unresolved) {
            rec = findCard(t.en);
            translation = { input: name, en: t.en, source: t.source, confidence: t.confidence };
            if (t.pt) translation.pt = t.pt;
          }
        }
        const translatedPt = translation?.pt ?? null;
        if (translation) delete translation.pt;
        if (rec) return { ...publicCard(rec), text: rec.text, keywords: rec.kw, tags: rec.tags || [], faces: rec.faces, power: rec.pt, ligamagicUrl: liga.cardUrl(rec.name), source: 'cache', ...(translation ? { translation } : {}) };
        const enName = translation?.en || name;
        const card = await scryfall.named(enName);
        if (!card) throw new ToolError('not_found', `Carta não encontrada: "${name}".`);
        const faces = Array.isArray(card.card_faces) && card.card_faces.length > 1 ? card.card_faces : null;
        const text = card.oracle_text ?? (faces ? faces.map((f) => f.oracle_text || '').join('\n//\n') : '');
        const type = card.type_line ?? '';
        return {
          name: card.name,
          pt: ptNameOf(card.name) ?? translatedPt ?? (await scryfall.portugueseName(card.name).catch(() => null)),
          mv: card.cmc,
          cost: card.mana_cost ?? (faces ? faces.map((f) => f.mana_cost).join(' // ') : ''),
          type,
          text,
          ci: (card.color_identity || []).join('') || 'C',
          roles: textRoles(text, type, card.name),
          keywords: card.keywords || [],
          rank: card.edhrec_rank ?? null,
          gc: !!card.game_changer,
          legal: card.legalities?.commander ?? 'unknown',
          usd: card.prices?.usd ? Number(card.prices.usd) : null,
          ligamagicUrl: liga.cardUrl(card.name),
          source: 'scryfall',
          ...(translation ? { translation } : {}),
          note: cacheNote() ?? undefined,
        };
      },
    },
    {
      name: 'card_search_local',
      description: 'Busca no cache local de cartas por papel (ramp, draw, removal, wipe, counter, tutor, protection, recursion, sac-outlet, gy-hate, tokens, landfall, lifegain, burn, evasion, anthem, wincon), texto, tipo, identidade de cor (subconjunto, ex.: "RG"), MV máximo. Ex.: "ramp verde até 3 de mana" → roles=["ramp"], colorIdentity="G", maxMv=3.',
      inputSchema: {
        type: 'object',
        properties: {
          roles: { type: 'array', items: { type: 'string' } },
          rolesMode: { type: 'string', enum: ['any', 'all'], default: 'any' },
          text: { type: 'string', description: 'Trecho do texto/nome (EN; nome PT também vale).' },
          type: { type: 'string', description: 'Trecho da linha de tipo, ex.: "creature", "artifact", "equipment".' },
          colorIdentity: { type: 'string', description: 'Identidade do deck, ex.: "RG"; "C" = só incolores.' },
          maxMv: { type: 'number' },
          commanderLegal: { type: 'boolean', default: true },
          excludeNames: { type: 'array', items: { type: 'string' } },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          sort: { type: 'string', enum: ['edhrec', 'mv', 'name', 'price'], default: 'edhrec' },
        },
      },
      annotations: LOCAL,
      handler: async (args) => {
        const cache = getCache();
        if (!cache?.hasCards) throw new ToolError('not_configured', 'Cache local de cartas ainda não existe. Rode cards_cache_update e acompanhe com cards_cache_status.');
        const roles = (args.roles || []).map(role);
        const mode = args.rolesMode === 'all' ? 'all' : 'any';
        const limit = intArg(args.limit, 'limit', { max: 100, dflt: 25 });
        const text = args.text ? normName(args.text) : null;
        let type = args.type ? String(args.type).toLowerCase().trim() : null;
        if (type && TYPE_ALIASES[type]) type = TYPE_ALIASES[type];
        const ci = args.colorIdentity != null ? (/^c(olorless)?$/i.test(String(args.colorIdentity).trim()) || args.colorIdentity === '' ? '' : normColors(String(args.colorIdentity)).replace('C', '')) : null;
        const maxMv = args.maxMv != null ? Number(args.maxMv) : null;
        const legalOnly = args.commanderLegal !== false;
        const exclude = new Set((args.excludeNames || []).map(normName));
        let hits = cache.list.filter((c) => {
          if (legalOnly && c.legal !== 'legal') return false;
          if (ci !== null && !ciSubset(c.ci, ci)) return false;
          if (maxMv !== null && c.mv > maxMv) return false;
          if (type && !c.type.toLowerCase().includes(type)) return false;
          if (roles.length && !(mode === 'all' ? roles.every((r) => c.roles.includes(r)) : roles.some((r) => c.roles.includes(r)))) return false;
          if (exclude.has(normName(c.name))) return false;
          if (text) {
            const pt = cache.en.get(c.name);
            if (!normName(`${c.name} ${c.text}`).includes(text) && !(pt && normName(pt).includes(text))) return false;
          }
          return true;
        });
        const sort = args.sort || 'edhrec';
        const by = {
          edhrec: (a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9),
          mv: (a, b) => a.mv - b.mv || (a.rank ?? 1e9) - (b.rank ?? 1e9),
          name: (a, b) => a.name.localeCompare(b.name),
          price: (a, b) => (a.usd ?? 1e9) - (b.usd ?? 1e9),
        }[sort];
        if (!by) throw inputError('sort deve ser edhrec, mv, name ou price.');
        hits.sort(by);
        const total = hits.length;
        hits = hits.slice(0, limit);
        return { total, shown: hits.length, cards: hits.map(publicCard) };
      },
    },

    // ---------------- prices ----------------
    {
      name: 'card_price_br',
      description: 'Preços em reais (R$) na LigaMagic para até 30 cartas (nome PT ou EN): mínimo, médio, máximo, até 5 variantes (edição/número), link e data da consulta. Cache de 24 h; ≥2 s entre consultas; se a LigaMagic bloquear, para e avisa. Sempre cite "LigaMagic" e a data.',
      inputSchema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 30 } }, required: ['names'] },
      annotations: RO,
      handler: async (args) => {
        const list = names(args.names, 'names', 30);
        const deadline = deadlineFromNow();
        const items = [];
        for (const n of list) {
          // LigaMagic itself accepts PT or EN, so translation here never spends a LigaMagic request;
          // remote (Scryfall) translation only while there is time left for the prices themselves.
          const t = await translateName(n, { wantPt: true, useLiga: false, remote: deadline - Date.now() > 20_000, deadline });
          items.push(t.unresolved ? { en: null, pt: null, query: n } : { en: t.en, pt: t.pt, query: t.pt || t.en });
        }
        const pl = await priceList(items, { deadline });
        const { blocked, timeLimited } = pl;
        const results = pl.results.map((r, i) => (r.ligamagicUrl ? r : { ...r, ligamagicUrl: liga.cardUrl(r.en || r.pt || items[i]?.query) }));
        const out = { source: 'LigaMagic', results };
        if (list.length > 1) {
          const s = (k) => Math.round(results.reduce((acc, r) => acc + (r.found && r[k] != null ? r[k] : 0), 0) * 100) / 100;
          const priced = results.filter((r) => r.found && (r.min != null || r.avg != null)).length;
          const withMin = results.filter((r) => r.found && r.min != null).length;
          out.totalBRL = { min: s('min'), avg: s('avg'), cardsPriced: priced, incomplete: withMin < list.length || priced < list.length };
        }
        if (blocked) out.blocked = blocked;
        if (timeLimited) out.timeLimited = `${timeLimited} carta(s) não consultada(s) por limite de tempo (≥2 s por consulta na LigaMagic). Repita a chamada: as já consultadas vêm do cache.`;
        return out;
      },
    },

    // ---------------- analysis funnel ----------------
    {
      name: 'deck_analyze',
      description: 'Análise profunda de um deck, focada em deixá-lo melhor e mais fluido: funções vs metas (ramp, compra, remoção, wipes, proteção, tutores, recursão), mana (curva, MV médio, faixa de terrenos calculada pelo próprio deck, símbolos vs fontes, terrenos virados), FLUIDEZ (jogadas de MV ≤ 2, topo da curva, cartas caras sem função que travam a mão, exigência de cor de cada cor com a chance de ter as fontes a tempo — comandante incluído —, motores de compra, usos para mana sobrando), sinergia com o comandante (texto; EDHREC só como referência), combos, Game Changers e bracket estimado, problemas por impacto e nota 0–100 por carta. Inclui a página da wiki do deck se existir.',
      inputSchema: {
        type: 'object',
        properties: {
          deckId: { type: 'integer' },
          targetBracket: { type: 'integer', minimum: 1, maximum: 5 },
          plan: { type: 'string', description: 'Plano de jogo em poucas palavras (ex.: "landfall tokens"), refina a sinergia.' },
        },
        required: ['deckId'],
      },
      annotations: RO,
      handler: async (args) => {
        const id = intArg(args.deckId, 'deckId', { max: 1e10 });
        const targetBracket = args.targetBracket != null ? intArg(args.targetBracket, 'targetBracket', { max: 5 }) : null;
        const { deck, analysis } = await analysisFor(id, { targetBracket, plan: args.plan });
        const page = wiki.deckPage(deck.name, deck.commanders.map((c) => c.name));
        const note = cacheNote();
        const out = strip(analysis);
        if (note) out.summary.push(note);
        out.wikiPage = page.content ? { page: page.page, content: page.content.slice(0, 6000), truncated: page.content.length > 6000 } : { page: page.page, exists: false };
        return out;
      },
    },
    {
      name: 'deck_cut_candidates',
      description: 'Cartas candidatas a corte (menor nota do deck_analyze), sem o comandante e sem cartas de funções que já estão no mínimo; terrenos só se houver excesso. Cada uma com o motivo.',
      inputSchema: {
        type: 'object',
        properties: { deckId: { type: 'integer' }, count: { type: 'integer', minimum: 1, maximum: 40, default: 10 }, targetBracket: { type: 'integer', minimum: 1, maximum: 5 }, plan: { type: 'string' } },
        required: ['deckId'],
      },
      annotations: RO,
      handler: async (args) => {
        const id = intArg(args.deckId, 'deckId', { max: 1e10 });
        const count = intArg(args.count, 'count', { max: 40, dflt: 10 });
        const targetBracket = args.targetBracket != null ? intArg(args.targetBracket, 'targetBracket', { max: 5 }) : null;
        const { analysis } = await analysisFor(id, { targetBracket, plan: args.plan });
        const { protectedRoles, cuts, alsoConsider } = cutCandidates(analysis, count);
        return {
          deckId: id,
          deckCount: analysis.deck.count,
          protectedRoles: protectedRoles.map((r) => `${r} (${analysis.roles[r].count}, meta ${analysis.roles[r].target})`),
          cuts: cuts.map((c) => ({ ...c, ligamagicUrl: liga.cardUrl(c.name) })),
          ...(alsoConsider.length ? { alsoConsider: alsoConsider.map((c) => ({ ...c, ligamagicUrl: liga.cardUrl(c.name) })) } : {}),
          note: cacheNote() ?? undefined,
        };
      },
    },
    {
      name: 'deck_upgrade_candidates',
      description: 'Sugestões de entrada para um deck, SEMPRE dentro da identidade de cor do comandante (cartas sem identidade confirmada no cache local são descartadas), legais e fora do deck. Fontes: busca por função, cartas baratas que deixam o deck fluido e cartas cujo texto conversa com o comandante (cache local) + listas do EDHREC como referência. Nota = mérito próprio (função, fluidez, sinergia de texto) + bônus limitado de referência. Marca o que você já tem (coleção), traz preço LigaMagic dos primeiros (≤15), ordena "tenho" primeiro e depois nota, e indica a função que preenche e qual corte substituiria.',
      inputSchema: {
        type: 'object',
        properties: {
          deckId: { type: 'integer' },
          count: { type: 'integer', minimum: 1, maximum: 30, default: 15 },
          role: { type: 'string', description: 'Focar numa função (ramp, draw, removal, wipe, protection, gy-hate…).' },
          maxPriceBRL: { type: 'number', description: 'Descarta cartas cujo preço mínimo na LigaMagic passe disso.' },
          ownedOnly: { type: 'boolean', default: false },
          withPrices: { type: 'boolean', default: true },
          targetBracket: { type: 'integer', minimum: 1, maximum: 5 },
        },
        required: ['deckId'],
      },
      annotations: RO,
      handler: async (args) => {
        const id = intArg(args.deckId, 'deckId', { max: 1e10 });
        const count = intArg(args.count, 'count', { max: 30, dflt: 15 });
        const focus = args.role ? role(args.role) : null;
        const targetBracket = args.targetBracket != null ? intArg(args.targetBracket, 'targetBracket', { max: 5 }) : null;
        const ownedOnly = args.ownedOnly === true;
        const withPrices = args.withPrices !== false;
        const maxPrice = args.maxPriceBRL != null ? Number(args.maxPriceBRL) : null;
        if (maxPrice != null && !(maxPrice >= 0)) throw inputError('maxPriceBRL deve ser um número ≥ 0.');
        if (ownedOnly && !client.hasCredentials) throw new ToolError('not_configured', 'ownedOnly precisa das credenciais do Archidekt (para ler a coleção).');

        const deadline = deadlineFromNow();
        const { deck, edh, analysis } = await analysisFor(id, { targetBracket });
        // Color identity is a hard rule: without a commander there is no identity to respect → refuse.
        if (!deck.commanders.length) throw inputError('Deck sem comandante (categoria Commander): não dá para garantir a identidade de cor das sugestões. Defina o comandante primeiro.');
        const deckCi = deckIdentityOf(deck, findCard);
        const th = { themes: analysis.themes, subtypes: commanderThemes(deck.commanders, null, { lookup: findCard }).subtypes };
        const identity = deckCi === 'C' ? [] : [...deckCi];
        const inDeck = new Set(deck.rows.filter((r) => r.included).map((r) => normName(r.name)));
        const inMaybe = new Set(deck.rows.filter((r) => !r.included).map((r) => normName(r.name)));
        const gaps = focus ? [{ role: focus, missing: Math.max(0, (ROLE_TARGETS[focus]?.[0] ?? 0) - (analysis.roles[focus]?.count ?? 0)) }] : gapRoles(analysis);
        const gapSet = new Set(gaps.map((g) => g.role));
        const gcNow = analysis.power.gameChangers.length;
        const notes = [];
        const pool = new Map();

        let unverified = 0;
        let offColor = 0;
        // score = own merit (function, fluidity, text synergy) + a bounded reference bonus (EDHREC / rank)
        const consider = (name, rec, refBonus, source, extra = {}) => {
          const k = normName(name);
          if (inDeck.has(k)) return;
          if (!rec) {
            unverified++; // identity/legality cannot be confirmed → never suggested
            return;
          }
          if (rec.legal !== 'legal') return;
          if (!ciSubset(rec.ci, deckCi)) {
            offColor++;
            return;
          }
          if (rec.gc && targetBracket && (targetBracket <= 2 || (targetBracket === 3 && gcNow >= 3))) return;
          const roles = rec?.roles || [];
          if (focus && !roles.includes(focus)) return;
          const fills = roles.filter((r) => gapSet.has(r));
          const info = cardInfo({ name: rec.name, qty: 1, mv: rec.mv, type: rec.type, oracle: {} }, rec);
          const fl = info.isLand ? 0.5 : cardFluidity(info, identity).score;
          const own = 25 + (roles.some((r) => CORE_ROLES.includes(r)) ? 12 : 0) + Math.round(fl * 25) + Math.round(heuristicSynergy(info, th) * 18);
          const score = Math.round(own + Math.min(15, Math.max(-5, refBonus)) + Math.min(30, fills.length * 15));
          const prev = pool.get(k);
          if (prev) {
            prev.score = Math.max(prev.score, score);
            if (!prev.sources.includes(source)) prev.sources.push(source);
            Object.assign(prev, extra);
            return;
          }
          pool.set(k, { name: rec?.name || name, score, roles, fills, sources: [source], verified: !!rec, inMaybeboard: inMaybe.has(k), ...extra });
        };

        if (edh.found) {
          for (const v of edh.cards.values()) {
            const rec = findCard(v.name);
            consider(v.name, rec, (v.synergy ?? 0) * 12 + (v.inclusion ?? 0) * 8, 'EDHREC (referência)', { synergy: v.synergy, inclusion: v.inclusion });
          }
        } else notes.push(`EDHREC sem dados para este comandante${edh.error ? ` (${edh.error})` : ''}.`);
        const cache = getCache();
        if (cache?.hasCards) {
          for (const g of gaps.length ? gaps : [{ role: 'draw' }]) {
            const list = cache.list
              .filter((c) => c.roles.includes(g.role) && c.legal === 'legal' && ciSubset(c.ci, deckCi) && !inDeck.has(normName(c.name)) && !/\bland\b/i.test(c.type.split('//')[0]))
              .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))
              .slice(0, 15);
            for (const c of list) consider(c.name, c, c.rank == null ? 0 : c.rank < 500 ? 8 : c.rank < 2000 ? 5 : c.rank < 5000 ? 2 : 0, 'cache');
          }
          // cheap cards that keep the deck flowing, and cards whose text talks to the commander
          const okc = (c) => c.legal === 'legal' && ciSubset(c.ci, deckCi) && !inDeck.has(normName(c.name)) && !/\bland\b/i.test(c.type.split('//')[0]) && (!focus || c.roles.includes(focus));
          cache.list
            .filter((c) => okc(c) && Number(c.mv) <= 2 && ['ramp', 'draw', 'removal'].some((r) => c.roles.includes(r)))
            .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))
            .slice(0, 15)
            .forEach((c) => consider(c.name, c, 0, 'cache (fluidez)'));
          if (th.themes.length) {
            cache.list
              .filter((c) => okc(c) && Number(c.mv) <= 5)
              .map((c) => ({ c, h: heuristicSynergy({ text: c.text || '', typeLine: c.type || '', roles: new Set(c.roles || []), subtypes: [] }, th) }))
              .filter((x) => x.h >= 0.5)
              .sort((a, b) => b.h - a.h || (a.c.rank ?? 1e9) - (b.c.rank ?? 1e9))
              .slice(0, 15)
              .forEach(({ c }) => consider(c.name, c, 0, 'cache (sinergia de texto)'));
          }
        } else notes.push(cacheNote());

        if (unverified) notes.push(`${unverified} carta(s) do EDHREC fora do cache local foram ignoradas (sem como confirmar identidade de cor/legalidade).`);
        if (offColor) notes.push(`${offColor} carta(s) fora da identidade de cor ${deckCi} descartadas.`);
        let ranked = [...pool.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
        if (!ranked.length) return { deckId: id, gaps, candidates: [], notes: [...notes, 'Nenhum candidato encontrado.'] };
        const head = ranked.slice(0, Math.min(30, Math.max(count * 2, 20)));

        // ownership
        if (client.hasCredentials) {
          try {
            const me = await client.me();
            // Each lookup is one Archidekt request (≥1.5 s apart): keep time for the prices.
            const reserve = withPrices ? 20_000 : 3000;
            let checked = 0;
            for (const c of head.slice(0, 20)) {
              if (deadline - Date.now() < reserve) break;
              const recs = await ownedRecords(me.id, c.name, 1);
              c.owned = recs.reduce((s, r) => s + (Number(r.quantity) || 0), 0);
              checked++;
            }
            if (checked < head.length) notes.push(`Posse conferida só nos ${checked} primeiros candidatos${checked < Math.min(20, head.length) ? ' (limite de tempo da chamada)' : ''}.`);
          } catch (e) {
            notes.push(`Coleção não consultada: ${e.message}`);
          }
        } else notes.push('Sem credenciais: posse na coleção não verificada.');
        ranked = head;
        if (ownedOnly) ranked = ranked.filter((c) => c.owned > 0);
        ranked.sort((a, b) => (b.owned > 0) - (a.owned > 0) || b.score - a.score || a.name.localeCompare(b.name));

        // prices for the top of the list
        if (withPrices) {
          const top = ranked.slice(0, Math.min(15, count + (maxPrice != null ? 5 : 0)));
          const { results, blocked, timeLimited } = await priceList(top.map((c) => ({ en: c.name, pt: ptNameOf(c.name), query: ptNameOf(c.name) || c.name })), { deadline });
          if (timeLimited) notes.push(`${timeLimited} preço(s) não consultado(s) por limite de tempo; repita a chamada (os já consultados ficam em cache) ou use card_price_br.`);
          top.forEach((c, i) => {
            const p = results[i];
            c.priceBRL = p?.found ? { min: p.min, avg: p.avg, fetchedAt: p.fetchedAt, url: p.url } : p?.error ? { error: p.error } : { found: false, searchUrl: p?.searchUrl ?? null };
          });
          if (blocked) notes.push(blocked);
          if (maxPrice != null) ranked = ranked.filter((c) => !(c.priceBRL?.min > maxPrice));
        }
        ranked = ranked.slice(0, count);

        // pair with cuts
        const { cuts } = cutCandidates(analysis, Math.max(count * 2, 10));
        const used = new Set();
        for (const c of ranked) {
          let cut = cuts.find((x) => !used.has(x.name) && x.roles.some((r) => c.roles.includes(r)));
          if (!cut) cut = cuts.find((x) => !used.has(x.name));
          if (cut) {
            used.add(cut.name);
            c.replaces = { name: cut.name, score: cut.score };
          }
        }
        return {
          deckId: id,
          colorIdentity: deckCi,
          gaps: gaps.map((g) => `${rolePt(g.role)} (faltam ${g.missing})`),
          source: withPrices ? 'preços: LigaMagic' : undefined,
          candidates: ranked.map((c) => ({
            name: c.name,
            pt: ptNameOf(c.name),
            ligamagicUrl: liga.cardUrl(c.name),
            score: c.score,
            owned: c.owned ?? null,
            fills: c.fills.map(rolePt),
            roles: c.roles,
            synergy: c.synergy ?? null,
            inclusion: c.inclusion ?? null,
            sources: c.sources,
            ...(c.inMaybeboard ? { inMaybeboard: true } : {}),
            ...(c.priceBRL !== undefined ? { priceBRL: c.priceBRL } : {}),
            ...(c.replaces ? { replaces: c.replaces } : {}),
          })),
          notes: notes.filter(Boolean),
        };
      },
    },

    // ---------------- snapshots ----------------
    {
      name: 'deck_snapshot',
      description: 'Salva uma foto da lista do deck (nome, qtd, categorias) em data/snapshots/<deckId>/. Use antes de mudanças grandes (update_deck_cards já faz isso sozinho com 5+ mudanças).',
      inputSchema: { type: 'object', properties: { deckId: { type: 'integer' }, note: { type: 'string' } }, required: ['deckId'] },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      handler: async ({ deckId, note }) => {
        const deck = await getDeck(intArg(deckId, 'deckId', { max: 1e10 }));
        return { deckId: deck.id, name: deck.name, snapshot: saveSnapshot(deck, note ? String(note).slice(0, 300) : null) };
      },
    },
    {
      name: 'deck_snapshot_list',
      description: 'Lista os snapshots salvos de um deck (id, data, nota, contagem).',
      inputSchema: { type: 'object', properties: { deckId: { type: 'integer' } }, required: ['deckId'] },
      annotations: LOCAL,
      handler: async ({ deckId }) => {
        const id = intArg(deckId, 'deckId', { max: 1e10 });
        const list = listSnapshots(id);
        return { deckId: id, count: list.length, snapshots: list };
      },
    },
    {
      name: 'deck_snapshot_diff',
      description: 'Compara um snapshot (padrão: o mais recente) com o deck atual no Archidekt: cartas adicionadas, removidas, quantidades e categorias alteradas.',
      inputSchema: { type: 'object', properties: { deckId: { type: 'integer' }, snapshot: { type: 'string', description: 'id do snapshot ou "latest".' } }, required: ['deckId'] },
      annotations: RO,
      handler: async ({ deckId, snapshot }) => {
        const id = intArg(deckId, 'deckId', { max: 1e10 });
        const snap = loadSnapshot(id, snapshot);
        const deck = await getDeck(id);
        return diffSnapshot(snap, deck);
      },
    },

    // ---------------- wiki ----------------
    {
      name: 'wiki_list',
      description: 'Lista as páginas da wiki pessoal (Markdown): decks/…, meta/grupo, cartas/avaliacoes, arquetipos/…',
      inputSchema: { type: 'object', properties: {} },
      annotations: LOCAL,
      handler: async () => ({ root: wiki.initWiki(), pages: wiki.listPages() }),
    },
    {
      name: 'wiki_read',
      description: 'Lê uma página da wiki pessoal, ex.: "decks/toph", "meta/grupo".',
      inputSchema: { type: 'object', properties: { page: { type: 'string' } }, required: ['page'] },
      annotations: LOCAL,
      handler: async ({ page }) => {
        const r = wiki.readPage(page);
        if (!r) {
          const { page: p } = wiki.resolvePage(page);
          throw new ToolError('not_found', `Página "${p}" não existe. Use wiki_list ou crie com wiki_write (modelo de deck em _templates/deck).`);
        }
        return r;
      },
    },
    {
      name: 'wiki_write',
      description: 'Cria/substitui (mode "replace") ou acrescenta ao fim (mode "append") uma página da wiki pessoal. Nome: letras minúsculas, números, - _ e /, até 3 níveis; máx. 200 KB.',
      inputSchema: {
        type: 'object',
        properties: { page: { type: 'string' }, content: { type: 'string' }, mode: { type: 'string', enum: ['replace', 'append'], default: 'append' } },
        required: ['page', 'content', 'mode'],
      },
      annotations: LOCAL_WRITE,
      handler: async ({ page, content, mode }) => wiki.writePage(page, content, mode ?? 'append'),
    },
    {
      name: 'wiki_search',
      description: 'Busca texto na wiki pessoal (sem diferenciar maiúsculas/acentos); retorna página e linhas encontradas.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      annotations: LOCAL,
      handler: async ({ query }) => wiki.searchWiki(query),
    },
  ];
}
