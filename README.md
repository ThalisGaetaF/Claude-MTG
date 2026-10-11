# Claude-MTG

Integração do Claude com o [Archidekt](https://archidekt.com) para Magic: The Gathering (Commander/EDH).

- [`archidekt-commander/`](archidekt-commander/) — plugin do Claude (Cowork / Claude desktop), v0.5.0: servidor MCP (`server/`), skill, agente `mtg-commander-expert` e testes (`tests/`). Veja o [README do plugin](archidekt-commander/README.md).
- [`API_SPEC.md`](API_SPEC.md) — notas sobre a API do Archidekt.
- [`wiki/`](wiki/) — estrutura e modelos da wiki pessoal de decks.

## Rodar os testes

```bash
cd archidekt-commander
node tests/run-tests.mjs
```

Credenciais do Archidekt ficam em `~/.archidekt/credentials.json` (fora do repositório).
