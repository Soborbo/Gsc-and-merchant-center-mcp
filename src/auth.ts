import type { CachedToken, Env } from "./types";

const TOKEN_CACHE_KEY = "google:access_token";
const REFRESH_TOKEN_KEY = "google:refresh_token";
const FRESHNESS_SKEW_SECONDS = 300;
const TTL_SAFETY_SECONDS = 600;
const TOKEN_URI = "https://oauth2.googleapis.com/token";

// The connector authenticates as a Google user (OAuth), not a service account,
// so it inherits that user's existing access to every Search Console property
// and Merchant Center account — no per-property sharing required.
export const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/content",
];

// Returns a valid Google access token, refreshing via the stored refresh token
// when the cached access token is missing or about to expire.
export async function getAccessToken(env: Env): Promise<string> {
  if (!env.OAUTH_CLIENT_ID || !env.OAUTH_CLIENT_SECRET) {
    throw new Error("OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET must be set");
  }

  const cached = (await env.TOKEN_CACHE.get(TOKEN_CACHE_KEY, "json").catch(
    () => null,
  )) as CachedToken | null;
  if (
    cached &&
    typeof cached.access_token === "string" &&
    typeof cached.expires_at === "number" &&
    cached.expires_at > nowSeconds() + FRESHNESS_SKEW_SECONDS
  ) {
    return cached.access_token;
  }

  const refreshToken = await getRefreshToken(env);
  if (!refreshToken) {
    throw new Error("No refresh token stored. Visit /oauth/start to authorise.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: env.OAUTH_CLIENT_ID,
    client_secret: env.OAUTH_CLIENT_SECRET,
  });

  const res = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(
      `Google token exchange failed ${res.status}: ${await safeText(res)}`,
    );
  }
  const data = (await res.json()) as Partial<{
    access_token: string;
    expires_in: number;
  }>;
  if (
    typeof data.access_token !== "string" ||
    typeof data.expires_in !== "number"
  ) {
    throw new Error("Token exchange returned an unexpected response shape");
  }

  const expiresAt = nowSeconds() + data.expires_in;
  const ttl = Math.max(60, data.expires_in - TTL_SAFETY_SECONDS);
  await env.TOKEN_CACHE.put(
    TOKEN_CACHE_KEY,
    JSON.stringify({ access_token: data.access_token, expires_at: expiresAt }),
    { expirationTtl: ttl },
  );

  return data.access_token;
}

// The refresh token is written to KV by the OAuth callback. OAUTH_REFRESH_TOKEN
// is an optional secret fallback for bootstrapping without the browser flow.
async function getRefreshToken(env: Env): Promise<string | null> {
  const fromKv = await env.TOKEN_CACHE.get(REFRESH_TOKEN_KEY, "text").catch(
    () => null,
  );
  if (fromKv && fromKv.length > 0) return fromKv;
  if (env.OAUTH_REFRESH_TOKEN && env.OAUTH_REFRESH_TOKEN.length > 0) {
    return env.OAUTH_REFRESH_TOKEN;
  }
  return null;
}

// Exchanges the authorization code from the OAuth callback for tokens, storing
// the refresh token (and seeding the access-token cache) in KV.
export async function exchangeAuthCode(
  env: Env,
  code: string,
  redirectUri: string,
): Promise<{ hasRefreshToken: boolean }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: env.OAUTH_CLIENT_ID,
    client_secret: env.OAUTH_CLIENT_SECRET,
    redirect_uri: redirectUri,
  });

  const res = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(
      `Authorization code exchange failed ${res.status}: ${await safeText(res)}`,
    );
  }
  const data = (await res.json()) as Partial<{
    refresh_token: string;
    access_token: string;
    expires_in: number;
  }>;

  if (typeof data.refresh_token === "string" && data.refresh_token.length > 0) {
    await env.TOKEN_CACHE.put(REFRESH_TOKEN_KEY, data.refresh_token);
  }
  if (
    typeof data.access_token === "string" &&
    typeof data.expires_in === "number"
  ) {
    const expiresAt = nowSeconds() + data.expires_in;
    const ttl = Math.max(60, data.expires_in - TTL_SAFETY_SECONDS);
    await env.TOKEN_CACHE.put(
      TOKEN_CACHE_KEY,
      JSON.stringify({ access_token: data.access_token, expires_at: expiresAt }),
      { expirationTtl: ttl },
    );
  }

  return { hasRefreshToken: typeof data.refresh_token === "string" };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<no body>";
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
