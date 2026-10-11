# archidekt-commander

Plugin do Claude (Cowork / Claude desktop) que conecta o Claude à sua conta do [Archidekt](https://archidekt.com) para **ver e editar sua coleção e seus decks**, **criar decks de Commander (EDH)**, validar as regras do formato e sugerir melhorias.

**Novidades da versão 0.6.0 — extensão `.mcpb` (sem instalar Node)**

- `manifest.json` + `.mcpbignore`: o servidor também é empacotado como extensão do Claude desktop (`.mcpb`), que roda com o Node embutido no app. E-mail, senha e pasta de dados são preenchidos na tela de configuração da extensão (senha marcada como sensível).
- Campos opcionais deixados em branco (placeholders `${user_config.*}` não substituídos) são ignorados; o servidor cai no `credentials.json` / pasta padrão.
- Instruções no README da raiz do repositório.

**Versão 0.7.1** — volta o cache de **dados de cartas** (páginas de carta do EDHREC por 7 dias, preços da LigaMagic por 24 h): buscas repetidas ficam instantâneas. Dados do deck continuam sempre ao vivo.

**Novidades da versão 0.7.0 — análise sempre do zero e com opções de melhoria**

- **Nada de cache sobre o deck**: a análise lê o deck e as páginas do comandante no EDHREC ao vivo a cada chamada; não usa nem grava notas da wiki, planos do otimizador ou snapshots. Só **dados de cartas** ficam em cache, porque não dependem do deck: o banco do Scryfall (textos, funções, nomes em PT), as páginas de carta do EDHREC (7 dias) e os preços da LigaMagic (24 h).
- **`deck_analyze` muito mais completo**: diagnóstico com números, **nota 0–10 por área** (base de mana, início de jogo, gás, interação, plano, resiliência, qualidade das cartas), **motor do plano** (habilitadores × payoffs de cada tema, finalizadores, motores de compra, ramp × gás), simulação de 2000 partidas e a avaliação de cada carta pelo mesmo modelo do otimizador.
- **Opções de melhoria prontas**: pacotes de até 4 trocas, cada um mirando um problema (cartas fracas, gás, começo de jogo, curva, interação, plano, base de mana), dentro da identidade de cor, testados na simulação (antes × depois) e ordenados pelo efeito. Para aplicar: `deck_optimize_apply` com as trocas escolhidas.
- **Sem snapshots/planos em disco**: `deck_optimize` devolve as trocas na própria resposta; `deck_optimize_apply` recebe `{out, in}`; toda escrita devolve `undo` (como desfazer). Ferramentas `deck_snapshot*` removidas.
- A wiki só é escrita quando você pede.

**Novidades da versão 0.4.0 — foco em fluidez, EDHREC só como referência, identidade de cor garantida**

- **Modelo próprio de avaliação**: cada carta é julgada pela função, custo, **fluidez** (barata, instantânea, compra/filtra, flexível, sem custo de cor pesado, não trava na mão) e sinergia de texto com o comandante e com os temas que o próprio deck já tem. O EDHREC virou **um voto de referência** (~20% do valor) — sozinho ele nunca manda cortar uma carta.
- **Análise de fluidez** (`deck_analyze.fluidity`): jogadas de MV ≤ 2, topo da curva, cartas caras sem função, exigência de cada cor com a chance de ter as fontes a tempo (comandante incluído), motores de compra, usos para mana sobrando.
- **Otimizador** busca um deck mais fluido: curva suave (cartas caras demais pesam mais), faixa de terrenos calculada pelo próprio deck, metas de função genéricas (EDHREC só ajusta um pouco), penalidade para excesso de uma função, candidatas de várias fontes (não só EDHREC).
- **Simulação** agora resolve a compra de cartas e mede turnos mortos, mana desperdiçada, cartas vistas e "sem cartas" no T6.
- **Sem ajuste contra decks específicos**: removida a checagem do "meta do grupo" (voltron/aristocrats).
- **Identidade de cor é regra dura**: toda sugestão (otimizador, upgrades, "e se") é filtrada pela identidade do comandante; cartas sem identidade confirmada no cache são descartadas; `archidekt_update_deck_cards` recusa adicionar carta fora da identidade no deck principal (Maybeboard continua livre).

**Novidades da versão 0.3.0 — otimizador de deck com o EDHREC**

- **Triangulação de cada carta** (`deck_triangulate`): cada carta do deck é comparada com fontes independentes — página do comandante no EDHREC (sinergia e % de decks), página do **tema detectado automaticamente** (ex.: lands-matter, landfall, +1/+1 counters), página do **bracket** alvo, **deck médio** do EDHREC, popularidade global (página da carta no EDHREC ou rank), função (ramp, compra, remoção…) e sinergia de texto com o comandante. Sai um valor 0–100, um veredito (núcleo, sinergia, staple/função, aposta pessoal, duvidosa, corte provável), a confiança (quantas fontes concordam) e os motivos.
- **Otimizador algorítmico** (`deck_optimize`): busca local de trocas 1-por-1 que maximiza uma função objetivo explícita — valor das cartas + cobertura de funções (metas ajustadas ao deck médio do comandante) + curva perto da do EDHREC + fontes de cor + consistência (probabilidades hipergeométricas). Terrenos ficam na faixa do EDHREC; o bracket é restrição dura (Game Changers, MLD e turnos extras saem primeiro; combos de 2 cartas bloqueados nos brackets 1–2). Modos: `equilibrio` (padrão), `forca`, `tema`. Não altera nada: gera um plano.
- **Simulação Monte Carlo** (`deck_simulate`): 2000 partidas "goldfish" com semente fixa — mulligan, descida de terrenos, comandante no turno, mana travada (terreno e cor), flood, cartas presas, mana gasta. O otimizador usa a simulação para conferir o antes/depois e **desfaz trocas que pioram a consistência**. Também responde "e se eu trocar X por Y?".
- **Aplicar depois do seu OK** (`deck_optimize_apply`): aplica o plano inteiro ou só as trocas escolhidas, com snapshot antes, verificação depois e registro na wiki do deck.
- O Claude revisa o plano do algoritmo e comenta cada troca (o algoritmo é uma segunda opinião, além da análise da IA).

**Versão 0.2.0**

- **Cache local de cartas (Scryfall)** com funções de cada carta (ramp, compra, remoção, wipe, proteção…) e **nomes em português**: você pode falar "Anel Solar", "Relâmpago", "Fera Interior" em qualquer ferramenta.
- **Preços em reais na LigaMagic** (mínimo, médio, máximo e edições).
- **Análise profunda de deck**: funções vs metas, curva, cores, sinergia com o comandante (EDHREC), combos, Game Changers e bracket estimado, e nota 0–100 por carta.
- **Funil de melhoria**: cortes sugeridos → upgrades (primeiro o que você já tem, com preço) → confirmação → aplicar → reanalisar.
- **Snapshots** do deck antes de mudanças (automático com 5+ mudanças) e comparação com a versão atual.
- **Wiki pessoal** em Markdown: uma página por deck (histórico de mudanças, partidas, pontos fracos), anotações do grupo, avaliações de cartas.

Inclui:

- **Servidor MCP `archidekt`** (`server/`) — Node.js puro, sem dependências npm (35 ferramentas).
- **Skill `archidekt-commander`** — instruções de fluxo (ler → analisar → propor tabela IN/OUT → confirmar → gravar → verificar) e referência de deckbuilding.
- **Agente `mtg-commander-expert`** — especialista em Commander que usa as ferramentas.

## Requisitos

- **Node.js 18 ou mais novo no PATH.** Abra o Prompt de Comando ou PowerShell e rode `node -v`. Se não aparecer `v18.x` ou maior, instale a versão LTS em https://nodejs.org e reinicie o Claude.
- Uma conta no Archidekt (só para as ferramentas de leitura privada e de escrita).

## Configurar credenciais (Windows)

A senha **nunca** deve ser colada no chat. Escolha uma opção:

**Opção A — arquivo (recomendado)**

Crie o arquivo `%USERPROFILE%\.archidekt\credentials.json` (ex.: `C:\Users\SeuNome\.archidekt\credentials.json`) — ou `%USERPROFILE%\Projects\archidekt-mcp\credentials.json` — com:

```json
{ "email": "seu-email@exemplo.com", "password": "sua-senha" }
```

No PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.archidekt" | Out-Null
notepad "$env:USERPROFILE\.archidekt\credentials.json"
```

Pode usar `"username"` no lugar de `"email"`. Também é possível apontar para outro arquivo com a variável `ARCHIDEKT_CREDENTIALS_FILE`.

**Opção B — variáveis de ambiente**

```powershell
setx ARCHIDEKT_EMAIL "seu-email@exemplo.com"
setx ARCHIDEKT_PASSWORD "sua-senha"
```

Feche e abra o Claude depois de configurar. Ordem de busca: variáveis de ambiente → `ARCHIDEKT_CREDENTIALS_FILE` → `%USERPROFILE%\.archidekt\credentials.json` → `%USERPROFILE%\Projects\archidekt-mcp\credentials.json`.

Sem credenciais, as ferramentas públicas (buscar cartas, buscar decks, ver decks públicos) continuam funcionando. Peça ao Claude "quem sou eu no Archidekt?" para testar (`archidekt_whoami`).

O token de login fica só na memória do processo; nada é gravado em disco.

## Ferramentas

| Ferramenta | O que faz |
|---|---|
| `archidekt_whoami` | Usuário logado (id, username) |
| `archidekt_list_my_decks` | Seus decks, inclusive privados |
| `archidekt_search_decks` | Busca decks públicos por nome, comandante ou dono |
| `archidekt_get_deck` | Deck completo por categoria (qtd, MV, tipo, ids, set, owned) |
| `archidekt_search_cards` | Busca cartas/impressões, legalidade, identidade de cor, Game Changer |
| `archidekt_get_collection` | Lista a coleção (paginada, filtro por nome) |
| `archidekt_search_collection` | Quantas cópias você tem de cada carta |
| `archidekt_validate_deck` | Checa 100 cartas, singleton, identidade de cor, banidas, comandante, Game Changers |
| `archidekt_create_deck` | Cria deck (privado por padrão) com comandante |
| `archidekt_update_deck_cards` | Adiciona/remove/altera quantidade/move categoria; relê e mostra o diff |
| `archidekt_update_deck_info` | Nome, descrição, privado, bracket |
| `archidekt_delete_deck` | Apaga deck (exige `confirm: true`) |
| `archidekt_collection_add` | Adiciona carta à coleção |
| `archidekt_collection_update` | Altera quantidade/condição/idioma/acabamento de um registro |
| `archidekt_collection_remove` | Remove registros da coleção (exige `confirm: true`) |

Toda escrita relê o Archidekt depois e responde `verified` ou `not verified`. As ferramentas acima aceitam nomes de cartas em português (a tradução usada aparece na resposta).

### Novas ferramentas (0.2.0)

| Ferramenta | O que faz |
|---|---|
| `cards_cache_update` | Atualiza o cache local de cartas em segundo plano (responde na hora) |
| `cards_cache_status` | Andamento, data da última atualização, contagens, tamanho, erros |
| `card_translate` | Traduz nomes PT ⇄ EN (cache → Scryfall → LigaMagic) |
| `card_lookup` | Ficha da carta: nome EN+PT, custo, tipo, texto, funções, legalidade, Game Changer, rank EDHREC |
| `card_search_local` | Busca por função/cores/MV/tipo/texto ("ramp verde até 3 de mana") |
| `card_price_br` | Preços em R$ na LigaMagic (até 30 cartas, com total) |
| `deck_analyze` | Análise completa e nova do deck (nota por área, motor do plano, simulação) + opções de melhoria testadas |
| `deck_cut_candidates` | Cartas candidatas a corte, com motivo |
| `deck_upgrade_candidates` | Sugestões de entrada sempre dentro da identidade de cor (cache + EDHREC como referência), marca as que você tem, preço LigaMagic e qual corte substituem |
| `wiki_list` / `wiki_read` / `wiki_write` / `wiki_search` | Wiki pessoal em Markdown (só quando você pede) |

### Novas ferramentas (0.3.0)

| Ferramenta | O que faz |
|---|---|
| `deck_triangulate` | Valor, veredito, confiança e motivos de cada carta: modelo próprio (função, custo, fluidez, sinergia de texto) + EDHREC como referência |
| `deck_optimize` | Trocas do otimizador global (busca local + simulação), com ganho e motivo de cada troca e o objeto `apply` |
| `deck_optimize_apply` | Aplica as trocas escolhidas (`{out, in}`) — exige `confirm: true`; devolve `undo` |
| `deck_simulate` | Simulação Monte Carlo do deck, com "e se" (remove/add) |

### Como o otimizador decide (0.4)

Objetivo: deck melhor e mais fluido. O EDHREC é referência; quem decide é o modelo próprio.

`F = Σ valor das cartas (terrenos × 0,6) − penalidade de funções − penalidade de curva − penalidade de cores + 2,5 × consistência`

- **Valor**: modelo próprio (função, sinergia de texto, custo, fluidez) + referência (EDHREC e popularidade global, ~24% juntos). Pesos mudam com o modo (`equilibrio`, `forca`, `tema`).
- **Funções**: ramp, compra, remoção, wipes, proteção, recursão — abaixo do mínimo custa `peso × (20·d + 5·d²)`; acima do máximo também custa (deck que só faz ramp fica sem gás). Metas genéricas; o deck médio do EDHREC só empurra um pouco (±35% da diferença, limitado a −2/+4); planos de landfall aceitam mais ramp.
- **Curva**: distância assimétrica até uma curva suave (70% própria, 30% EDHREC) — cartas caras a mais custam mais que cartas baratas a mais.
- **Terrenos**: faixa calculada pelo próprio deck (MV médio, ramp barato, landfall); o EDHREC pesa 30%.
- **Cores**: % de símbolos de mana de cada cor vs % de fontes.
- **Consistência**: mão inicial com 2–5 terrenos, 4º terreno no T4, ramp até o T3, compra até o T5, duas jogadas baratas até o T2, no máximo uma carta de MV 6+ presa no T4, interação até o T6.
- **Candidatas**: listas do EDHREC + busca por função + ramp/compra/remoção baratas + cartas cujo texto conversa com o comandante — sempre dentro da identidade de cor, legais e no bracket.
- **Conferência**: simulação de 2000 partidas antes/depois (turnos mortos, mana desperdiçada, sem cartas no T6, mana travada…); se a nota cair mais de 0,3, desfaz as trocas que mais atrapalham.

### Formato das respostas (0.5)

Toda resposta segue o mesmo padrão (`skills/archidekt-commander/references/output-format.md`): título com ícone, resposta direta em 1–2 frases, tabelas padronizadas (trocas, cortes, upgrades, preços, funções, antes × depois, mana, lista de deck, coleção, mudanças aplicadas), cada carta com link para a página dela na LigaMagic e um **⚡ Resumo rápido** no final. As ferramentas `card_lookup`, `card_price_br`, `deck_cut_candidates`, `deck_upgrade_candidates` e `deck_optimize` passaram a devolver o campo `ligamagicUrl`.

## Onde ficam os dados locais

Pasta: `ARCHIDEKT_HOME` (se definida) → senão `%USERPROFILE%\Projects\archidekt-mcp` (se existir) → senão `%USERPROFILE%\.archidekt`. Dentro dela:

- `data\cards.json`, `data\pt-names.json`, `data\cache-meta.json` — cache de cartas do Scryfall (**~15–20 MB** no total; o download é de ~31 MB compactados, processado em streaming).
- `data\edhrec\cards\` (páginas de carta do EDHREC, 7 dias) e `data\ligamagic-prices.json` (preços, 24 h) — dados de cartas.
- Nada sobre os seus decks é guardado: análises, planos, snapshots e páginas do comandante no EDHREC são consultados ao vivo a cada chamada.
- `wiki\` — sua wiki (Markdown comum; pode abrir e editar no Bloco de Notas, VS Code, Obsidian…). Começa com `README.md` e o modelo `_templates\deck.md`.

### Atualizar o cache de cartas

O servidor atualiza sozinho, em segundo plano, quando o cache não existe ou tem mais de 7 dias (a primeira vez leva **uns 2–5 minutos**: download do Scryfall + ~230 páginas de nomes em português). Para forçar, peça ao Claude "atualiza o cache de cartas" (`cards_cache_update` com `force: true`) e acompanhe com "status do cache". Para desligar a atualização automática, defina `ARCHIDEKT_NO_AUTO_CACHE=1`. Se uma etapa falhar (ex.: nomes em PT), o que deu certo é mantido e o erro aparece no status.

### Preços da LigaMagic — aviso

A LigaMagic **não tem API pública**: o plugin lê a página de busca do site, de forma educada (no máximo uma consulta a cada 2 s, até 30 cartas por pedido, cache de 24 h por carta). Se o site bloquear o acesso automatizado (Cloudflare/captcha/403), o plugin para na hora, avisa e não tenta de novo por 15 minutos — confira no site. Mudanças no layout do site podem quebrar a leitura dos preços. Os preços são uma referência do momento da consulta (o Claude sempre cita "LigaMagic" e a data).

Fontes externas usadas: Scryfall (API oficial, gratuita), EDHREC (JSON não oficial, só como referência: páginas do comandante ao vivo, páginas de carta em cache de 7 dias) e LigaMagic (página pública).

## Exemplos de pedidos

- "Otimiza o deck da Toph, bracket 3, sem tirar Doubling Season — quero que ele trave menos."
- "Triangula as cartas do Quintorius: o que não faz sentido com o comandante?"
- "Simula o deck da Toph trocando Krosan Grip por Chaos Warp."
- "Analisa meu deck do Omnath e sugere 10 trocas para mais ramp."
- "O que eu corto do deck da Toph? Quero só cartas que eu já tenho."
- "Quanto custa Anel Solar, Cultivar e Fera Interior na LigaMagic?"
- "Me mostra remoções verdes instantâneas até 3 de mana."
- "Anota na wiki que na partida de ontem fiquei com a mão travada de cartas caras."
- "Monta um deck de Commander da Atraxa usando só cartas que eu tenho."
- "Quantas Anel Solar eu tenho?"
- "Muda o bracket do deck 123456 para 3."

## Limitações e riscos

- **API não oficial.** O Archidekt não publica uma API; os endpoints foram observados no site e em outros projetos e podem mudar sem aviso.
- **Escritas na coleção não foram testadas ao vivo** — as rotas vieram do código do site. Sempre confira o campo `verification` e, se possível, o site.
- Limite de ~40 requisições/minuto: o servidor espaça as chamadas em 1,5 s, então lotes grandes demoram. Escritas nunca são repetidas automaticamente (exceto uma vez após renovar o token expirado).
- `archidekt_collection_update`/`_remove` sem nome de carta varrem a coleção página a página (lento em coleções grandes).
- Preços vêm só da LigaMagic (veja o aviso acima); a análise usa heurísticas (funções por tags + texto, notas 0–100) — são um guia, não um veredito.
- O otimizador usa heurísticas próprias e o EDHREC como referência; não testa o deck em partidas reais — a simulação é "goldfish" (sem oponentes). Use `lock` para manter cartas que você sabe que funcionam.
- Cada `deck_analyze`/`deck_triangulate`/`deck_optimize` baixa ~7 páginas do comandante no EDHREC (1 s cada), então leva de 10 a 20 s; as páginas de carta (`deep`) só são baixadas na primeira vez em 7 dias.
- `deck_upgrade_candidates` com preços pode levar ~1 minuto (confere a coleção carta a carta e espera 2 s entre consultas à LigaMagic).

## Desenvolvimento

```bash
node tests/run-tests.mjs
```

Os testes sobem mocks locais do Archidekt (`tests/mock-server.mjs`) e de Scryfall/LigaMagic/EDHREC (`tests/mock-external.mjs`) e conversam com o servidor via stdio. Variáveis úteis: `ARCHIDEKT_API_BASE`, `SCRYFALL_API_BASE`, `LIGAMAGIC_BASE`, `EDHREC_BASE` (URLs base), `ARCHIDEKT_MIN_INTERVAL_MS`, `SCRYFALL_MIN_INTERVAL_MS`, `LIGAMAGIC_MIN_INTERVAL_MS`, `EDHREC_MIN_INTERVAL_MS`, `LIGAMAGIC_BLOCK_COOLDOWN_MS`, `SCRYFALL_RETRY_DELAY_MS` (intervalos), `ARCHIDEKT_TOOL_BUDGET_MS` (tempo máximo por chamada das ferramentas lentas, padrão 40000), `ARCHIDEKT_HOME` (pasta de dados) e `ARCHIDEKT_NO_AUTO_CACHE=1`.

Módulos do servidor: `index.mjs` (entrada), `mcp.mjs` (JSON-RPC stdio), `client.mjs` (Archidekt), `commander.mjs` (regras), `tools.mjs` (ferramentas Archidekt), `tools-insight.mjs` (ferramentas 0.2), `tools-optimize.mjs` (ferramentas 0.3), `store.mjs` (pastas, gravação atômica), `cache.mjs` + `scryfall.mjs` (cache de cartas), `roles.mjs` (funções), `translate.mjs`, `ligamagic.mjs`, `edhrec.mjs`, `analysis.mjs`, `triangulate.mjs` (triangulação), `optimizer.mjs` (busca local), `simulate.mjs` (hipergeométrica + Monte Carlo), `improve.mjs` (motor do plano, nota por área, opções de melhoria), `wiki.mjs`.
