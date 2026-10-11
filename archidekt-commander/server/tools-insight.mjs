// Tools: card database, translation, LigaMagic prices, deck analysis (+ improvement options), personal wiki.
// Deck analysis is always computed from scratch in the call: no notes, plans or results from earlier sessions.

import { analyzeDeck, cardInfo, commanderThemes, cutCandidates, gapRoles, heuristicSynergy, ROLE_TARGETS, rolePt } from './analysis.mjs';
import { cacheSummary, findCard, getCache, jobStatus, ptNameOf, resolveLocal, startUpdate } from './cache.mjs';
import { deckIdentityOf, normColors, withinIdentity } from './commander.mjs';
import { cardFluidity } from './fluidity.mjs';
import { CORE_ROLES } from './roles.mjs';
import * as liga from './ligamagic.mjs';
import { ROLES, textRoles } from './roles.mjs';
import * as scryfall from './scryfall.mjs';
import { avgRoleCounts, candidatePool, engineReport, improvementOptions, scorecard, simulateInfos } from './improve.mjs';
import { roleTargets } from './optimizer.mjs';
import { envInt, normName, ToolError } from './store.mjs';
import { categoryFor } from './tools-optimize.mjs';
import { loadContext, MODE_ALIASES, triangulateDeck, VERDICT_PT } from './triangulate.mjs';
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
const TIME_LIMIT = 'não consultado (limite de tempo da chamada; consulte de novo só esta carta com card_price_br)';

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

  /**
   * Fresh analysis of a deck: live deck from Archidekt, live EDHREC reference pages, every card evaluated by the
   * own model (deck_triangulate) so analysis, cut list and options rank cards the same way.
   */
  async function analysisFor(deckId, { targetBracket, plan, mode = 'equilibrio', deadline = deadlineFromNow(), deck: given = null } = {}) {
    const deck = given || (await getDeck(deckId));
    const ctx = await loadContext(deck, { targetBracket, deadline: deadline - 8000 });
    const tri = triangulateDeck(deck, ctx, { lookup: findCard, mode, targetBracket, plan });
    const evaluations = new Map(tri.cards.map((c) => [normName(c.name), c]));
    const analysis = analyzeDeck(deck, { lookup: findCard, edh: ctx.base, targetBracket, plan, evaluations });
    return { deck, edh: ctx.base, ctx, tri, analysis };
  }

  const strip = (a) => {
    const { _scored, _landTarget, ...rest } = a;
    return rest;
  };

  async function priceList(list, { deadline = deadlineFromNow() } = {}) {
    // list: [{en, pt, query}] → results; stops on blocking and when the time budget runs out
    // (prices already fetched in this call are still returned after that).
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
      description: 'Preços em reais (R$) na LigaMagic para até 30 cartas (nome PT ou EN): mínimo, médio, máximo, até 5 variantes (edição/número), link e data da consulta. Sempre ao vivo (sem cache); ≥2 s entre consultas; se a LigaMagic bloquear, para e avisa. Sempre cite "LigaMagic" e a data.',
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
        if (timeLimited) out.timeLimited = `${timeLimited} carta(s) não consultada(s) por limite de tempo (≥2 s por consulta na LigaMagic). Consulte só as que faltaram numa nova chamada.`;
        return out;
      },
    },

    // ---------------- analysis funnel ----------------
    {
      name: 'deck_analyze',
      description:
        'Análise completa e NOVA de um deck (nada de análises, planos ou notas anteriores: lê o deck agora no Archidekt e o EDHREC ao vivo, só como referência) + OPÇÕES DE MELHORIA prontas. Mostra: diagnóstico curto com números; nota 0–10 por área (base de mana, início de jogo, gás, interação, plano e sinergia, resiliência, qualidade das cartas); o motor do plano (para cada tema: habilitadores × payoffs, finalizadores, motores de compra, ramp × gás); simulação de 2000 partidas (turnos mortos, sem cartas no T6, mana travada, falta de cor, comandante no tempo); funções vs metas, mana, fluidez, bracket; problemas por impacto; avaliação de cada carta pelo modelo próprio (valor, veredito, motivos). As opções de melhoria são pacotes de até 4 trocas 1-por-1, cada um mirando um problema (cartas fracas, gás, começo de jogo, curva, interação, plano, base de mana), sempre dentro da identidade de cor, legais e no bracket, testados na simulação (antes × depois) e prontos para deck_optimize_apply. Não altera nada.',
      inputSchema: {
        type: 'object',
        properties: {
          deckId: { type: 'integer' },
          targetBracket: { type: 'integer', minimum: 1, maximum: 5, description: 'Padrão: o declarado no deck.' },
          plan: { type: 'string', description: 'Plano de jogo em poucas palavras (ex.: "landfall tokens"), refina a sinergia.' },
          mode: { type: 'string', enum: ['equilibrio', 'forca', 'tema'], default: 'equilibrio' },
          lock: { type: 'array', items: { type: 'string' }, description: 'Cartas que nunca saem nas opções (PT ou EN).' },
          exclude: { type: 'array', items: { type: 'string' }, description: 'Cartas que nunca entram nas opções (PT ou EN).' },
          swapsPerOption: { type: 'integer', minimum: 1, maximum: 8, default: 4 },
          checkOwned: { type: 'boolean', default: false, description: 'Marca quais cartas das opções você já tem na coleção (≈1,5 s por carta).' },
        },
        required: ['deckId'],
      },
      annotations: RO,
      handler: async (args) => {
        const id = intArg(args.deckId, 'deckId', { max: 1e10 });
        const deadline = deadlineFromNow();
        const mode = args.mode == null ? 'equilibrio' : MODE_ALIASES[String(args.mode).trim().toLowerCase()];
        if (!mode) throw inputError('mode deve ser "equilibrio", "forca" ou "tema".');
        const perOption = intArg(args.swapsPerOption, 'swapsPerOption', { max: 8, dflt: 4 });
        const deck0 = await getDeck(id);
        const targetBracket = args.targetBracket != null ? intArg(args.targetBracket, 'targetBracket', { max: 5 }) : deck0.edhBracket ?? null;
        const { deck, ctx, tri, analysis } = await analysisFor(id, { targetBracket, plan: args.plan, mode, deadline, deck: deck0 });
        const notes = [...ctx.notes];
        const note = cacheNote();
        if (note) notes.push(note);
        if (!targetBracket) notes.push('Bracket alvo não informado nem declarado no deck: Game Changers, MLD e combos não foram restringidos nas opções.');

        const deckCi = deck.commanders.length ? deckIdentityOf(deck, findCard) : deck.identity || 'C';
        const identity = deckCi && deckCi !== 'C' ? [...deckCi] : [];
        const infos = [...tri.infos.values()];
        const commanderInfo = deck.commanders[0] ? cardInfo(deck.commanders[0], findCard(deck.commanders[0].name)) : null;
        const sim = simulateInfos(infos, commanderInfo, identity);
        const engine = engineReport(infos, tri.th, { commanders: commanderInfo ? [commanderInfo] : [], plan: args.plan });
        const card = scorecard({ analysis, sim, engine, tri });

        // ---- issues: rules/roles/mana from the analysis + plan engine + what the simulation shows
        const issues = analysis.issues.slice();
        const add = (impact, area, problem, fix) => issues.push({ impact, area, problem, fix });
        if (sim.outOfGasT6Pct >= 20) add(Math.min(8, Math.round(sim.outOfGasT6Pct / 5)), 'gás', `Sem mágica na mão no fim do T6 em ${sim.outOfGasT6Pct}% das partidas simuladas.`, 'Mais compra recorrente e payoffs; menos ramp/peças que só preparam.');
        if (sim.deadTurnsT2toT5 >= 0.4) add(Math.min(8, Math.round(sim.deadTurnsT2toT5 * 10)), 'fluidez', `${sim.deadTurnsT2toT5} turno(s) sem jogar nada entre o T2 e o T5 (simulação).`, 'Mais jogadas de MV ≤ 2 e menos cartas caras sem função.');
        if (sim.colorScrewT4Pct >= 15) add(6, 'mana', `Faltou alguma cor no T4 em ${sim.colorScrewT4Pct}% das partidas.`, 'Mais fontes da cor que falta (duais, ramp que busca a cor) ou menos símbolos pesados.');
        if (sim.screwT4Pct >= 15) add(6, 'mana', `Travou com ≤ 2 terrenos no T4 em ${sim.screwT4Pct}% das partidas.`, 'Mais terrenos ou ramp de MV ≤ 2.');
        if (engine.closers.count < 5) add(5, 'plano', `Só ${engine.closers.count} carta(s) que fecham o jogo (finalizadores, corpos grandes, pump/evasão em massa, dreno).`, 'Garanta 5–8 formas de fechar o jogo além do comandante.');
        for (const t of engine.themes) if (t.advice) add(t.status === 'poucos payoffs' ? 6 : 4, 'plano', `${t.label}: ${t.enablers} habilitadores × ${t.payoffs} payoffs (${t.status}).`, t.advice);
        if (engine.rampToGas.ratio != null && engine.rampToGas.ratio > 0.9 && sim.outOfGasT6Pct >= 15) add(5, 'gás', `Ramp ${engine.rampToGas.ramp} para ${engine.rampToGas.gas} cartas de gás (compra, payoffs, finalizadores).`, 'Troque o ramp mais fraco por compra/payoffs.');
        issues.sort((a, b) => b.impact - a.impact);

        // ---- improvement options
        let options = [];
        let poolInfo = null;
        if (getCache()?.hasCards && deck.commanders.length) {
          const toSet = (list) => new Set((list || []).map((n) => normName(resolveLocal(String(n))?.en || String(n))));
          const locked = toSet(args.lock);
          const excluded = toSet(args.exclude);
          const { candidates, rejected } = candidatePool(deck, ctx, tri, { mode, targetBracket, deckCi });
          const pool = candidates.filter((c) => !excluded.has(normName(c.info.name)));
          poolInfo = { candidates: pool.length, rejected };
          const evalByName = new Map(tri.cards.map((c) => [normName(c.name), c]));
          const entries = [...tri.infos.entries()].map(([k, info]) => ({ info, eval: evalByName.get(k), qty: info.qty }));
          const targets = roleTargets(avgRoleCounts(ctx), tri.th.themes);
          const res = improvementOptions({ entries, pool, analysis, sim, engine, th: tri.th, identity, commanderInfo, locked, targets }, { maxSwaps: perOption });
          options = res.options;
          if (res.dropped) notes.push(`${res.dropped} opção(ões) descartada(s): pioravam a simulação sem melhorar as cartas.`);
          for (const o of options) {
            o.apply = { deckId: id, swaps: o.swaps.map((s) => ({ out: s.out.name, in: s.in.name, category: categoryFor(deck, s.out.name, findCard(s.in.name) ? cardInfo({ name: s.in.name, qty: 1, oracle: {} }, findCard(s.in.name)) : null) })), confirm: true };
            for (const s of o.swaps) {
              s.out.pt = ptNameOf(s.out.name) ?? undefined;
              s.out.ligamagicUrl = liga.cardUrl(s.out.name);
              s.in.pt = ptNameOf(s.in.name) ?? undefined;
              s.in.ligamagicUrl = liga.cardUrl(s.in.name);
            }
          }
          if (args.checkOwned && client.hasCredentials && options.length) {
            try {
              const me = await client.me();
              const owned = new Map();
              const names = [...new Set(options.flatMap((o) => o.swaps.map((s) => s.in.name)))];
              let left = 0;
              for (const n of names) {
                if (deadline - Date.now() < 3000) {
                  left++;
                  continue;
                }
                const recs = await ownedRecords(me.id, n, 1);
                owned.set(n, recs.reduce((acc, r) => acc + (Number(r.quantity) || 0), 0));
              }
              for (const o of options) for (const s of o.swaps) if (owned.has(s.in.name)) s.in.owned = owned.get(s.in.name);
              if (left) notes.push(`Posse não conferida para ${left} carta(s) (limite de tempo).`);
            } catch (e) {
              notes.push(`Coleção não consultada: ${e.message}`);
            }
          }
        } else if (!deck.commanders.length) notes.push('Deck sem comandante: sem opções de melhoria (não há identidade de cor para respeitar).');

        // ---- cards: weakest and strongest by the own model
        const nonland = tri.cards.filter((c) => !c.isLand);
        const brief = (c) => ({ name: c.name, pt: ptNameOf(c.name) ?? undefined, ligamagicUrl: liga.cardUrl(c.name), value: c.value, verdict: VERDICT_PT[c.verdict] || c.verdict, mv: c.mv, why: c.why.slice(0, 4).join('; ') });
        const byValue = nonland.slice().sort((a, b) => a.value - b.value || a.name.localeCompare(b.name));
        const best = card.areas.slice().sort((a, b) => b.grade - a.grade)[0];
        const worst = card.areas.slice().sort((a, b) => a.grade - b.grade)[0];
        const diagnosis = [
          `${deck.name} (${deck.commanders.map((c) => c.name).join(' + ') || 'sem comandante'}, ${deckCi || '?'}, ${deck.mainCount} cartas): nota geral ${card.overall}/10 — melhor área ${best.area} (${best.grade}), pior ${worst.area} (${worst.grade}).`,
          engine.themes.length
            ? `Plano: ${engine.themes.map((t) => `${t.label} (${t.enablers} habilitadores × ${t.payoffs} payoffs, ${t.status})`).join('; ')}; ${engine.closers.count} finalizadores; ${engine.drawEngines.count} motores de compra.`
            : `Plano: nenhum tema forte detectado; ${engine.closers.count} finalizadores; ${engine.drawEngines.count} motores de compra.`,
          `Simulação (${sim.games} partidas, quem começa): nota ${sim.score}/100; ${sim.deadTurnsT2toT5} turno(s) morto(s) T2–T5; sem mágica na mão no T6 ${sim.outOfGasT6Pct}%; travou em terreno no T4 ${sim.screwT4Pct}%; faltou cor no T4 ${sim.colorScrewT4Pct}%; comandante até 1 turno depois do custo ${sim.commanderByNextTurnPct ?? '—'}%.`,
          issues.length ? `Principais problemas: ${issues.slice(0, 3).map((x) => x.problem).join(' | ')}` : 'Nenhum problema relevante.',
          options.length ? `Melhor opção: "${options[0].title}" (${options[0].swaps.length} troca(s); simulação ${options[0].effect.simulation.score}; valor das cartas ${options[0].effect.valueDelta >= 0 ? '+' : ''}${options[0].effect.valueDelta}).` : 'Nenhuma opção de melhoria passou nos testes (ou o banco de cartas local está ausente).',
        ];
        const { _scored, _landTarget, cards: _c, summary: _s, issues: _i, ...rest } = analysis;
        return {
          freshness: `Calculado agora (${new Date().toISOString()}) a partir do deck no Archidekt; nenhuma análise, plano ou nota anterior foi usada.`,
          diagnosis,
          scorecard: card,
          options,
          issues: issues.slice(0, 12),
          plan: engine,
          simulation: sim,
          ...rest,
          cards: { weakest: byValue.slice(0, 12).map(brief), strongest: byValue.slice(-10).reverse().map(brief), all: byValue.map((c) => `${c.name} ${c.value} (${c.verdict})`) },
          reference: { edhrec: ctx.base.found ? { slug: ctx.base.slug, decks: ctx.base.numDecks, theme: ctx.theme?.slug ?? null } : { found: false }, candidatePool: poolInfo },
          targetBracket,
          mode,
          next: options.length ? 'Mostre as opções numeradas e peça para o usuário escolher. Aplicar: deck_optimize_apply com o objeto "apply" da opção (ou só algumas trocas), confirm: true, depois do "sim".' : undefined,
          notes,
        };
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
          if (timeLimited) notes.push(`${timeLimited} preço(s) não consultado(s) por limite de tempo; use card_price_br só com essas cartas.`);
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
