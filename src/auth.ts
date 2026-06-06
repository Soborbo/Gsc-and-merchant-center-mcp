import type { CachedToken, Env, ServiceAccount } from "./types";

const SCOPE =
  "https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/content";
const TOKEN_CACHE_KEY = "google:access_token";
const FRESHNESS_SKEW_SECONDS = 300;
const TTL_SAFETY_SECONDS = 600;

export async function getAccessToken(env: Env): Promise<string> {
  if (!env.GA_SERVICE_ACCOUNT_JSON) {
    throw new Error("GA_SERVICE_ACCOUNT_JSON env var is not set");
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

  const sa = parseServiceAccount(env.GA_SERVICE_ACCOUNT_JSON);
  const now = nowSeconds();
  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";

  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: tokenUri,
    exp: now + 3600,
    iat: now,
  };

  const unsigned = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(
    JSON.stringify(claim),
  )}`;
  const signature = await sign(unsigned, sa.private_key);
  const assertion = `${unsigned}.${signature}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const res = await fetch(tokenUri, {
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
  if (typeof data.access_token !== "string" || typeof data.expires_in !== "number") {
    throw new Error("Token exchange returned an unexpected response shape");
  }

  const expiresAt = now + data.expires_in;
  const ttl = Math.max(60, data.expires_in - TTL_SAFETY_SECONDS);
  await env.TOKEN_CACHE.put(
    TOKEN_CACHE_KEY,
    JSON.stringify({ access_token: data.access_token, expires_at: expiresAt }),
    { expirationTtl: ttl },
  );

  return data.access_token;
}

function parseServiceAccount(raw: string): ServiceAccount {
  let parsed: ServiceAccount;
  try {
    parsed = JSON.parse(raw) as ServiceAccount;
  } catch {
    throw new Error("SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(
      "SERVICE_ACCOUNT_JSON is missing client_email or private_key",
    );
  }
  return parsed;
}

async function sign(data: string, pem: string): Promise<string> {
  const keyData = pemToArrayBuffer(pem);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(data),
  );
  return b64urlFromBytes(new Uint8Array(sig));
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const cleaned = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(cleaned);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
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

function b64urlEncode(s: string): string {
  return b64urlFromBytes(new TextEncoder().encode(s));
}

function b64urlFromBytes(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
