// Tools: per-card evaluation (own model + EDHREC reference), deck optimizer (local search + Monte Carlo
// goldfish), apply-after-approval, and the goldfish simulator on its own.
// Nothing is stored between calls: deck_optimize returns its swaps and deck_optimize_apply receives them back.

import { cardInfo, rolePt } from './analysis.mjs';
import { findCard, getCache, ptNameOf, resolveLocal, startUpdate } from './cache.mjs';
import { deckIdentityOf, withinIdentity } from './commander.mjs';
import * as liga from './ligamagic.mjs';
import { optimize, replay, roleTargets } from './optimizer.mjs';
import { envInt, normName, ToolError } from './store.mjs';
import { avgRoleCounts, candidatePool, simulateInfos } from './improve.mjs';
import { fetchCardPages, infoFromRecord, loadContext, MODE_ALIASES, triangulateDeck, VERDICT_PT } from './triangulate.mjs';

const RO = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
const inputError = (m) => new ToolError('input', m);
const budgetMs = () => envInt('ARCHIDEKT_TOOL_BUDGET_MS', 40_000);

function intArg(v, field, { min = 1, max = 1e10, dflt } = {}) {
  if (v === undefined || v === null) {
    if (dflt !== undefined) return dflt;
    throw inputError(`"${field}" é obrigatório.`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw inputError(`"${field}" deve ser inteiro entre ${min} e ${max}.`);
  return n;
}

function modeArg(m) {
  if (m == null) return 'equilibrio';
  const v = MODE_ALIASES[String(m).trim().toLowerCase()];
  if (!v) throw inputError('mode deve ser "equilibrio", "forca" ou "tema".');
  return v;
}

/** Short PT summary of a triangulated card. */
function brief(e) {
  return { name: e.name, pt: ptNameOf(e.name) ?? undefined, ligamagicUrl: liga.cardUrl(e.name), value: e.value, verdict: VERDICT_PT[e.verdict] || e.verdict, confidence: e.confidence, why: e.why.join('; ') };
}

const CORE = ['ramp', 'draw', 'removal', 'wipe', 'protection', 'recursion'];
function countRoles(pairs) {
  const out = {};
  for (const [info, qty] of pairs) if (!info.isLand) for (const r of info.roles) if (CORE.includes(r)) out[rolePt(r)] = (out[rolePt(r)] || 0) + qty;
  return out;
}
function afterInfos(entries, swaps) {
  const m = new Map(entries.map((e) => [normName(e.info.name), [e.info, e.qty]]));
  for (const s of swaps) {
    const cur = m.get(s.out.k);
    if (cur) cur[1] > 1 ? (cur[1] -= 1) : m.delete(s.out.k);
    m.set(s.in.k, [s.in.info, 1]);
  }
  return [...m.values()];
}

const ROLE_CATS = { ramp: ['ramp'], draw: ['draw', 'card draw', 'card advantage', 'compra'], removal: ['removal', 'remocao'], wipe: ['board wipe', 'wipe', 'wipes', 'removal'], protection: ['protection', 'protecao'], recursion: ['recursion', 'recursao'], tokens: ['tokens'], landfall: ['landfall'], 'sac-outlet': ['sac outlet', 'sacrifice'], counter: ['counterspell', 'counters'], tutor: ['tutor', 'tutors'] };

/**
 * Category for a card that comes into the deck: lands go with the deck's lands; other cards go to a deck
 * category named after their main role, else to the category of the card that leaves.
 */
export function categoryFor(deck, outName, inInfo) {
  const catOf = (n) => deck.rows.find((r) => r.included && normName(r.name) === normName(n))?.category ?? null;
  const outRow = deck.rows.find((r) => r.included && normName(r.name) === normName(outName));
  const outIsLand = /\bland\b/i.test(String(outRow?.type || '').split('—')[0]);
  if (inInfo?.isLand) {
    const landCat = deck.rows.find((r) => r.included && /\bland\b/i.test(String(r.type).split('—')[0]) && !r.isCommander)?.category ?? null;
    return landCat || (outIsLand ? catOf(outName) : null);
  }
  const deckCats = new Map(deck.categories.filter((c) => c.included && !c.premier).map((c) => [normName(c.name), c.name]));
  const roles = inInfo?.roles instanceof Set ? inInfo.roles : new Set(inInfo?.roles || []);
  for (const r of ['ramp', 'draw', 'removal', 'wipe', 'protection', 'recursion', 'tutor', 'landfall', 'tokens', 'sac-outlet']) {
    if (!roles.has(r)) continue;
    for (const n of ROLE_CATS[r] || []) if (deckCats.has(n)) return deckCats.get(n);
  }
  return outIsLand ? null : catOf(outName);
}

/** ctx: {client, getDeck, ownedRecords, applyDeckChanges} from tools.mjs */
export function buildOptimizeTools(ctxTools) {
  const { client, getDeck, ownedRecords, applyDeckChanges } = ctxTools;

  /** Load deck + EDHREC sources + triangulation (+ card pages for doubtful cards when deep). */
  async function prepare(id, { targetBracket, theme, mode, plan, deep, deadline, deepMax = 20, deck: given = null }) {
    const deck = given || (await getDeck(id));
    if (!deck.commanders.length) throw inputError('Deck sem comandante (categoria Commander): não há como triangular com o EDHREC.');
    const ctx = await loadContext(deck, { targetBracket, theme, deadline });
    let tri = triangulateDeck(deck, ctx, { lookup: findCard, mode, targetBracket, plan });
    let deepInfo = null;
    if (deep) {
      const doubtful = tri.cards.filter((c) => !c.isLand && ['duvidosa', 'corte', 'aposta'].includes(c.verdict) || (!c.isLand && c.confidence === 'baixa')).sort((a, b) => a.value - b.value).map((c) => c.name);
      if (doubtful.length) {
        deepInfo = await fetchCardPages(ctx, doubtful, { deadline: deadline - 6000, max: deepMax });
        tri = triangulateDeck(deck, ctx, { lookup: findCard, mode, targetBracket, plan });
        deepInfo.doubtful = doubtful.length;
      }
    }
    return { deck, ctx, tri, deepInfo };
  }

  function themeReport(ctx) {
    return {
      detected: ctx.theme ? { slug: ctx.theme.slug, name: ctx.theme.name, decks: ctx.theme.decks } : null,
      ranking: (ctx.themeRanking || []).map((t) => ({ theme: t.name, slug: t.slug, affinity: t.affinity, cardsInTheme: t.cardsInTheme, decks: t.decks })),
      available: (ctx.base.themes || []).slice(0, 10).map((t) => `${t.name} (${t.slug}, ${t.decks ?? '?'} decks)`),
    };
  }

  function sourcesReport(ctx) {
    return {
      commander: ctx.base.found ? { slug: ctx.base.slug, decks: ctx.base.numDecks } : { found: false, ...(ctx.base.error ? { error: ctx.base.error } : {}) },
      theme: ctx.theme ? { slug: ctx.theme.slug, decks: ctx.theme.decks } : null,
      bracket: ctx.bracket ? { slug: ctx.bracket.slug, decks: ctx.bracket.decks } : null,
      averageDeck: ctx.avg ? { variant: ctx.avg.variant ?? 'geral', cards: ctx.avg.cards.size } : null,
      combos: ctx.combos?.length ?? 0,
      cardPages: [...ctx.cardPages.values()].filter((p) => p.found).length,
    };
  }

  const simulate = (infos, commanderInfo, identity, opts) => simulateInfos(infos, commanderInfo, identity, opts);

  function commanderInfoOf(deck) {
    const c = deck.commanders[0];
    return c ? cardInfo(c, findCard(c.name)) : null;
  }

  async function resolveNames(list) {
    const out = new Set();
    const unresolved = [];
    for (const n of list || []) {
      const loc = resolveLocal(String(n));
      if (loc?.en) out.add(normName(loc.en));
      else {
        out.add(normName(n));
        if (getCache()?.hasCards) unresolved.push(n);
      }
    }
    return { set: out, unresolved };
  }

  const triangulateTool = {
    name: 'deck_triangulate',
    description:
      'Avalia CADA carta do deck com um modelo próprio — função (ramp/compra/remoção…), custo de mana, FLUIDEZ (barata, instantânea, compra/filtra, flexível, sem custo de cor pesado, não trava na mão) e sinergia de texto com o comandante — e usa o EDHREC só como referência (comandante, tema detectado, bracket, deck médio e popularidade global contam como um único voto e ~20% do valor). Devolve para cada carta: valor 0–100, nota do modelo próprio, veredito (núcleo, sinergia, staple/função, aposta pessoal, duvidosa, corte provável), confiança (quantas fontes concordam) e os motivos. O EDHREC sozinho nunca manda cortar uma carta. deep=true busca a página individual das cartas duvidosas no EDHREC (≈1 s cada, sempre ao vivo — nada fica em cache entre chamadas).',
    inputSchema: {
      type: 'object',
      properties: {
        deckId: { type: 'integer' },
        targetBracket: { type: 'integer', minimum: 1, maximum: 5 },
        theme: { type: 'string', description: 'Forçar um tema do EDHREC (ex.: "landfall", "artifacts"); por padrão é detectado.' },
        mode: { type: 'string', enum: ['equilibrio', 'forca', 'tema'], default: 'equilibrio' },
        plan: { type: 'string', description: 'Plano de jogo em poucas palavras, refina a sinergia de texto.' },
        deep: { type: 'boolean', default: true },
        onlyVerdicts: { type: 'array', items: { type: 'string', enum: ['nucleo', 'sinergia', 'staple', 'aposta', 'duvidosa', 'corte', 'terreno'] }, description: 'Filtrar a lista por veredito.' },
      },
      required: ['deckId'],
    },
    annotations: RO,
    handler: async (args) => {
      const id = intArg(args.deckId, 'deckId');
      const targetBracket = args.targetBracket != null ? intArg(args.targetBracket, 'targetBracket', { max: 5 }) : null;
      const mode = modeArg(args.mode);
      const deadline = Date.now() + budgetMs();
      const { deck, ctx, tri, deepInfo } = await prepare(id, { targetBracket, theme: args.theme, mode, plan: args.plan, deep: args.deep !== false, deadline });
      let cards = tri.cards.slice().sort((a, b) => a.value - b.value || a.name.localeCompare(b.name));
      if (Array.isArray(args.onlyVerdicts) && args.onlyVerdicts.length) cards = cards.filter((c) => args.onlyVerdicts.includes(c.verdict));
      const nonland = tri.cards.filter((c) => !c.isLand);
      const notes = [...ctx.notes];
      if (!getCache()?.hasCards) notes.push('Cache local de cartas ausente: funções e rank vêm só do Archidekt/texto (rode cards_cache_update).');
      if (deepInfo?.skipped) notes.push(`${deepInfo.skipped} página(s) de carta do EDHREC não foram consultadas (limite de tempo da chamada).`);
      const counts = Object.fromEntries(Object.entries(tri.counts).map(([k, v]) => [VERDICT_PT[k] || k, v]));
      return {
        deck: { id: deck.id, name: deck.name, commanders: ctx.commanders, identity: deck.identity, count: deck.mainCount },
        mode,
        targetBracket,
        sources: sourcesReport(ctx),
        theme: themeReport(ctx),
        summary: [
          `${nonland.length} cartas não-terreno trianguladas com ${sourcesReport(ctx).commander.decks ?? 0} decks de referência.`,
          `Vereditos: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}.`,
          ctx.theme ? `Tema detectado: ${ctx.theme.name} (${ctx.theme.slug}).` : 'Nenhum tema do EDHREC se destaca: o deck segue o "genérico" do comandante.',
          `Valor médio (não-terreno): ${Math.round(nonland.reduce((s, c) => s + c.value, 0) / Math.max(1, nonland.length))}.`,
        ],
        verdicts: counts,
        cards: cards.map((c) => ({
          name: c.name,
          pt: ptNameOf(c.name) ?? undefined,
          value: c.value,
          verdict: c.verdict,
          verdictPt: VERDICT_PT[c.verdict],
          confidence: c.confidence,
          agreement: c.agreement,
          votes: c.votes.map((v) => `${v.source}: ${v.vote}`).join(' | ') || undefined,
          components: c.components,
          why: c.why.join('; '),
          mv: c.mv,
          type: c.type,
          ...(c.qty > 1 ? { qty: c.qty } : {}),
        })),
        notes,
      };
    },
  };

  const optimizeTool = {
    name: 'deck_optimize',
    description:
      'Otimizador algorítmico do deck (NÃO altera nada), focado em deixar o deck melhor e mais fluido — menos mãos travadas e turnos mortos. Avalia as cartas com o modelo próprio (função, custo, fluidez, sinergia de texto; EDHREC só como referência), monta um pool de candidatas de várias fontes (listas do EDHREC, busca por função, ramp/compra/remoção baratas e cartas que conversam com o texto do comandante no banco local de cartas, motores de compra e payoffs/habilitadores do tema) — SEMPRE dentro da identidade de cor do comandante, legais e no bracket alvo — e roda trocas 1-por-1 que maximizam: valor das cartas + cobertura de funções + curva suave (cartas caras demais pesam mais) + fontes de cor + consistência (mão inicial, terrenos no tempo, ramp/compra cedo, jogadas baratas, poucas cartas caras presas). Terrenos na faixa calculada pelo próprio deck (MV médio, ramp barato). Confere com 2000 partidas simuladas (mulligan, turnos mortos, mana desperdiçada, mana travada, comandante no turno, compra resolvendo) e desfaz trocas que pioram a fluidez. Cartas acima do bracket alvo saem primeiro, a menos que estejam em lock. Devolve cada troca com ganho e motivo e o objeto "apply" para deck_optimize_apply (nada fica salvo). Mostre o plano e só aplique depois do "sim".',
    inputSchema: {
      type: 'object',
      properties: {
        deckId: { type: 'integer' },
        targetBracket: { type: 'integer', minimum: 1, maximum: 5, description: 'Bracket alvo: bloqueia Game Changers, MLD, turnos extras e combos acima dele. Padrão: o declarado no deck.' },
        maxSwaps: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
        mode: { type: 'string', enum: ['equilibrio', 'forca', 'tema'], default: 'equilibrio' },
        theme: { type: 'string', description: 'Tema a seguir (padrão: detectado).' },
        plan: { type: 'string' },
        lock: { type: 'array', items: { type: 'string' }, description: 'Cartas que não podem sair (PT ou EN).' },
        exclude: { type: 'array', items: { type: 'string' }, description: 'Cartas que não podem entrar (PT ou EN).' },
        minGain: { type: 'number', minimum: 0, default: 2, description: 'Ganho mínimo da função objetivo para aceitar uma troca.' },
        checkOwned: { type: 'boolean', default: false, description: 'Marca quais entradas você já tem na coleção (1 consulta por carta).' },
        withPrices: { type: 'boolean', default: false, description: 'Preço LigaMagic das entradas (≥2 s por carta).' },
        deep: { type: 'boolean', default: true },
      },
      required: ['deckId'],
    },
    annotations: RO,
    handler: async (args) => {
      const id = intArg(args.deckId, 'deckId');
      const maxSwaps = intArg(args.maxSwaps, 'maxSwaps', { max: 25, dflt: 10 });
      const mode = modeArg(args.mode);
      const minGain = args.minGain != null ? Number(args.minGain) : 2;
      if (!(minGain >= 0)) throw inputError('minGain deve ser ≥ 0.');
      if (!getCache()?.hasCards) {
        const r = startUpdate({ reason: 'deck_optimize' });
        throw new ToolError('not_configured', `O otimizador precisa do cache local de cartas (para avaliar as candidatas). ${r.started ? 'Atualização iniciada agora em segundo plano' : 'Atualização em andamento'} — acompanhe com cards_cache_status e tente de novo em alguns minutos.`);
      }
      const deadline = Date.now() + budgetMs();
      const deck0 = await getDeck(id);
      const targetBracket = args.targetBracket != null ? intArg(args.targetBracket, 'targetBracket', { max: 5 }) : deck0.edhBracket ?? null;
      const { deck, ctx, tri, deepInfo } = await prepare(id, { targetBracket, theme: args.theme, mode, plan: args.plan, deep: args.deep !== false, deadline, deepMax: 12, deck: deck0 });
      const notes = [...ctx.notes];
      const locked = (await resolveNames(args.lock)).set;
      for (const c of tri.cards) if (c.bracketBlock && locked.has(normName(c.name))) notes.push(`${c.name} está em lock mas ${c.bracketBlock}.`);
      const excluded = (await resolveNames(args.exclude)).set;
      const { candidates: pool0, rejected } = candidatePool(deck, ctx, tri, { mode, targetBracket, deckCi: deckIdentityOf(deck, findCard) });
      const pool = pool0.filter((c) => !excluded.has(normName(c.info.name)));
      const evalByName = new Map(tri.cards.map((c) => [normName(c.name), c]));
      const entries = [...tri.infos.entries()].map(([k, info]) => ({ info, eval: evalByName.get(k), qty: info.qty }));
      const deckCi = deckIdentityOf(deck, findCard);
      const identity = deckCi && deckCi !== 'C' ? [...deckCi] : [];
      const nonland = entries.filter((e) => !e.info.isLand);
      const avgMv = nonland.reduce((s, e) => s + e.info.mv * e.qty, 0) / Math.max(1, nonland.reduce((s, e) => s + e.qty, 0));
      const commanderInfo = commanderInfoOf(deck);
      // role targets: generic, adapted to what decks of this commander actually run (EDHREC average deck)
      const avgCounts = avgRoleCounts(ctx);
      const targets = roleTargets(avgCounts, tri.th.themes);
      const run = (opts) => optimize(entries, pool, { maxSwaps, minGain, locked, targetBracket, ctx, identity, deckIdentity: deckCi, avgMv, themes: tri.th.themes, targets, ...opts });
      let res = run({});
      // last guard: nothing outside the commander's color identity ever reaches the plan
      const offColor = res.swaps.filter((s) => !withinIdentity(findCard(s.in.name)?.ci ?? s.in.ci ?? 'WUBRG', deckCi));
      if (offColor.length) {
        notes.push(`Removidas ${offColor.length} sugestão(ões) fora da identidade de cor ${deckCi}: ${offColor.map((s) => s.in.name).join(', ')}.`);
        res = { ...res, swaps: res.swaps.filter((s) => !offColor.includes(s)) };
      }

      // Monte Carlo check: undo the most recent swaps while they make the deck run worse.
      const beforeSim = simulate(entries.map((e) => ({ ...e.info, qty: e.qty })), commanderInfo, identity);
      const simOf = (swaps) => {
        const infos = entries.map((e) => ({ ...e.info, qty: e.qty }));
        for (const s of swaps) {
          const i = infos.findIndex((x) => normName(x.name) === s.out.k);
          if (i >= 0) {
            if (infos[i].qty > 1) infos[i] = { ...infos[i], qty: infos[i].qty - 1 };
            else infos.splice(i, 1);
          }
          infos.push({ ...s.in.info, qty: 1 });
        }
        return simulate(infos, commanderInfo, identity);
      };
      let swaps = res.swaps;
      let afterSim = simOf(swaps);
      const undone = [];
      while (swaps.length && afterSim.score < beforeSim.score - 0.3) {
        // drop the swap whose removal helps the simulation most
        let best = null;
        for (let i = 0; i < swaps.length; i++) {
          if (swaps[i].forced) continue; // bracket swaps stay
          const s = simOf(swaps.filter((_, j) => j !== i));
          if (!best || s.score > best.sim.score) best = { i, sim: s };
        }
        if (!best) break;
        undone.push(swaps[best.i]);
        swaps = swaps.filter((_, j) => j !== best.i);
        afterSim = best.sim;
      }
      if (undone.length) {
        notes.push(`${undone.length} troca(s) desfeita(s) pela simulação (pioravam a consistência): ${undone.map((s) => `-${s.out.name} +${s.in.name}`).join(', ')}.`);
        // re-score the swaps that were kept
        const rp = replay(entries, swaps, { ctx, identity, avgMv, themes: tri.th.themes, targets });
        swaps = rp.swaps;
        res = { ...res, before: rp.before, after: rp.after };
      }

      // ownership / prices for the cards that come in
      if (args.checkOwned && client.hasCredentials && swaps.length) {
        try {
          const me = await client.me();
          for (const s of swaps) {
            if (deadline - Date.now() < 4000) break;
            const recs = await ownedRecords(me.id, s.in.name, 1);
            s.owned = recs.reduce((acc, r) => acc + (Number(r.quantity) || 0), 0);
          }
        } catch (e) {
          notes.push(`Coleção não consultada: ${e.message}`);
        }
      }
      if (args.withPrices && swaps.length) {
        for (const s of swaps) {
          if (deadline - Date.now() < 3000) {
            notes.push('Alguns preços ficaram de fora (limite de tempo); use card_price_br.');
            break;
          }
          try {
            const p = await liga.priceFor({ en: s.in.name, pt: ptNameOf(s.in.name), query: ptNameOf(s.in.name) || s.in.name }, { deadline });
            s.priceBRL = p.found ? { min: p.min, avg: p.avg, fetchedAt: p.fetchedAt } : { found: false };
          } catch (e) {
            s.priceBRL = { error: e.message };
            if (e.kind === 'blocked') break;
          }
        }
      }

      const planSwaps = swaps.map((s) => ({ out: s.out.name, in: s.in.name, category: categoryFor(deck, s.out.name, s.in.info) }));
      if (!targetBracket) notes.push('Sem bracket alvo (o deck não declara um): Game Changers, MLD e combos não foram restringidos. Informe targetBracket para limitar.');
      if (deepInfo?.skipped) notes.push(`${deepInfo.skipped} página(s) de carta do EDHREC não consultadas (tempo); repetir melhora a triangulação.`);
      const total = Math.round(swaps.reduce((s, x) => s + x.gain, 0) * 10) / 10;
      const pct = (a, b) => `${a}% → ${b}%`;
      return {
        deck: { id: deck.id, name: deck.name, commanders: ctx.commanders, identity: deck.identity, count: deck.mainCount },
        mode,
        targetBracket,
        theme: themeReport(ctx).detected,
        sources: sourcesReport(ctx),
        summary: [
          swaps.length ? `${swaps.length} troca(s) propostas, ganho total ${total} pontos na função objetivo (${res.before.score} → ${res.after.score}).` : 'Nenhuma troca melhora o deck o suficiente (ganho mínimo não atingido).',
          `Simulação de fluidez (${beforeSim.games} partidas, na mão de quem começa): nota ${beforeSim.score} → ${afterSim.score}; turnos mortos T2–T5 ${beforeSim.deadTurnsT2toT5} → ${afterSim.deadTurnsT2toT5}; mana desperdiçada T2–T6 ${beforeSim.wastedManaT2toT6} → ${afterSim.wastedManaT2toT6}; comandante no turno ${pct(beforeSim.commanderOnCurvePct, afterSim.commanderOnCurvePct)}; 4º terreno no T4 ${pct(beforeSim.landDropOnTimePct.T4, afterSim.landDropOnTimePct.T4)}; mana travada T4 ${pct(beforeSim.screwT4Pct, afterSim.screwT4Pct)}; mulligan ${pct(beforeSim.mulliganPct, afterSim.mulliganPct)}.`,
          `Identidade de cor ${deckCi}: todas as candidatas foram filtradas por ela.`,
          `Terrenos: faixa ${res.landRange[0]}-${res.landRange[1]}. Pool: ${pool.length} candidatas válidas (descartadas: ${Object.entries(rejected).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ') || 'nenhuma'}).`,
        ],
        swaps: swaps.map((s, i) => ({
          n: i + 1,
          out: brief(s.out.eval),
          in: { ...brief(s.in.eval), sources: pool.find((c) => normName(c.info.name) === s.in.k)?.sources, ...(s.owned != null ? { owned: s.owned } : {}), ...(s.priceBRL ? { priceBRL: s.priceBRL } : {}) },
          gain: s.gain,
          ...(s.forced ? { forcedBy: `obrigatória: ${s.forced}` } : {}),
          gainParts: s.parts,
          category: planSwaps[i].category,
        })),
        objective: { before: res.before, after: res.after },
        colorIdentity: deckCi,
        roleTargets: Object.fromEntries(Object.entries(targets).filter(([r]) => ['ramp', 'draw', 'removal', 'wipe', 'protection', 'recursion'].includes(r)).map(([r, [a, b]]) => [rolePt(r), `${a}-${b}${avgCounts?.[r] != null ? ` (referência: deck médio EDHREC usa ${avgCounts[r]})` : ''}`])),
        roles: { before: countRoles(entries.map((e) => [e.info, e.qty])), after: countRoles(afterInfos(entries, swaps)) },
        simulation: { before: beforeSim, after: afterSim },
        apply: swaps.length ? { deckId: id, swaps: planSwaps, confirm: true } : undefined,
        next: swaps.length ? 'Para aplicar (depois do "sim"): deck_optimize_apply com o objeto "apply" acima — ou só as trocas escolhidas da lista "swaps". Nada fica salvo: o plano vive só nesta resposta.' : undefined,
        notes,
      };
    },
  };

  const applyTool = {
    name: 'deck_optimize_apply',
    description:
      'Aplica no Archidekt trocas 1-por-1 vindas de deck_optimize ("apply.swaps") ou de uma opção de melhoria do deck_analyze ("options[].apply.swaps"): lista de {out, in, category?}. Nada é lido de disco — passe as trocas escolhidas. Exige confirm: true — só depois do "sim" do usuário. Confere que cada carta a sair ainda está no deck e a que entra ainda não está (terrenos básicos podem repetir), aplica, relê, verifica e devolve "undo" (como desfazer).',
    inputSchema: {
      type: 'object',
      properties: {
        deckId: { type: 'integer' },
        swaps: {
          type: 'array',
          minItems: 1,
          maxItems: 30,
          items: {
            type: 'object',
            properties: {
              out: { type: 'string', description: 'Carta que sai (EN ou PT).' },
              in: { type: 'string', description: 'Carta que entra (EN ou PT).' },
              category: { type: 'string', description: 'Categoria da carta que entra (padrão: categoria da função dela no deck, ou a da carta que sai).' },
            },
            required: ['out', 'in'],
          },
        },
        confirm: { type: 'boolean' },
      },
      required: ['deckId', 'swaps', 'confirm'],
    },
    annotations: WRITE,
    handler: async (args) => {
      const id = intArg(args.deckId, 'deckId');
      if (args.confirm !== true) throw inputError('Aplicar exige confirm: true (mostre as trocas e peça o "sim" do usuário antes).');
      if (!Array.isArray(args.swaps) || !args.swaps.length) throw inputError('"swaps" deve ser uma lista não vazia de {out, in}.');
      if (args.swaps.length > 30) throw inputError('Máximo de 30 trocas por chamada.');
      const chosen = args.swaps.map((s, i) => {
        if (!s || typeof s.out !== 'string' || !s.out.trim() || typeof s.in !== 'string' || !s.in.trim()) throw inputError(`Troca ${i + 1}: informe "out" e "in".`);
        const en = (n) => resolveLocal(n.trim())?.en || n.trim();
        return { n: i + 1, out: en(s.out), in: en(s.in), category: typeof s.category === 'string' && s.category.trim() ? s.category.trim() : null };
      });
      const deck = await getDeck(id);
      const deckCi = deck.commanders.length ? deckIdentityOf(deck, findCard) : null;
      const skipped = [];
      const changes = [];
      const qtyLeft = new Map();
      for (const r of deck.rows) if (r.included) qtyLeft.set(normName(r.name), (qtyLeft.get(normName(r.name)) || 0) + r.qty);
      for (const s of chosen) {
        const ko = normName(s.out);
        const ki = normName(s.in);
        const rec = findCard(s.in);
        const basic = /\bbasic\b/i.test(rec?.type || '');
        if (!(qtyLeft.get(ko) > 0)) {
          skipped.push({ n: s.n, swap: `-${s.out} +${s.in}`, reason: `${s.out} não está no deck` });
          continue;
        }
        if (qtyLeft.get(ki) > 0 && !basic) {
          skipped.push({ n: s.n, swap: `-${s.out} +${s.in}`, reason: `${s.in} já está no deck` });
          continue;
        }
        if (deckCi && rec && !withinIdentity(rec.ci, deckCi)) {
          skipped.push({ n: s.n, swap: `-${s.out} +${s.in}`, reason: `${s.in} está fora da identidade de cor ${deckCi}` });
          continue;
        }
        const row = deck.rows.find((r) => r.included && normName(r.name) === ko);
        changes.push({ action: 'remove', deckRelationId: row.relId, quantity: 1 });
        const category = s.category || categoryFor(deck, s.out, rec ? infoFromRecord(rec) : null);
        changes.push({ action: 'add', cardName: s.in, ...(category ? { category } : {}) });
        qtyLeft.set(ko, qtyLeft.get(ko) - 1);
        qtyLeft.set(ki, (qtyLeft.get(ki) || 0) + 1);
      }
      if (!changes.length) return { deckId: id, applied: [], skipped, note: 'Nada a aplicar.' };
      const result = await applyDeckChanges(id, changes);
      return { ...result, skipped };
    },
  };

  const simulateTool = {
    name: 'deck_simulate',
    description:
      'Simulação Monte Carlo "goldfish" do deck (padrão 2000 partidas, semente fixa): taxa de mulligan, descida de terreno no tempo (T1–T5), mana média por turno, comandante no turno certo, ramp até o T3, mana travada no T4 (terrenos e cores), flood no T6, cartas presas na mão no T5 e mana gasta até o T6, com uma nota 0–100. Opcional: trocas hipotéticas (remove/add) para comparar antes/depois sem mexer no deck.',
    inputSchema: {
      type: 'object',
      properties: {
        deckId: { type: 'integer' },
        games: { type: 'integer', minimum: 200, maximum: 20000, default: 2000 },
        seed: { type: 'integer', default: 42 },
        remove: { type: 'array', items: { type: 'string' } },
        add: { type: 'array', items: { type: 'string' } },
      },
      required: ['deckId'],
    },
    annotations: RO,
    handler: async (args) => {
      const id = intArg(args.deckId, 'deckId');
      const games = intArg(args.games, 'games', { min: 200, max: 20000, dflt: 2000 });
      const seed = Number.isInteger(args.seed) ? args.seed : 42;
      const deck = await getDeck(id);
      const identity = deck.identity && deck.identity !== 'C' ? [...deck.identity] : [];
      const infos = new Map();
      for (const r of deck.rows) {
        if (!r.included || r.isCommander) continue;
        const k = normName(r.name);
        if (infos.has(k)) infos.get(k).qty += r.qty;
        else infos.set(k, cardInfo(r, findCard(r.name)));
      }
      const cmd = commanderInfoOf(deck);
      const base = simulate([...infos.values()], cmd, identity, { games, seed });
      const out = { deck: { id: deck.id, name: deck.name, count: deck.mainCount }, simulation: base, assumptions: 'Na mão de quem começa (sem compra no T1); 1 terreno por turno; mulligan se a mão tiver <2 ou >5 terrenos (o 1º é grátis); ramp duradouro = +mana; buscar terreno = terreno virado; compra resolve (pontual compra N; motores ~1 carta a cada 2 turnos). Turno morto = turno 2–5 sem conjurar nada.' };
      if ((args.remove || []).length || (args.add || []).length) {
        const alt = new Map([...infos.entries()].map(([k, v]) => [k, { ...v }]));
        const missing = [];
        for (const n of args.remove || []) {
          const loc = resolveLocal(n);
          const k = normName(loc?.en || n);
          const it = alt.get(k);
          if (!it) missing.push(`${n} (não está no deck)`);
          else if (it.qty > 1) it.qty--;
          else alt.delete(k);
        }
        for (const n of args.add || []) {
          const loc = resolveLocal(n);
          const rec = findCard(loc?.en || n);
          if (!rec) missing.push(`${n} (fora do cache)`);
          else if (deck.commanders.length && !withinIdentity(rec.ci, deckIdentityOf(deck, findCard))) missing.push(`${n} (fora da identidade de cor ${deckIdentityOf(deck, findCard)})`);
          else alt.set(normName(rec.name), { ...infoFromRecord(rec), qty: 1 });
        }
        const what = simulate([...alt.values()], cmd, identity, { games, seed });
        out.whatIf = { simulation: what, delta: Math.round((what.score - base.score) * 10) / 10, cards: [...alt.values()].reduce((s, x) => s + x.qty, 0) + (cmd ? 1 : 0) };
        if (missing.length) out.whatIf.ignored = missing;
      }
      return out;
    },
  };

  return [triangulateTool, optimizeTool, applyTool, simulateTool];
}
