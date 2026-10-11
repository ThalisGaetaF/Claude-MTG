# Archidekt unofficial API — spec (researched 2026-10-10)
Confidence: LIVE = verified by other projects against archidekt.com; BUNDLE = read from site JS, unexecuted.
Reference impls (read-only reference, do NOT copy code — PolyForm Noncommercial / AGPL): TheUncleBen/MTG-Assistant-Gateway (archidekt.py), nccurry/mtg-mcp.

## Base / headers
- Base `https://archidekt.com/api`, paths end with `/`.
- `Accept: application/json`, `Content-Type: application/json` on writes, honest `User-Agent` (e.g. `archidekt-claude-mcp/0.1`).
- Auth header: `Authorization: JWT <access>` (NOT Bearer — Bearer is silently treated as anonymous).
- No cookies/CSRF.
- Rate limit ~40 req/min: pace ≥1.5 s between requests, honor Retry-After on 429, never auto-retry writes.
- 401 → refresh token and retry once. 404 → missing or private (retry with auth). Deleted deck id → 400.

## Auth (LIVE)
- `POST /rest-auth/login/` body `{"email","password"}` (or `username` if no @). Token under `access_token`|`access`|`token`|`jwt`; refresh under `refresh_token`|`refresh`. `user.id` (or `pk`), `user.username`.
- `POST /rest-auth/token/refresh/` body `{"refresh"}` → `{"access", "access_token_expiration"}`. Refresh not rotated. 400/401 → re-login. Expiry from JWT `exp`.

## Decks
- List own (LIVE): `GET /decks/v3/?ownerId=<id>&orderBy=-updatedAt&pageSize=50&page=N` with JWT → includes private. Response `{count,next,previous,results:[{id,name,deckFormat,updatedAt,createdAt,private,unlisted,parentFolderName,colors,size,edhBracket,tags,viewCount,featured,owner:{id,username}}]}`.
- Public search: `name`, `commanderName` (+`deckFormat=3`), `ownerUsername`, `deckFormat`, `colors=W,U&colorIdentity=true`, `orderBy` in -updatedAt,-createdAt,-viewCount,-size,edhBracket. 60 rows/page.
- Get deck (LIVE): `GET /decks/{id}/`. Fields: id,name,description (Quill JSON),deckFormat,edhBracket,private,unlisted,owner,deckTags,categories[{name,isPremier,includedInDeck}],cards[].
  - cards[]: `id` = deckRelationId, quantity, categories (list|null), modifier Normal|Foil|Etched, label, notes, companion, deletedAt (non-null → skip), card:{id = printing id (cardid), uid = scryfall id, collectorNumber, rarity, prices{ck,tcg,...}, owned, edition{editioncode}, oracleCard{name,cmc,manaCost,colors,colorIdentity,types,subTypes,superTypes,text,faces,legalities,edhrecRank,salt,gameChanger,defaultCategory}}.
  - Commander = first category of card is a category with isPremier true (usually "Commander"). Category with includedInDeck false = maybeboard/sideboard. FIRST category decides inclusion.
- deckFormat: 3 = commander (1 standard, 2 modern, 4 legacy, 5 vintage, 6 pauper, 7 custom, 14 oathbreaker, 15 pioneer, 17 paupercommander, 20 brawl, 23 predh).
- Create (LIVE, 201): `POST /decks/v2/` body `{"name","description":"","deckFormat":3,"edhBracket":null,"parentFolder":null,"private":true,"unlisted":false,"theorycrafted":false,"game":null,"cardPackage":null,"extras":{"decksToInclude":[],"commandersToAdd":[],"forceCardsToSingleton":false,"ignoreCardsOutOfCommanderIdentity":true}}` → read `id`, then add cards.
- Copy (LIVE): `POST /decks/copy/` `{name,deckFormat,edhBracket,description,featured:"",playmat:"",copyId,private,unlisted:false,theorycrafted:false,game:null,parent_folder,cardPackage:null,extras:{}}`.
- Modify cards: `PATCH /decks/{id}/modifyCards/v2/` body `{"cards":[entry]}` — send ONE entry per request; re-read deck afterwards to verify.
  - add: `{"action":"add","cardid":<printingId>,"patchId":"<uuid hex>","categories":["Ramp"],"modifications":{"quantity":1,"companion":false,"flippedDefault":false,"modifier":"Normal"}}`
  - modify: same + `"deckRelationId":<cards[].id>`, action "modify"
  - remove: action "remove", deckRelationId, quantity 0
  - Commander → category "Commander"; maybeboard → "Maybeboard".
- Update metadata: `PATCH /decks/{id}/update/` subset of name, description, deckFormat, edhBracket, private, unlisted.
- Delete: `DELETE /decks/{id}/` → 204.

## Cards (LIVE)
- `GET /cards/v2/?name=<substring>&pageSize=` ; `exact=true` for exact oracle name (fails for DFC front face → substring + filter); `uids=<scryfall id>`; `edition=<set lowercase>&collectorNumber=`.
- Response `{results:[{id,uid,collectorNumber,options:["Normal","Foil"],edition:{editioncode},oracleCard:{name,...}}]}`.
- Name→cardid: exact=true → else substring + filter oracleCard.name / front face → prefer set+number match.

## Collection
- List (LIVE): `GET /collection/{userId}/v2/?page=&pageSize=(≤500)&cardName=` → `{results,count,page,totalPages,next,previous,tags,isPublic,owner}`; record `{id,quantity,modifier,language,condition,tags,purchasePrice,createdAt,game,card:{id,uid,edition,oracleCard}}`.
- Add (BUNDLE): `POST /collection/v2/` `{"game":1,"quantity":n,"card":<printingId>,"modifier":"Normal","condition":"NM","language":"EN"}`.
- Edit (BUNDLE): `PATCH /collection/v2/{recordId}/` full record `{game,id,quantity,card:<id>,modifier,language,condition,tags,purchasePrice}`.
- Delete (BUNDLE): `DELETE /collection/bulk/` body `{"ids":[...]}`.
- Verify every collection write by re-reading.

## Optional
- Folders: `GET /decks/folderTree/`; `POST /decks/folders/` `{name,private,parentFolder}`.
- Precons: `GET /decks/precons/`.
- Scryfall (https://api.scryfall.com) is a good secondary source for card text/rulings/legalities; 50–100 ms between calls, needs User-Agent + Accept.
