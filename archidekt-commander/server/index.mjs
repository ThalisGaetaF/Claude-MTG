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
    'cache local de cartas (Scryfall) com nomes em português, preços em reais (LigaMagic), análise profunda de decks ' +
    '(deck_analyze → deck_cut_candidates → deck_upgrade_candidates), triangulação de cada carta com o EDHREC (deck_triangulate), ' +
    'otimizador algorítmico com simulação Monte Carlo (deck_optimize → revisar → deck_optimize_apply após o "sim"; deck_simulate), ' +
    'snapshots e uma wiki pessoal em Markdown. ' +
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
