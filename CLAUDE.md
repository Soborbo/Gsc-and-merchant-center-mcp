# seo-mcp — Cloudflare Worker

Google Search Console + Google Merchant Center adatok exponálása MCP szerverként Claude.ai connectorhoz. A meglévő `ga4-mcp` worker mintáját követi, mellette fut, attól független.

## Mission

Egy Cloudflare Worker, ami:
- Google user OAuth-tal (authorization code + refresh token) csatlakozik a Google API-khoz
- MCP protokollon kommunikál Claude-dal a connector URL-en keresztül
- 11 tool-t expose-ol: 6 GSC + 5 Merchant Center
- Single tenant (egy OAuth-fiók, több ügyfél property)

Nem ad hozzá GA4 tool-t. A `ga4-mcp` worker érintetlenül marad.

## Stack

| Komponens | Verzió | Megjegyzés |
|-----------|--------|-----------|
| Runtime | Cloudflare Workers | nem Pages |
| Nyelv | TypeScript 5.x | strict mode |
| MCP SDK | `@modelcontextprotocol/sdk` legújabb | ugyanaz mint ga4-mcp |
| Validáció | `zod` legújabb | tool input schema |
| Build | `wrangler` 3.x | nincs külön bundler |
| Csomagkezelő | `pnpm` | az ügyfélprojektek mintáját követi |

Tilos: hono, itty-router, express, vagy bármilyen extra framework. A worker `fetch` handlerből indul, az MCP SDK kezeli a routingot.

## Architektúra

### Request flow

```
Claude → POST https://seo-mcp.golaxo.workers.dev/mcp/{CONNECTOR_TOKEN}
  ↓
Worker: validate CONNECTOR_TOKEN against env
  ↓
MCP SDK: parse JSON-RPC, route to tool handler
  ↓
Tool handler:
  1. Resolve access_token from getAccessToken(env)
  2. Build Google API request
  3. fetch(url, { Authorization: `Bearer ${token}` })
  4. Format response → MCP tool result
```

### Auth flow

A connector egy Google **user** nevében hitelesít (OAuth 2.0 authorization code + refresh token), NEM service accounttal. Így örökli a felhasználó meglévő hozzáférését minden GSC property-hez és Merchant Center fiókhoz — nincs per-property megosztás.

Egyszeri authorizáció (böngészőből):

```
GET /oauth/start?token={CONNECTOR_TOKEN}
  → redirect az accounts.google.com consent oldalra
     (scope: webmasters.readonly + content, access_type=offline, prompt=consent)
  → Google visszairányít: /oauth/callback?code=...&state={CONNECTOR_TOKEN}
  → exchangeAuthCode: code → refresh_token, KV-be mentve ("google:refresh_token")
```

Tokenfeloldás minden tool híváskor:

```
getAccessToken(env):
  1. KV cache (TOKEN_CACHE) "google:access_token" → ha van ÉS expires_at > now + 300s → cached
  2. refresh_token feloldása: KV "google:refresh_token", fallback env.OAUTH_REFRESH_TOKEN
     - ha egyik sincs → hiba: "Visit /oauth/start to authorise."
  3. POST https://oauth2.googleapis.com/token
     - grant_type = "refresh_token"
     - refresh_token + client_id (OAUTH_CLIENT_ID) + client_secret (OAUTH_CLIENT_SECRET)
  4. access_token KV-be cache-elve, TTL = expires_in - 600s
  5. Return access_token
```

⚠️ "Testing" státuszú OAuth consent screen mellett a refresh token 7 nap után lejár. Tartós működéshez az OAuth appot **In production** állapotba kell tenni (lásd Google Cloud setup).

## Environment & Bindings

`wrangler.toml`:

```toml
name = "seo-mcp"
main = "src/index.ts"
compatibility_date = "2026-05-26"
compatibility_flags = ["nodejs_compat"]

[[kv_namespaces]]
binding = "TOKEN_CACHE"
id = "<létrehozandó>"

[vars]
# nincs publikus var

# secrets (wrangler secret put):
# OAUTH_CLIENT_ID       — Google OAuth 2.0 web client ID
# OAUTH_CLIENT_SECRET   — Google OAuth 2.0 web client secret
# CONNECTOR_TOKEN       — 32-64 karakter hex string; URL path + /oauth/start védelme
# OAUTH_REFRESH_TOKEN   — opcionális fallback; normál esetben a KV-ben (lásd /oauth/start)
```

KV namespace létrehozás:
```bash
wrangler kv namespace create TOKEN_CACHE
```

Secret feltöltés:
```bash
wrangler secret put OAUTH_CLIENT_ID
wrangler secret put OAUTH_CLIENT_SECRET
wrangler secret put CONNECTOR_TOKEN
# beírod a generált hex stringet
```

Authorizáció (egyszeri, böngészőből), miután a secret-ek megvannak:
```
https://seo-mcp.golaxo.workers.dev/oauth/start?token={CONNECTOR_TOKEN}
```

Connector token generálás (egyszer, manuálisan):
```bash
openssl rand -hex 32
```

## File structure

```
seo-mcp/
├── wrangler.toml
├── package.json
├── tsconfig.json
├── .gitignore
└── src/
    ├── index.ts              # Worker entry point, MCP init, /oauth routes
    ├── auth.ts               # getAccessToken + OAuth refresh / code exchange
    ├── tools/
    │   ├── index.ts          # tool registration aggregator
    │   ├── gsc.ts            # 6 GSC tool
    │   └── merchant.ts       # 5 Merchant Center tool
    └── types.ts              # Env, shared types
```

Nincs `lib/`, `utils/`, `helpers/`. Lapos, kétszintű struktúra. Ha valami nem fér a fenti fájlokba, az új tool-csoport és új fájl kell a `tools/` alatt.

## Tools

A tool nevek kisbetűsek, snake_case, max 40 karakter. A description-ök 1-2 mondatosak, magyarázó, nem marketing tone.

### GSC tools

#### gsc_list_sites
**Description:** List all Search Console properties this connector has access to.

**Input:** nincs paraméter.

**Output:** array of `{siteUrl, permissionLevel}`.

**API:** `GET https://searchconsole.googleapis.com/webmasters/v3/sites`

---

#### gsc_search_analytics
**Description:** Query Search Console performance data. Returns rows of impressions, clicks, CTR, and position grouped by the specified dimensions.

**Input:**
```ts
{
  siteUrl: string,           // pl. "sc-domain:trapezlemezes.hu" vagy "https://painlessremovals.com/"
  startDate: string,         // YYYY-MM-DD
  endDate: string,           // YYYY-MM-DD
  dimensions?: ("query" | "page" | "country" | "device" | "date" | "searchAppearance")[],
  type?: "web" | "image" | "video" | "news" | "discover" | "googleNews",
  rowLimit?: number,         // max 25000, default 1000
  startRow?: number,         // pagination, default 0
  dimensionFilterGroups?: any[]  // pass-through to API, see GSC docs
}
```

**Output:** `{rows: [...], responseAggregationType: string}`.

**API:** `POST https://searchconsole.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query`

Note: `siteUrl` URL-encoded a path-ban.

---

#### gsc_quick_wins
**Description:** Find pages and queries with high impressions but suboptimal position (typically 4-20) — opportunities where small ranking improvements drive significant traffic gains.

**Input:**
```ts
{
  siteUrl: string,
  days: number,              // utolsó X nap, default 28, max 90
  minImpressions?: number,   // default 100
  minPositionRange?: number, // default 4
  maxPositionRange?: number, // default 20
  maxCtr?: number,           // default 5 (százalék)
  rowLimit?: number          // default 50
}
```

**Output:** filtered + sorted rows, prioritized by `impressions * (1 - ctr)` descending.

**Behavior:**
1. Call `gsc_search_analytics` internally with `dimensions: ["query", "page"]`, `rowLimit: 5000`.
2. Filter: `position >= minPositionRange AND position <= maxPositionRange AND impressions >= minImpressions AND ctr * 100 < maxCtr`.
3. Sort by `impressions * (1 - ctr)` descending.
4. Return top `rowLimit` rows with all metrics.

---

#### gsc_url_inspection
**Description:** Get Search Console URL Inspection data for a specific URL — index status, last crawl date, mobile usability, structured data, AMP results.

**Input:**
```ts
{
  siteUrl: string,
  inspectionUrl: string,
  languageCode?: string      // pl. "hu", "en-GB", default "en"
}
```

**Output:** full `inspectionResult` object from the API.

**API:** `POST https://searchconsole.googleapis.com/v1/urlInspection/index:inspect`

---

#### gsc_list_sitemaps
**Description:** List all sitemaps submitted for a Search Console property.

**Input:** `{ siteUrl: string }`

**Output:** array of `{path, lastSubmitted, isPending, errors, warnings, contents}`.

**API:** `GET https://searchconsole.googleapis.com/webmasters/v3/sites/{siteUrl}/sitemaps`

---

#### gsc_get_sitemap
**Description:** Get details for a specific sitemap including submission status, error counts, and content types.

**Input:** `{ siteUrl: string, sitemapUrl: string }`

**Output:** single sitemap object.

**API:** `GET https://searchconsole.googleapis.com/webmasters/v3/sites/{siteUrl}/sitemaps/{sitemapUrl}`

---

### Merchant Center tools

A Merchant Center-hez a **Content API for Shopping v2.1**-et használjuk (`shoppingcontent.googleapis.com`), nem az új Merchant API-t. Indok: a v2.1 stabil, dokumentált, és teljes lefedettsége van mindennek amit itt csinálunk. Az új Merchant API still in transition, és nem nyer vele az ügyfélmunka. Ha a v2.1 deprecate-elődik, akkor migráció külön ticket.

#### mc_list_accounts
**Description:** List all Merchant Center accounts this connector has access to, including sub-accounts if it's a multi-client account (MCA).

**Input:** nincs paraméter.

**Output:** array of `{id, name, websiteUrl, adultContent, sellerId}`.

**API:** `GET https://shoppingcontent.googleapis.com/content/v2.1/accounts/authinfo` — listázza, hogy az OAuth-fiók melyik account-okat éri el.

Note: ha sub-accountok vannak, ezekhez külön `accounts/{merchantId}/accounts` hívás kellhet.

---

#### mc_list_products
**Description:** List products in a Merchant Center account with pagination support. Use this for product inventory audits and bulk operations.

**Input:**
```ts
{
  merchantId: string,
  maxResults?: number,       // default 50, max 250
  pageToken?: string         // pagination cursor
}
```

**Output:** `{ resources: [...products], nextPageToken?: string }`.

**API:** `GET https://shoppingcontent.googleapis.com/content/v2.1/{merchantId}/products`

---

#### mc_product_issues
**Description:** Get disapproved or warning-state products for a Merchant Center account. Returns products that are either fully disapproved or have item-level issues affecting visibility in Shopping ads and free listings.

**Input:**
```ts
{
  merchantId: string,
  maxResults?: number,       // default 100, max 250
  pageToken?: string,
  destinations?: ("Shopping" | "Free listings" | "Shopping ads")[]
}
```

**Output:** array of `{productId, title, link, itemLevelIssues: [...], destinationStatuses: [...]}`.

**Behavior:**
1. Call `productstatuses.list` with `destinations` filter.
2. Filter to only products where `destinationStatuses[].status != "approved"` OR `itemLevelIssues.length > 0`.
3. Return product details with all attached issues.

**API:** `GET https://shoppingcontent.googleapis.com/content/v2.1/{merchantId}/productstatuses`

---

#### mc_account_issues
**Description:** Get account-level issues, suspensions, and warnings for a Merchant Center account. Critical for catching account-wide problems that block all products.

**Input:** `{ merchantId: string }`

**Output:** array of `{id, title, severity, impact, documentation}`.

**API:** `GET https://shoppingcontent.googleapis.com/content/v2.1/{merchantId}/accountstatuses/{merchantId}`

---

#### mc_get_product
**Description:** Get full details and current status for a single product including all attribute values and issue history.

**Input:** `{ merchantId: string, productId: string }`

**Output:** `{ product: {...}, status: {...} }` — combined product resource and status.

**Behavior:** parallel fetch of `products.get` and `productstatuses.get`, merged in response.

**API:**
- `GET https://shoppingcontent.googleapis.com/content/v2.1/{merchantId}/products/{productId}`
- `GET https://shoppingcontent.googleapis.com/content/v2.1/{merchantId}/productstatuses/{productId}`

---

## Implementation patterns

### Tool registration pattern

Match the ga4-mcp pattern exactly. Each tool is registered with the MCP server using zod schemas:

```ts
server.tool(
  "gsc_search_analytics",
  "Query Search Console performance data. Returns rows of impressions, clicks, CTR, and position grouped by the specified dimensions.",
  {
    siteUrl: z.string(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dimensions: z.array(z.enum(["query", "page", "country", "device", "date", "searchAppearance"])).optional(),
    // ...
  },
  async (args) => {
    const token = await getAccessToken(env);
    const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(args.siteUrl)}/searchAnalytics/query`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        startDate: args.startDate,
        endDate: args.endDate,
        dimensions: args.dimensions,
        rowLimit: args.rowLimit ?? 1000,
        // ...
      })
    });
    if (!res.ok) {
      throw new Error(`GSC API ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);
```

### Error handling

- Non-2xx API response → throw with status code and response body in message
- Missing required env var at startup → throw on first request, descriptive error
- Invalid CONNECTOR_TOKEN in URL → respond `401 Unauthorized`, do not reach MCP layer
- Token cache miss + token exchange failure → throw with Google's error body included

Don't swallow errors. Don't return empty arrays on API failure. Claude needs to see what went wrong.

### Output formatting

All tool responses return MCP `content: [{type: "text", text: JSON.stringify(data, null, 2)}]`. No custom HTML, no markdown formatting, no truncation. The LLM consumes raw JSON best.

Exception: `gsc_quick_wins` — sort rows server-side, but still return JSON (not a formatted table).

## Google Cloud setup

Single Google Cloud project shared with ga4-mcp acceptable. Új project is OK ha el akarod különíteni.

### APIs to enable

```
Search Console API           https://console.cloud.google.com/apis/library/searchconsole.googleapis.com
Content API for Shopping     https://console.cloud.google.com/apis/library/shoppingcontent.googleapis.com
```

### OAuth client

A worker egy Google OAuth 2.0 **web application** klienst használ (nem service accountot).

1. Google Cloud Console → APIs & Services → Credentials → Create credentials → OAuth client ID
2. Application type: **Web application**
3. Authorized redirect URI: `https://seo-mcp.golaxo.workers.dev/oauth/callback`
   (lokális teszthez: `http://localhost:8787/oauth/callback`)
4. Client ID → `OAUTH_CLIENT_ID` secret, Client secret → `OAUTH_CLIENT_SECRET` secret

### OAuth consent screen

1. APIs & Services → OAuth consent screen (újabb UI: Google Auth Platform → Audience)
2. User type: **External** (sima Gmail-fiókkal nincs Internal opció)
3. Scope-ok: `webmasters.readonly` + `content`
4. **Publishing status: In production.** Kritikus: "Testing" módban a refresh token 7 nap után lejár, és kézzel újra kell authorizálni (`/oauth/start`). Production módban tartós marad.
   - Sensitive scope-ok miatt megjelenhet "unverified app" figyelmeztetés — saját használatra a consent oldalon átkattintható (Advanced → Go to seo-mcp). Teljes Google-verifikáció a tartós tokenhez nem szükséges.

### Property hozzáférés

Nincs per-property megosztás. A connector az authorizáló Google user nevében hív, így automatikusan látja annak minden GSC property-jét és Merchant Center fiókját. Az authorizáló fióknak GSC-ben legalább **Full** jogosultság kell (Restricted nem elég URL inspection-höz), Merchant Centerben legalább olvasási jog az adott account-on.

## Local development

```bash
pnpm install
pnpm wrangler dev
```

A `wrangler dev` lokálisan futtatja a workert `http://localhost:8787/mcp/{CONNECTOR_TOKEN}`-on. Teszteléshez használj curl-t MCP JSON-RPC payload-dal, vagy az MCP Inspector-t.

`.dev.vars` fájl a lokális secret-eknek:
```
OAUTH_CLIENT_ID=xxxxx.apps.googleusercontent.com
OAUTH_CLIENT_SECRET=xxxxx
CONNECTOR_TOKEN=local-dev-token-abc123
# opcionális: OAUTH_REFRESH_TOKEN=xxxxx (különben /oauth/start a localhoston)
```

A `.dev.vars` **gitignore-ban** kell legyen. Ne committold soha.

## Deployment

```bash
pnpm wrangler deploy
```

A worker `seo-mcp.golaxo.workers.dev`-en lesz elérhető. A Claude connector URL:

```
https://seo-mcp.golaxo.workers.dev/mcp/{CONNECTOR_TOKEN}
```

Ezt add hozzá Claude → Settings → Connectors → Add custom connector.

## Definition of Done

A projekt akkor kész, ha **mind a 11 alábbi teljesül**:

1. `pnpm wrangler deploy` hibamentesen lefut, worker él a `.workers.dev` címen
2. Claude connector hozzáadás sikeres, mind a 11 tool látszik a Claude tool listájában
3. `gsc_list_sites` visszaad legalább 1 property-t (az authorizáló OAuth-fiók GSC property-i)
4. `gsc_search_analytics` lefut trapezlemezes.hu-ra utolsó 28 napra, query+page dimensionnel, ad vissza rows-t
5. `gsc_quick_wins` lefut, ad vissza prioritizált listát egy működő property-re
6. `gsc_url_inspection` lefut egy konkrét URL-re, ad vissza index status-t
7. `gsc_list_sitemaps` visszaad legalább 1 sitemap-et trapezlemezes.hu-ra
8. `mc_list_accounts` visszaad legalább 1 Merchant accountot (ha van merchant access)
9. `mc_product_issues` lefut, akár 0 issue-t ad vissza, akár listát
10. `mc_account_issues` lefut hibamentesen
11. KV token cache működik: második hívás 100ms alatt befejeződik (nincs új token exchange)

Nem DoD: dokumentáció, README, tesztek. Ezeket utólag, ha napi munkában beválik.

## Anti-patterns — what NOT to do

- **Ne** rakj a worker kódjába hardcoded property listát vagy ügyfél specifikus konfigot. Multi-client = paraméterben adott `siteUrl` / `merchantId`.
- **Ne** csinálj caching layer-t a tool response-okra. KV cache csak az access token-re van. A search analytics adat mindig fresh kell legyen.
- **Ne** válts vissza service account JWT-re. A connector user OAuth-tal megy (refresh token a KV-ben); a service account per-property megosztást igényelne.
- **Ne** hagyd védtelenül a `/oauth/start`-ot — a `CONNECTOR_TOKEN` query param védi, mert az indítja a Google consentet, és csak az operátor futtathatja.
- **Ne** logolj request body-t vagy access token-t a console-ba. Production worker-ben minden log látszik a Cloudflare dashboard-on.
- **Ne** írj absztrakciós layer-t a Google API hívások köré ("GoogleApiClient class"). Minden tool közvetlenül `fetch()`-el. Egyszerűbb debug, kevesebb kód.
- **Ne** adj hozzá tool-okat ami nincs a fenti listában. Ha új igény van, írj új CLAUDE.md-t hozzá, vagy update-eld ezt.
- **Ne** dolgozz a `ga4-mcp` workeren ehhez a projekthez. Az érintetlen marad.
- **Ne** csinálj GitHub repo-t public-ra ezzel a kóddal. A `wrangler.toml`-ben szerepel a `golaxo` account neve és a worker név. Private repo, vagy ne push-old.

## Out of scope

A következőkre **nem** vonatkozik ez a projekt, ezeket NE csináld meg:

- Google Trends connector — alpha API, később
- Google Ads connector — Pipeboard MCP-vel van lefedve, nem duplikáljuk
- Multi-tenant OAuth (per-user dinamikus tokenek) — single-tenant, egy fix OAuth-fiók elég a use case-re
- Frontend / dashboard / UI — ez egy MCP backend, Claude a UI
- Email reportok / cron jobok — ha kell, külön worker
- Funnel report (GA4-be tartozik, ha kell add hozzá a ga4-mcp-hez)
