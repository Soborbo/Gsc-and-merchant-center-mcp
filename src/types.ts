export interface Env {
  TOKEN_CACHE: KVNamespace;
  CONNECTOR_TOKEN: string;
  OAUTH_CLIENT_ID: string;
  OAUTH_CLIENT_SECRET: string;
  // Optional bootstrap fallback. Normally the refresh token is stored in KV by
  // the /oauth/start browser flow, so this secret is not needed.
  OAUTH_REFRESH_TOKEN?: string;
}

export interface CachedToken {
  access_token: string;
  expires_at: number;
}
