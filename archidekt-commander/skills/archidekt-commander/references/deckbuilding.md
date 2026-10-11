# Commander deckbuilding reference

## Baseline (casual, bracket 2–3)

| Role | Count | Notes |
|------|-------|-------|
| Lands | 36–38 | 33–35 with heavy ramp/low curve; 38–40 for landfall |
| Ramp | 10–12 | Prefer 2-MV rocks/land ramp; Sol Ring, Arcane Signet, Talismans, Rampant Growth, Cultivate |
| Card draw / advantage | 10 | Repeatable engines > one-shots |
| Targeted removal | 8–10 | Mix creature/artifact/enchantment answers; some at instant speed |
| Board wipes | 2–4 | Fewer in creature-heavy decks; prefer one-sided or non-targeted |
| Protection / interaction | 2–5 | Counterspells, hexproof/indestructible granting, Heroic Intervention |
| Win plan / synergy | 25–30 | The theme package; ≥2 independent ways to close the game |

Average MV target: ~3.0 (casual), ≤2.5 (high power). Check the curve: a typical healthy shape is 8–12 cards at 1 MV, 12–15 at 2, 12–15 at 3, 8–10 at 4, 5–8 at 5, ≤5 at 6+.

Color pips: keep the land mix proportional to pip counts; 3+ colors want 10+ untapped duals/fetches/tri-lands and color-fixing ramp.

## Ratios by archetype

| Archetype | Lands | Ramp | Draw | Removal | Wipes | Notes |
|-----------|-------|------|------|---------|-------|-------|
| Landfall | 38–40 | 12+ (land-based) | 8–10 | 7–8 | 2 | Fetches, extra land drops, land recursion (Crucible, Ramunap) |
| Aristocrats / sacrifice | 35–36 | 9–10 | 10 | 8 | 1–2 | Fodder makers ≥10, sac outlets 4–6 (free ones), drain payoffs 5+ |
| Voltron | 35–36 | 10 | 8 | 7 | 1–2 | Protection 6+, evasion, equipment/auras 10–14, cheap equip costs |
| Spellslinger | 33–35 | 10 (rocks/rituals) | 12+ | 10 (instants) | 2–3 | 25+ instants/sorceries, cost reducers, copy effects |
| Tokens / go-wide | 35–36 | 10 | 10 | 8 | 1 (one-sided) | Anthems 4–6, mass pump finisher, token doublers |
| +1/+1 counters | 35–36 | 10 | 10 | 8 | 2 | Proliferate 4+, counter doublers |
| Reanimator | 34–35 | 8 | 8 + self-mill 8 | 8 | 2 | 6–10 big targets, 8–10 reanimation spells |
| Artifacts | 33–35 | 12 (rocks) | 10 | 8 | 2 | Cost reducers, artifact lands if allowed by bracket |
| Enchantress | 35–36 | 9 | 10 (enchantress draw) | 8 | 2 | Removal on enchantments, protection |
| Stax / control | 35–36 | 12 | 10 | 10 | 3–4 | Watch bracket — mass land denial is bracket 4+ |

## Brackets (official Commander brackets)

1. **Exhibition** — theme first, power irrelevant. No Game Changers, no mass land denial, no extra-turn chains, no 2-card infinite combos.
2. **Core** — precon level. No Game Changers, no mass land denial, extra turns only sparingly, no early 2-card combos.
3. **Upgraded** — up to 3 Game Changers, no mass land denial, no chaining extra turns, 2-card combos only late game (not before turn ~6).
4. **Optimized** — any number of Game Changers; anything legal goes, but not built for cEDH metagame.
5. **cEDH** — tuned for the competitive metagame.

The Game Changers list changes over time; trust the `gameChanger` flag returned by the tools rather than memory, and say so when it matters.

## Analysis template

1. **Snapshot** — commander, bracket target, count, average MV, lands/ramp/draw/removal/wipes counts.
2. **Rules** — output of `archidekt_validate_deck` (errors first).
3. **Plan** — how the deck wins; is there a backup plan?
4. **Weak spots** — 3–5 bullet points, each with the cards involved.
5. **Swaps** — IN/OUT table (IN · OUT · Categoria · Por quê), ownership marked if checked.
6. **Fluidity check** — early plays (MV ≤ 2), top end and dead 6-drops, color requirements vs sources (commander on curve), card flow (draw engines), mana sinks for flood, dead turns / wasted mana in the simulation.
7. **Color identity** — every IN card inside the commander's identity (`card_lookup` → `ci`).

## Cut heuristics

Cut first: cards that do nothing the turn they land without setup, off-plan "good stuff", 6+ MV cards that don't win or swing the board, tapped lands beyond what the deck can afford, removal that only hits one permanent type when better flexible options exist, redundant win-more effects.

---

# How the analysis tools work

Read this part when you need to explain a score, doubt a role count, or troubleshoot the card database, prices or wiki.

## Where data lives

Root folder: `ARCHIDEKT_HOME` if set, else `%USERPROFILE%\Projects\archidekt-mcp` if it exists, else `%USERPROFILE%\.archidekt`.

| Path | Content | Freshness |
|------|---------|-----------|
| `data/cards.json` | Compact Scryfall oracle cards (paper only): name, faces, MV, cost, type, text, colors, identity, keywords, Commander legality, Game Changer, EDHREC rank, USD, roles, tags | 7 days (auto refresh on start) |
| `data/pt-names.json` | PT → EN index and the most common PT name per EN card | same job |
| `data/cache-meta.json` | updatedAt, counts, sources, durationMs, errors | — |
| `wiki/` | Personal Markdown wiki (written only when the user asks) | kept |

| `data/edhrec/cards/<slug>.json` | EDHREC card pages (global popularity of a card; 404s kept 1 day) | 7 days |
| `data/ligamagic-prices.json` | LigaMagic prices per card | 24 h |

Only card data is cached. Nothing about a deck is stored: no analysis results, no optimizer plans, no snapshots, no commander/theme/bracket/average-deck/combo pages — every deck analysis reads the deck and those EDHREC pages live. Inside one tool call the same page is fetched only once. Writes return `undo` (the changes that revert them) instead of a snapshot file.

## Roles

Vocabulary: `ramp, draw, removal, wipe, counter, tutor, protection, recursion, gy-hate, sac-outlet, tokens, landfall, lifegain, burn, evasion, anthem, wincon`.

A card's roles are the union of:
1. **Scryfall oracle tags** (whitelist): `ramp`, `mana-rock`, `mana-dork`, `land-ramp`, `extra-land-drop`, `card-advantage`, `draw`, `removal`, `creature-removal`, `artifact-removal`, `enchantment-removal`, `sweeper`/`board-wipe`, `counterspell`, `tutor`, `gives-hexproof`/`gives-indestructible`/`protection`, `recursion`/`reanimation`, `sacrifice-outlet`, `graveyard-hate`, `token-generator`, `landfall`, `lifegain`, `burn`, `evasion`, `anthem`, `win-condition`, plus prefixed/suffixed variants such as `removal-artifact` or `token-generator-creature`. Child tags inherit their parents' roles (so `removal-creature` or any child of `removal` counts as removal). Tags mentioning "graveyard" never count as plain removal.
2. **Archidekt oTags** on the deck's cards (same mapping) and Archidekt's `tutor` flag.
3. **Oracle-text heuristics** ("destroy all creatures" → wipe, "counter target spell" → counter, "you win the game" → wincon…). Lands never count as ramp; each face of a double-faced card is judged with its own type.

Heuristics can misfire. If a count looks wrong, check the card with `card_lookup` and say so.

## Targets used by `deck_analyze`

ramp 10–12 · draw 10–12 · removal 8–10 · wipes 2–4 · protection 2–5 · recursion 2–5 · tutors 0–4 (info) · graveyard hate 0–3 (info, no minimum). Lands: own model `36 + 3·(avg MV − 3) − 0.5·(cheap ramp above 8)`, +2 for landfall/lands-matter plans, bounded 32–41, range ±1; EDHREC's average land count only nudges it (30%). Average MV alert above 3.4.

No playgroup/opponent checks: the analysis does not tune the deck against specific archetypes.

## Fluidity (`deck_analyze.fluidity`)

- **Early plays:** nonland cards with MV ≤ 2 (alert below 12) and the odds of seeing one by T2.
- **Top end:** MV 6+ cards (alert above 9); **dead top end** = MV 6+ with no core role, not a win condition and not a payoff of the plan (alert at 2+).
- **Color requirements:** for each color, the hardest card (most pips of that color, by the turn it wants to be cast; X spells count from T4), commander included, and the hypergeometric chance of having those sources in time (alert below 80%; impact 7 for the commander).
- **Card flow:** draw engines (permanents that keep drawing); **mana sinks:** activated abilities with generic cost, X spells, cycling/kicker/etc.
- **Odds:** two cheap plays by T2, at most one 6-drop among the first 10 cards, 2–5 lands in the opening hand.

Bracket estimate: start at 2; any Game Changer, more than 2 tutors, or a 2-card combo (Archidekt `twoCardComboIds` shared by two cards in the deck) → 3; more than 3 Game Changers, mass land denial or 2+ extra-turn cards → 4. Brackets 1 and 5 depend on intent and are never estimated.

## Per-card score (0–100)

`deck_analyze`, `deck_cut_candidates` and `deck_upgrade_candidates` use the `deck_triangulate` value (see "How the optimizer works") so every tool ranks cards the same way. The simple score below is the fallback when a card has no evaluation.

Nonland cards start at 45:
- **Role value:** +12 per core role (cap +24), +5 per secondary role (tokens, landfall, sac outlet, wincon, anthem, evasion; cap +10).
- **Mana efficiency:** MV ≤ 1 +6, 2 +5, 3 +2, 4 0, 5 −4, 6 −8, then −3 per extra MV (halved for wipes and wincons).
- **Synergy (own):** up to +15 for themes shared with the commander's text, the `plan` argument and the deck's own recurring themes (≥ 10 nonland cards and ≥ 16% of them).
- **Fluidity:** (fluidity − 0.5) × 20 — cheap, cheap ramp, draws/filters, instant speed, two roles, flexible, mana sink; color-hungry costs and off-plan 6-drops lose points.
- **EDHREC reference:** at most about +8 (10 × synergy + 5 × inclusion). It confirms, it doesn't decide.
- **Penalties:** −12 "fora do plano" (no role and no synergy), −6 for MV 6+ with little impact, −30 for a Game Changer when the target bracket is 1–2 (−10 at bracket 3 with more than 3), −6 redundancy for the weakest single-role cards beyond a role's maximum.

Lands start at 55 (basics 50): +8 when a nonbasic fixes 2+ deck colors, −12 enters tapped, −3 conditionally tapped, +6 utility.

Scores sort; they don't decide. Read `why` and use judgement (a 6-MV finisher may be the win condition).

## Cut and upgrade candidates

- `deck_cut_candidates`: lowest scores, skipping the commander, lands (unless above the land target) and cards whose role is at or below its minimum; weak protected cards go to `alsoConsider` with a warning.
- `deck_upgrade_candidates`: role search, cheap ramp/draw/removal and text-synergy cards from the local cache + EDHREC lists. Score = own merit (25 + 12 core role + 25 × fluidity + 18 × text synergy) + reference bonus (EDHREC ≤ +15, rank ≤ +8) + 15 per gap filled (cap +30). **Color identity is mandatory:** off-identity cards are dropped, and so are cards missing from the local cache (identity can't be confirmed). Also drops banned, already-in-deck cards and Game Changers that would break the target bracket. Checks ownership for the top 20, prices the top ≤ 15 on LigaMagic, sorts owned first, pairs each candidate with a cut sharing a role when possible.

## Color identity guard

- `archidekt_update_deck_cards` refuses `add` of a card outside the commander's identity to any main-deck category (Maybeboard/Sideboard accept anything). Identity = commanders' identity from Archidekt united with the local Scryfall cache.
- `deck_optimize` filters candidates by identity, then checks the final plan again; `deck_simulate` what-ifs ignore off-color cards.

## LigaMagic

No public API: the server reads the search page. It uses the plain-name row (aggregate across editions) and lists up to 5 variants, ignoring Art Cards. "R$ 0,00" = no stock (`null`). ≥ 2 s between requests, 24 h cache per card, ≤ 30 cards per call. A 403/429/503, Cloudflare or captcha page stops the batch ("LigaMagic bloqueou acesso automatizado") and pauses LigaMagic for 15 minutes — no retries. If the site layout changes, prices stop appearing: say so and point to the site.

## EDHREC

Unofficial JSON (`json.edhrec.com/pages/commanders/<slug>.json`). Slug = front-face name, lowercase, no punctuation, spaces → "-"; partners joined alphabetically. Missing pages just disable EDHREC-based synergy.

## Wiki

Markdown under `wiki/`. Page names are sanitized (no `..`, absolute paths or backslashes; only `[a-z0-9-_/]` after removing accents; max 3 levels; Windows reserved names refused); 200 KB per page. `wiki_search` ignores case and accents. Deck template: `_templates/deck.md`.


# How `deck_analyze` works (0.7)

- Live deck + live EDHREC reference → every card valued by `deck_triangulate`'s own model → roles, mana, fluidity, bracket (as above).
- **Simulation:** 2000 goldfish games of the current deck (same engine as below).
- **Plan engine** (`plan`): for each theme (landfall, tokens, counters, sacrifice, graveyard, spells, artifacts, enchantments, lifegain, equipment) counts **enablers** (cards that feed the plan) and **payoffs** (cards that turn it into advantage or damage). A commander that is a payoff counts as 3. Themes from the deck's text only (not the commander nor the plan) need ≥ 4 payoffs and ≥ 6 enablers to be reported. Main themes = the user's plan + the two biggest engines; status: equilibrado · poucos payoffs (< 5) · poucos habilitadores (< 8) · muita base, pouco retorno (enablers > 3,5 × payoffs). Also: closers (win cons, power ≥ 5, mass pump/evasion, drain, big payoffs), draw engines, ramp × gas.
- **Scorecard** 0–10: base de mana (screw/color screw at T4, tapped lands, land count), início de jogo (dead turns, commander on time, cheap plays), gás (out of gas at T6, draw engines), interação (removal/wipes/instant share), plano e sinergia (average text synergy, payoffs, closers), resiliência (protection + recursion), qualidade das cartas (average value, doubtful cards).
- **Options:** packages of ≤ 4 1-for-1 swaps, each aimed at one problem — `upgrade` (doubtful/cut cards → cards ≥ 12 points better that share a function or fit the plan), `gas` (surplus/weak ramp or off-role cards → draw engines, real card draw, payoffs; never more ramp), `early` (clunky MV ≥ 4 cards → MV ≤ 2 plays), `curve` (dead top end → MV ≤ 3), `interaction` (off-role cards → removal/wipes, instant preferred), `plan` (off-plan cards → missing payoffs/enablers of a main theme), `mana` (tapped/off-color lands that are not plan enablers → basic of the most needed color). Closers, payoffs and good enablers of the main themes are never cut; a card holding a role at/below its minimum leaves only for one with the same role; adding to a role already at its maximum costs points. Candidates: EDHREC lists + local database search (roles below target, cheap ramp/draw/removal, draw engines, enablers and payoffs of every theme, text synergy) — inside the color identity, legal, bracket-safe. Each option is simulated (same seed) and ranked by 3 × Δ simulation + Δ card value/30 (±3) − 0,4 × Δ out-of-gas − 6 × Δ dead turns; options that play worse without better cards are dropped.

# How the optimizer works (0.4)

- Goal: a better, smoother deck. EDHREC is a reference, the deck's own model decides; no tuning against specific opponents.
- `deck_triangulate`: value = weighted mix of the **own model** (function R, text synergy H with the commander/plan/deck themes, mana cost M, fluidity F) and two references (EDHREC composite E — commander synergy/inclusion, detected theme, bracket page, average deck — and global popularity G). Weights in `triangulate.mjs` MODES (equilibrio: E .18, G .06, R .22, H .18, M .14, F .22). Missing references drop out. Votes: EDHREC (all pages = 1 vote), popularity, function, text, fluidity. Verdict comes from the own model: "corte" needs own < 0.33 and value < 40; EDHREC can lift a card to "núcleo" but never cut it alone.
- `deck_optimize`: F = Σ value (lands × 0.6) − role penalty (w·(20d+5d²) below min; w·(4s+s²) above max — too much of one role = runs out of gas; targets generic, EDHREC's average deck nudges ±35% of the gap, capped −2/+4; ramp max +8 for landfall plans) − asymmetric curve distance to a smooth curve (own ideal 1/9/16/15/11/6/3/2, EDHREC blended 30%; extra 6+ drops cost the most, extra cheap cards almost nothing) − color penalty + 2.5 × consistency (keepable 7, 4th land on T4, ramp by T3, draw by T5, two cheap plays by T2, ≤ 1 six-drop by T4, interaction by T6). Candidates: EDHREC lists + cache role search + cheap ramp/draw/removal + text-synergy cards, all inside the color identity, legal, bracket-safe. Steepest-ascent 1-for-1 swaps, `minGain` 2, tabu. Land range from `fluidity.landPlan`.
- Goldfish (`simulate.mjs`): on the play, London mulligan (keep 2–5 lands; first free), one land per turn, greedy casting commander → ramp → draw → biggest spell; draw resolves (one-shot N cards; engines ~1 card every other turn). Reports dead turns T2–T5, wasted mana T2–T6, cards seen by T6, out of gas at T6, screw, color screw, flood, mana spent. Score weights: mulligan .12, 4th land .12, commander .10, screw .12, color screw .10, flood .08, mana spent .14, dead turns .11, out of gas .11. The optimizer undoes swaps while the score drops more than 0.3.
