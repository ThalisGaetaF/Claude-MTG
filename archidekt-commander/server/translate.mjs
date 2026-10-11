// EN ⇄ PT card-name translation: local cache → Scryfall fuzzy → LigaMagic.

import { findCard, getCache, ptNameOf, resolveLocal } from './cache.mjs';
import * as liga from './ligamagic.mjs';
import * as scryfall from './scryfall.mjs';
import { normName } from './store.mjs';

/**
 * Translate one name. Returns {input, en, pt, source, confidence, how?} or {input, unresolved: true, reason, suggestions?}.
 * opts.remote=false limits to the local cache (fast path for bulk work).
 */
export async function translateName(input, { remote = true, wantPt = true, useLiga = true, deadline = null } = {}) {
  const left = () => (deadline == null ? Infinity : deadline - Date.now());
  const tmo = () => Math.max(1000, Math.min(15_000, left() - 1000));
  const name = String(input ?? '').trim();
  if (!name) return { input, unresolved: true, reason: 'nome vazio' };
  const local = resolveLocal(name);
  if (local?.en) {
    const pt = wantPt ? ptNameOf(local.en) : null;
    return { input: name, en: local.en, pt: pt ?? (local.lang === 'pt' && local.how === 'exact' ? name : null), source: 'cache', how: local.how, confidence: local.confidence, ...(local.alternatives ? { alternatives: local.alternatives } : {}) };
  }
  if (!remote) return { input: name, unresolved: true, reason: local?.ambiguous ? 'ambíguo' : 'não está no cache', suggestions: local?.ambiguous };

  const errors = [];
  try {
    const card = await scryfall.named(name, { timeoutMs: tmo() });
    if (card?.name) {
      let pt = ptNameOf(card.name);
      if (!pt && wantPt) {
        const pn = card.printed_name || null;
        pt = card.lang === 'pt' && pn ? pn : left() > 3000 ? await scryfall.portugueseName(card.name, { timeoutMs: tmo() }).catch(() => null) : null;
      }
      const exact = normName(card.name) === normName(name) || (pt && normName(pt) === normName(name));
      return { input: name, en: card.name, pt: pt ?? null, source: 'scryfall-fuzzy', confidence: exact ? 0.95 : 0.8 };
    }
  } catch (e) {
    errors.push(`Scryfall: ${e.message}`);
  }
  if (useLiga && left() > 4000) try {
    const pair = await liga.namePair(name, { deadline });
    if (pair?.en) return { input: name, en: pair.en, pt: pair.pt ?? ptNameOf(pair.en) ?? null, source: 'ligamagic', confidence: 0.7 };
  } catch (e) {
    errors.push(`LigaMagic: ${e.message}`);
  }
  return { input: name, unresolved: true, reason: errors.length ? errors.join(' | ') : 'não encontrado', suggestions: local?.ambiguous };
}

/** English name for a card the user may have typed in PT. Returns null when nothing better is known. */
export async function toEnglish(name, { remote = true } = {}) {
  const t = await translateName(name, { remote, wantPt: false });
  if (t.unresolved || !t.en) return null;
  if (normName(t.en) === normName(name)) return null; // already English
  return t;
}

/** Fast local-only check: is this a known English name? */
export function isKnownEnglish(name) {
  return !!findCard(name);
}

export function cacheReady() {
  const c = getCache();
  return !!(c && (c.hasCards || c.pt.size));
}
