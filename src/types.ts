export interface Env {
  TOKEN_CACHE: KVNamespace;
  SERVICE_ACCOUNT_JSON: string;
  CONNECTOR_TOKEN: string;
}

export interface ServiceAccount {
  type: string;
  client_email: string;
  private_key: string;
  private_key_id: string;
  token_uri: string;
}

export interface CachedToken {
  access_token: string;
  expires_at: number;
}
