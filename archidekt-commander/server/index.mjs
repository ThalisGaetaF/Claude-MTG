#!/usr/bin/env node
// Entry point: archidekt-commander MCP server (stdio). Zero dependencies, Node 18+.

import { shouldAutoUpdate, startUpdate } from './cache.mjs';
import { ArchidektClient, log } from './client.mjs';
import { startMcpServer } from './mcp.mjs';
import { homeDir, VERSION } from './store.mjs';
import { buildTools } from './tools.mjs';

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  log(`Node.js ${process.versions.node} é antigo demais; instale o Node 18 ou mais novo.`);
  process.exit(1);
}

const client = new ArchidektClient();
log(client.hasCredentials ? `credentials found (${client.credentials.source})` : 'no credentials configured: only public read tools will work');
log(`data folder: ${homeDir()}`);

startMcpServer({
  name: 'archidekt-commander',
  version: VERSION,
  instructions:
    'Ferramentas para ler e editar decks e a coleção do usuário no Archidekt (API não oficial, ~40 req/min), ' +
    'banco local de cartas (Scryfall) com nomes em português, preços em reais (LigaMagic, cache de 24 h por carta), ' +
    'análise completa de decks com opções de melhoria testadas em simulação (deck_analyze → deck_optimize_apply após o "sim"), ' +
    'avaliação de cada carta (deck_triangulate), otimizador algorítmico (deck_optimize) e simulação Monte Carlo (deck_simulate). ' +
    'A análise de deck é sempre feita do zero: nada de análises, planos ou snapshots anteriores é lido ou gravado; só dados de cartas (banco do Scryfall, páginas de carta do EDHREC, preços) ficam em cache. ' +
    'Leia antes de escrever, peça confirmação antes de mudanças, nunca repita escritas às cegas e confira o campo "verification".',
  tools: buildTools(client),
  log,
});

// Refresh the local card cache in the background when missing or older than 7 days.
if (process.env.ARCHIDEKT_NO_AUTO_CACHE !== '1') {
  setTimeout(() => {
    try {
      if (shouldAutoUpdate()) startUpdate({ reason: 'auto (cache ausente ou com mais de 7 dias)' });
    } catch (e) {
      log(`auto cache check failed: ${e.message}`);
    }
  }, 250).unref?.();
}
