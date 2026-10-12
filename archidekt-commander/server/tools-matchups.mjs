// MCP tools for the matchup simulator (Forge engine) and the trigger scan used by the profile agents.

import { findCard, resolveLocal } from './cache.mjs';
import { deckIdentityOf, withinIdentity } from './commander.mjs';
import { forgeNames, forgeStatus, setupStatus, startSetup, toForgeName } from './forge.mjs';
import { jobReport, jobStatus, launchJob, listJobs, MODES, readJob, startJob, stopJob } from './matchups.mjs';
import { ToolError } from './store.mjs';
import { renderScan, scanDeck } from './triggers.mjs';

const lookupCard = (n) => {
  const c = findCard(n);
  if (c) return c;
  const r = resolveLocal(n);
  return r?.en ? findCard(r.en) : null;
};
const RO = { readOnlyHint: true, openWorldHint: true };
const RW = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const posInt = (v, f) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new ToolError('input', `"${f}" deve ser inteiro positivo.`);
  return n;
};

export function buildMatchupTools({ client, getDeck }) {
  return [
    {
      name: 'forge_setup',
      description:
        'Instala (ou mostra o status de) o motor de regras Forge usado por deck_matchups_*: baixa o Java 21 (Temurin) e o Forge para a pasta de dados, ' +
        'em segundo plano (~350 MB, alguns minutos). Chame de novo para acompanhar. force: true reinstala.',
      inputSchema: { type: 'object', properties: { force: { type: 'boolean', default: false }, statusOnly: { type: 'boolean', default: false } } },
      annotations: RW,
      handler: async ({ force = false, statusOnly = false }) => (statusOnly ? setupStatus() : startSetup({ force })),
    },
    {
      name: 'deck_triggers',
      description:
        'Varredura de triggers de um deck (feita em código, pelo texto Oracle do cache local): toda habilidade disparada, efeito de substituição e ' +
        'estática que muda regras, mais papéis de interação (remoção, wipe, counter, proteção). Saída compacta, uma linha por carta — insumo do ' +
        'agente de perfil de oponente e da partida turno a turno.',
      inputSchema: { type: 'object', properties: { deckId: { type: 'integer' } }, required: ['deckId'] },
      annotations: RO,
      handler: async ({ deckId }) => {
        const p = await getDeck(posInt(deckId, 'deckId'));
        const rows = p.rows.filter((r) => r.included);
        const scan = scanDeck(rows, lookupCard);
        return `${renderScan(scan, { title: `${p.name} — ${p.commanders.map((c) => c.name).join(' + ')} (${p.identity || '?'})` })}\n\nContagem por tipo: ${JSON.stringify(scan.counts)}`;
      },
    },
    {
      name: 'deck_matchups_start',
      description:
        'Simula partidas reais de Commander (4 jogadores, motor Forge, IA contra IA) do deck contra decks PÚBLICOS do Archidekt do mesmo bracket, ' +
        'sorteados e ressorteados a cada simulação. Roda em segundo plano no PC do usuário e devolve um jobId. ' +
        'ANTES de chamar, pergunte ao usuário o modo: "moderado" (~30 min, ~160 partidas) ou "sem_limite" (até um horário — passe until "HH:MM" — ou ~8 h). ' +
        '"rapido" (~10 min) serve para teste. Teste A/B de trocas: swaps [{out,in}] + compareTo <jobId base> repete as mesmas mesas e sementes. ' +
        'resumeJobId retoma uma simulação interrompida. Acompanhe com deck_matchups_status e leia com deck_matchups_report.',
      inputSchema: {
        type: 'object',
        properties: {
          deckId: { type: 'integer' },
          bracket: { type: 'integer', minimum: 1, maximum: 5, description: 'Bracket dos oponentes (padrão: o declarado no deck).' },
          mode: { type: 'string', enum: Object.keys(MODES) },
          until: { type: 'string', description: 'Só no sem_limite: horário local para parar, "HH:MM".' },
          games: { type: 'integer', minimum: 4, maximum: 5000, description: 'Sobrescreve o número de partidas do modo.' },
          minutes: { type: 'integer', minimum: 1, maximum: 1440, description: 'Sobrescreve o tempo do modo.' },
          seed: { type: 'integer' },
          swaps: { type: 'array', maxItems: 8, items: { type: 'object', properties: { out: { type: 'string' }, in: { type: 'string' } }, required: ['out', 'in'] } },
          compareTo: { type: 'string', description: 'jobId da simulação base (para o A/B).' },
          resumeJobId: { type: 'string' },
        },
      },
      annotations: RW,
      handler: async ({ deckId, bracket, mode, until, games, minutes, seed, swaps = [], compareTo, resumeJobId }) => {
        if (resumeJobId) return { id: resumeJobId, ...startJob(resumeJobId) };
        if (!mode) throw new ToolError('input', 'Informe "mode" (pergunte ao usuário: moderado ou sem_limite).');
        if (!forgeStatus().ready) throw new ToolError('setup', 'O Forge ainda não está instalado. Rode forge_setup e espere terminar (forge_setup statusOnly mostra o progresso).');
        if (until && mode !== 'sem_limite') throw new ToolError('input', '"until" só vale no modo sem_limite.');
        const target = await getDeck(posInt(deckId, 'deckId'));
        const b = bracket ?? target.edhBracket;
        if (!b) throw new ToolError('input', 'O deck não tem bracket declarado no Archidekt: informe "bracket".');
        if (swaps.length) {
          if (!compareTo) throw new ToolError('input', 'Para testar trocas, passe compareTo com o jobId da simulação do deck atual.');
          const base = readJob(compareTo);
          if (base.target.id !== target.id) throw new ToolError('input', 'compareTo é de outro deck.');
          if (swaps.length > 4) throw new ToolError('input', 'No máximo 4 trocas por pacote.');
          const ident = deckIdentityOf(target, (n) => findCard(n));
          for (const s of swaps) {
            const c = lookupCard(s.in);
            if (!c) throw new ToolError('input', `Carta desconhecida: ${s.in}.`);
            if (!withinIdentity(c.ci, ident)) throw new ToolError('input', `${c.name} está fora da identidade de cor do deck.`);
            if (!toForgeName(c.name, forgeNames())) throw new ToolError('input', `${c.name} não existe no Forge.`);
            s.in = c.name;
          }
        }
        return launchJob({ client, getDeck, target, bracket: b, mode, games, minutes, until, seed, swaps, compareTo: compareTo || null });
      },
    },
    {
      name: 'deck_matchups_status',
      description: 'Status de uma simulação (partidas feitas, previsão, prazo). Sem jobId: lista as simulações.',
      inputSchema: { type: 'object', properties: { jobId: { type: 'string' } } },
      annotations: RO,
      handler: async ({ jobId }) => (jobId ? jobStatus(jobId) : { jobs: listJobs().slice(0, 20) }),
    },
    {
      name: 'deck_matchups_report',
      description:
        'Relatório agregado de uma simulação (funciona com ela ainda rodando): taxa de vitória com intervalo de 95%, por assento e por mesa, ' +
        'causas de derrota, quem mata e quais cartas mais machucam, MVP e cartas mortas, tempo (terrenos e mágicas até a R4) e partidas-chave ' +
        'resumidas (uma linha por rodada) para escolher o que reencenar turno a turno. No A/B traz a comparação com a base.',
      inputSchema: { type: 'object', properties: { jobId: { type: 'string' }, keyGames: { type: 'integer', minimum: 0, maximum: 6, default: 4 } }, required: ['jobId'] },
      annotations: RO,
      handler: async ({ jobId, keyGames = 4 }) => jobReport(jobId, { keyGameCount: keyGames }),
    },
    {
      name: 'deck_matchups_stop',
      description: 'Para uma simulação em andamento (o que já terminou fica no relatório).',
      inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
      annotations: RW,
      handler: async ({ jobId }) => stopJob(jobId),
    },
  ];
}
