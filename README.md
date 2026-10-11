# Claude-MTG

Integração do Claude com o [Archidekt](https://archidekt.com) para Magic: The Gathering (Commander/EDH): ver e editar sua coleção e seus decks, criar decks, analisar e otimizar, nomes de cartas em português e preços em reais (LigaMagic).

| Pasta / arquivo | O que é |
|---|---|
| [`archidekt-commander/`](archidekt-commander/) | O plugin do Claude (v0.6.0): servidor MCP (`server/`), skill, agente `mtg-commander-expert` e testes. Detalhes no [README do plugin](archidekt-commander/README.md). |
| [`API_SPEC.md`](API_SPEC.md) | Notas sobre a API (não oficial) do Archidekt. |
| [`wiki/`](wiki/) | Estrutura inicial e modelo da wiki pessoal de decks. |
| [`dist/`](dist/) | Arquivos prontos: a extensão `archidekt-commander.mcpb` e a skill `archidekt-commander-skill.zip`. |

## Qual instalação escolher?

| | Extensão `.mcpb` | Plugin `.plugin` |
|---|---|---|
| Precisa instalar Node.js? | **Não**: usa o Node que já vem no Claude desktop | Sim (18+) |
| Onde ficam e-mail e senha | Na tela de configuração da extensão | Em `credentials.json` ou variáveis de ambiente |
| Skill e agente especialista | Skill instalada à parte; sem agente | Já vêm junto |
| Indicado para | Computador da empresa, sem permissão de instalar programas | Seu computador |

---

## Instalação rápida: extensão `.mcpb` (sem Node)

1. Baixe [`dist/archidekt-commander.mcpb`](dist/archidekt-commander.mcpb). No GitHub, abra o arquivo e clique em **Download raw file**.
2. Dê dois cliques no arquivo, ou arraste-o para a janela do Claude desktop. Aparece a tela de instalação da extensão **Archidekt Commander**. Clique em **Instalar**.
3. Na configuração da extensão, preencha:
   - **E-mail ou usuário do Archidekt**;
   - **Senha do Archidekt**, que fica guardada nas configurações do Claude e não aparece no chat;
   - **Pasta de dados**, que é opcional. Em branco, os dados vão para `%USERPROFILE%\.archidekt`.
4. Ative a extensão, se ela não ficar ativa sozinha, e abra uma conversa nova.
5. Instale a skill, que ensina o Claude a usar as ferramentas do jeito certo (fluxo de análise, tabelas, links da LigaMagic):
   1. baixe [`dist/archidekt-commander-skill.zip`](dist/archidekt-commander-skill.zip);
   2. envie o ZIP na área de **Skills** das configurações do Claude.
6. Teste: *"quem sou eu no Archidekt?"*. Depois siga o [passo 5](#5-gere-o-cache-de-cartas) para gerar o cache de cartas. Funciona igual nas duas instalações.

Para trocar a senha, abra as configurações da extensão no Claude. Para atualizar, instale o `.mcpb` novo por cima.

> Se o Claude mostrar erro de Node ao iniciar a extensão, confira se o app está atualizado. Versões antigas do Claude desktop não traziam o Node embutido.

---

## Instalação completa: plugin (com Node)


### 1. Instale o Node.js

O servidor do plugin roda em Node.js 18 ou mais novo, sem dependências npm.

1. Abra o PowerShell e rode `node -v`.
2. Se o comando não existir ou a versão for menor que `v18`, instale a versão **LTS** em https://nodejs.org.
3. Feche e abra o PowerShell de novo e confira `node -v`.

### 2. Baixe o repositório

```powershell
cd $env:USERPROFILE\Projects
git clone https://github.com/ThalisGaetaF/Claude-MTG.git
```

(Sem Git: no GitHub, clique em **Code → Download ZIP** e extraia em `C:\Users\<você>\Projects\Claude-MTG`.)

### 3. Coloque as credenciais do Archidekt

O plugin entra na sua conta do Archidekt com seu e-mail (ou nome de usuário) e senha. **Nunca cole a senha no chat do Claude.** Ela fica num arquivo local que não vai para o Git (está no `.gitignore`).

1. Crie a pasta e abra o arquivo no Bloco de Notas:

   ```powershell
   New-Item -ItemType Directory -Force "$env:USERPROFILE\.archidekt" | Out-Null
   notepad "$env:USERPROFILE\.archidekt\credentials.json"
   ```

2. Cole o conteúdo abaixo, troque pelos seus dados e salve:

   ```json
   { "email": "seu-email@exemplo.com", "password": "sua-senha" }
   ```

   Pode usar `"username"` no lugar de `"email"`.

> **Alternativas.** O plugin procura as credenciais nesta ordem:
> 1. variáveis de ambiente `ARCHIDEKT_EMAIL` (ou `ARCHIDEKT_USERNAME`) e `ARCHIDEKT_PASSWORD`, criadas com `setx ARCHIDEKT_EMAIL "..."` e `setx ARCHIDEKT_PASSWORD "..."`;
> 2. o arquivo indicado em `ARCHIDEKT_CREDENTIALS_FILE`;
> 3. `%USERPROFILE%\.archidekt\credentials.json`;
> 4. `%USERPROFILE%\Projects\archidekt-mcp\credentials.json`.
>
> Sem credenciais, só as ferramentas públicas funcionam (buscar cartas, buscar decks e ver decks públicos). O token de login fica só na memória; nada é gravado em disco.

### 4. Instale o plugin no Claude

1. Gere o arquivo `.plugin` (um ZIP com o conteúdo da pasta `archidekt-commander`):

   ```powershell
   cd $env:USERPROFILE\Projects\Claude-MTG
   Get-ChildItem -Force archidekt-commander |
     Compress-Archive -DestinationPath archidekt-commander.zip -Force
   Move-Item -Force archidekt-commander.zip archidekt-commander.plugin
   ```

   Confira que o ZIP tem `.claude-plugin\plugin.json` e `.mcp.json` na raiz, não dentro de uma subpasta.

2. No app **Claude desktop** (Cowork), arraste o `archidekt-commander.plugin` para a conversa, ou abra o arquivo pelo app, e confirme a instalação.
3. **Feche e abra o Claude** para o servidor `archidekt` subir com as credenciais.
4. Teste numa conversa nova: *"quem sou eu no Archidekt?"*. O Claude deve chamar `archidekt_whoami` e responder com seu usuário.

   - Se aparecer *"credenciais não configuradas"*, revise o passo 3 (nome do arquivo, JSON válido, aspas retas) e reinicie o Claude.
   - Se der erro de login, confira e-mail e senha entrando em archidekt.com.

> **Para atualizar o plugin:** rode `git pull`, gere o `.plugin` de novo (passo 4.1), reinstale e reinicie o Claude.

### 5. Gere o cache de cartas

O cache local (dados do Scryfall com a função de cada carta e os **nomes em português**) é usado na análise, nas traduções e na checagem de identidade de cor.

- **Automático:** quando o servidor sobe e o cache não existe ou tem mais de 7 dias, ele começa a baixar sozinho, em segundo plano. Na primeira vez leva uns **2 a 5 minutos** (cerca de 31 MB do Scryfall mais ~230 páginas de nomes em PT).
- **Manual:** peça ao Claude *"atualiza o cache de cartas"* (`cards_cache_update` com `force: true`).
- **Acompanhar:** peça *"status do cache"* (`cards_cache_status`). Mostra o andamento, a data da última atualização, as contagens e eventuais erros. Se uma etapa falhar, o que já deu certo é mantido.

Os dados ficam em `%USERPROFILE%\Projects\archidekt-mcp\data\` se essa pasta existir; se não, em `%USERPROFILE%\.archidekt\data\`. Para escolher outra pasta, defina `ARCHIDEKT_HOME`. O cache ocupa uns 15 a 20 MB. Para desligar a atualização automática, defina `ARCHIDEKT_NO_AUTO_CACHE=1`.

Preços da LigaMagic (24 h) e páginas do EDHREC (7 dias) são guardados no cache conforme você usa. Não precisa gerar nada antes.

### 6. Pronto, é só usar

Exemplos de pedidos:

- *"Lista meus decks do Archidekt"*
- *"Analisa meu deck da Toph e sugere cortes"*
- *"Otimiza o deck do Quintorius, bracket 3"*
- *"Quanto custa Anel Solar na LigaMagic?"*
- *"Monta um deck de Atraxa só com cartas da minha coleção"*

O Claude sempre mostra as mudanças e pede confirmação antes de alterar um deck.

---

## Gerar a extensão `.mcpb` de novo

Depois de mudar o código do servidor, gere a extensão de novo. Precisa de Node só nesta etapa:

```powershell
npx @anthropic-ai/mcpb validate archidekt-commander/manifest.json
npx @anthropic-ai/mcpb pack archidekt-commander dist/archidekt-commander.mcpb
```

O `archidekt-commander/.mcpbignore` deixa testes, skill e agente fora do pacote. Lembre de manter a versão igual em `manifest.json`, `.claude-plugin/plugin.json` e `server/store.mjs`.

Para gerar o ZIP da skill (PowerShell):

```powershell
Compress-Archive -Force archidekt-commander/skills/archidekt-commander dist/archidekt-commander-skill.zip
```

## Rodar os testes

```powershell
cd archidekt-commander
node tests/run-tests.mjs
```

Os testes usam mocks locais do Archidekt, Scryfall, LigaMagic e EDHREC. Não precisam de credenciais nem de internet.
