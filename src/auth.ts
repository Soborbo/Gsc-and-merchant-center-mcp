import type { CachedToken, Env, ServiceAccount } from "./types";

const SCOPE =
  "https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/content";
const TOKEN_CACHE_KEY = "google:access_token";

export async function getAccessToken(env: Env): Promise<string> {
  if (!env.SERVICE_ACCOUNT_JSON) {
    throw new Error("SERVICE_ACCOUNT_JSON env var is not set");
  }

  const cached = await env.TOKEN_CACHE.get(TOKEN_CACHE_KEY, "json").catch(
    () => null,
  ) as CachedToken | null;
  if (cached && cached.expires_at > Math.floor(Date.now() / 1000) + 60) {
    return cached.access_token;
  }

  const sa = JSON.parse(env.SERVICE_ACCOUNT_JSON) as ServiceAccount;
  if (!sa.client_email || !sa.private_key) {
    throw new Error("SERVICE_ACCOUNT_JSON missing client_email or private_key");
  }

  const now = Math.floor(Date.now() / 1000);
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
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(
      `Google token exchange failed ${res.status}: ${await res.text()}`,
    );
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };

  const expiresAt = now + data.expires_in;
  const ttl = Math.max(60, data.expires_in - 120);
  await env.TOKEN_CACHE.put(
    TOKEN_CACHE_KEY,
    JSON.stringify({ access_token: data.access_token, expires_at: expiresAt }),
    { expirationTtl: ttl },
  );

  return data.access_token;
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
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(cleaned);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

function b64urlEncode(s: string): string {
  return b64urlFromBytes(new TextEncoder().encode(s));
}

function b64urlFromBytes(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
