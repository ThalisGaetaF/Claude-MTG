// Personal Markdown wiki under <home>/wiki. Strict page-name sanitization (no traversal).

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, normName, slugify, ToolError, wikiDir, writeFileAtomic } from './store.mjs';

export const MAX_PAGE_BYTES = 200 * 1024;
const MAX_DEPTH = 3;
const MAX_SEGMENT = 80;

const README = `# Wiki pessoal de Commander

Notas mantidas pelo Claude (plugin archidekt-commander) e por você. Tudo é Markdown comum: pode editar à vontade.

## Estrutura

- \`decks/<nome-do-deck>.md\` — uma página por deck: plano de vitória, bracket, peças-chave, histórico de mudanças, partidas e pontos fracos. Modelo em \`_templates/deck.md\`.
- \`meta/grupo.md\` — anotações livres sobre o grupo de jogo (o otimizador não usa isso para ajustar decks).
- \`cartas/avaliacoes.md\` — avaliações de cartas (o que performou bem ou mal nas partidas).
- \`arquetipos/<arquetipo>.md\` — anotações por arquétipo (landfall, tokens, +1/+1 counters…).

## Regras

- Nomes de página: letras minúsculas, números, \`-\`, \`_\` e \`/\`, até 3 níveis (ex.: \`decks/toph\`).
- Cada página tem no máximo 200 KB.
- Datas no formato AAAA-MM-DD.
`;

const DECK_TEMPLATE = `# <Nome do deck>

- **Comandante:**
- **Archidekt:** https://archidekt.com/decks/<id>
- **Bracket alvo:**

## Plano de vitória

## Bracket

## Peças-chave

## Histórico de mudanças

| Data | Mudança | Motivo |
|------|---------|--------|

## Partidas

| Data | Oponentes | Resultado | Notas |
|------|-----------|-----------|-------|

## Pontos fracos conhecidos
`;

/** Ensure README and templates exist (first use). */
export function initWiki() {
  const root = ensureDir(wikiDir());
  const readme = path.join(root, 'README.md');
  if (!fs.existsSync(readme)) writeFileAtomic(readme, README);
  const tpl = path.join(root, '_templates', 'deck.md');
  if (!fs.existsSync(tpl)) writeFileAtomic(tpl, DECK_TEMPLATE);
  return root;
}

/** Validate and normalize a page name → {page, file}. Throws ToolError('input') on anything suspicious. */
export function resolvePage(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new ToolError('input', '"page" é obrigatório (ex.: "decks/toph").');
  let p = raw.trim();
  if (p.includes('\0') || p.includes('\\') || p.includes('..') || /^[a-z]:/i.test(p) || p.startsWith('/') || p.startsWith('~') || /^[a-z]+:\/\//i.test(p)) {
    throw new ToolError('input', `Nome de página inválido: "${raw}". Use algo como "decks/toph" (sem "..", barras invertidas ou caminhos absolutos).`);
  }
  p = p.replace(/\.md$/i, '');
  const segs = p.split('/').map((s) => s.trim());
  if (segs.some((s) => !s)) throw new ToolError('input', `Nome de página inválido: "${raw}" (segmento vazio).`);
  const norm = segs.map((s) =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\s+/g, '-'),
  );
  if (norm.some((s) => !/^[a-z0-9_-]+$/.test(s) || /^[-_]+$/.test(s))) {
    throw new ToolError('input', `Nome de página inválido: "${raw}". Só letras, números, "-", "_" e "/".`);
  }
  // Windows reserved device names (even with an extension).
  if (norm.some((s) => /^(con|prn|aux|nul|com\d|lpt\d)$/.test(s))) throw new ToolError('input', `Nome de página reservado no Windows: "${raw}".`);
  if (norm.length > MAX_DEPTH) throw new ToolError('input', `Página muito profunda: "${raw}" (máximo ${MAX_DEPTH} níveis).`);
  if (norm.some((s) => s.length > MAX_SEGMENT)) throw new ToolError('input', `Nome de página longo demais: "${raw}" (máximo ${MAX_SEGMENT} caracteres por parte).`);
  const page = norm.join('/');
  const root = path.resolve(wikiDir());
  const file = path.resolve(root, ...norm) + '.md';
  if (!file.startsWith(root + path.sep)) throw new ToolError('input', `Nome de página inválido: "${raw}".`);
  // A symlinked folder inside the wiki must not lead writes/reads outside it.
  let dir = path.dirname(file);
  while (dir.startsWith(root) && !fs.existsSync(dir)) dir = path.dirname(dir);
  try {
    const realRoot = fs.realpathSync(root);
    const realDir = fs.realpathSync(dir);
    if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) throw new ToolError('input', `Nome de página inválido: "${raw}" (aponta para fora da wiki).`);
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new ToolError('input', `Nome de página inválido: "${raw}" (link simbólico).`);
  } catch (e) {
    if (e instanceof ToolError) throw e;
  }
  return { page, file };
}

function walk(dir, rel = '', out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), r, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(r.replace(/\.md$/, ''));
  }
  return out;
}

export function listPages() {
  const root = initWiki();
  return walk(root)
    .sort()
    .map((page) => {
      const st = fs.statSync(path.join(root, ...page.split('/')) + '.md');
      return { page, bytes: st.size, updatedAt: st.mtime.toISOString() };
    });
}

export function readPage(page) {
  initWiki();
  const { page: p, file } = resolvePage(page);
  if (!fs.existsSync(file)) return null;
  return { page: p, content: fs.readFileSync(file, 'utf8'), updatedAt: fs.statSync(file).mtime.toISOString() };
}

export function writePage(page, content, mode = 'replace') {
  initWiki();
  const { page: p, file } = resolvePage(page);
  if (typeof content !== 'string') throw new ToolError('input', '"content" deve ser texto.');
  if (!['replace', 'append'].includes(mode)) throw new ToolError('input', 'mode deve ser "replace" ou "append".');
  let next = content;
  const existed = fs.existsSync(file);
  if (mode === 'append' && existed) {
    const prev = fs.readFileSync(file, 'utf8');
    next = prev + (prev.endsWith('\n') || !prev ? '' : '\n') + content;
  }
  if (!next.endsWith('\n')) next += '\n';
  const bytes = Buffer.byteLength(next, 'utf8');
  if (bytes > MAX_PAGE_BYTES) throw new ToolError('input', `Página ficaria com ${Math.round(bytes / 1024)} KB (máximo 200 KB). Resuma ou divida em outra página.`);
  writeFileAtomic(file, next);
  return { page: p, mode, created: !existed, bytes };
}

export function searchWiki(query, { maxHits = 60 } = {}) {
  const q = normName(query);
  if (!q) throw new ToolError('input', '"query" é obrigatório.');
  const root = initWiki();
  const results = [];
  let hits = 0;
  for (const page of walk(root).sort()) {
    const text = fs.readFileSync(path.join(root, ...page.split('/')) + '.md', 'utf8');
    const lines = text.split(/\r?\n/);
    const matches = [];
    lines.forEach((l, i) => {
      if (hits < maxHits && normName(l).includes(q)) {
        matches.push({ line: i + 1, text: l.slice(0, 300) });
        hits++;
      }
    });
    const inName = normName(page.replace(/\//g, ' ')).includes(q);
    if (matches.length || inName) results.push({ page, matches });
  }
  return { query, pages: results.length, results, truncated: hits >= maxHits };
}

/** Existing wiki page for a deck: tries decks/<slug of deck name>, then decks/<slug of commander>. */
export function deckPage(deckName, commanderNames = []) {
  const candidates = [slugify(deckName)];
  for (const c of commanderNames) {
    const front = String(c).split(' // ')[0];
    candidates.push(slugify(front), slugify(front.split(',')[0]), slugify(front.split(/[ ,]/)[0]));
  }
  for (const s of [...new Set(candidates.filter(Boolean))]) {
    try {
      const r = readPage(`decks/${s}`);
      if (r) return r;
    } catch {
      /* invalid slug: skip */
    }
  }
  return { page: `decks/${slugify(deckName) || 'deck'}`, content: null };
}
