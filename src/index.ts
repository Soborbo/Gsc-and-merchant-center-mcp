import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { exchangeAuthCode, OAUTH_SCOPES } from "./auth";
import { registerAllTools } from "./tools/index";
import type { Env } from "./types";

const SERVER_NAME = "seo-mcp";
const SERVER_VERSION = "0.1.0";
const MCP_PREFIX = "/mcp/";
const OAUTH_CALLBACK_PATH = "/oauth/callback";
const OAUTH_STATE_PREFIX = "oauth:state:";
const OAUTH_STATE_TTL_SECONDS = 600;

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("seo-mcp alive", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (request.method === "GET" && url.pathname === "/oauth/start") {
      return handleOAuthStart(url, env);
    }

    if (request.method === "GET" && url.pathname === OAUTH_CALLBACK_PATH) {
      return handleOAuthCallback(url, env);
    }

    if (url.pathname.startsWith(MCP_PREFIX)) {
      const auth = checkPathToken(env, url.pathname);
      if (!auth.ok) {
        return new Response(`unauthorized: ${auth.reason}`, { status: 401 });
      }
      return handleMcpRequest(request, env);
    }

    return new Response("not found", { status: 404 });
  },
};

// Kicks off the Google OAuth consent flow. Guarded by CONNECTOR_TOKEN so only
// the operator (who knows the token) can re-authorise the connector.
async function handleOAuthStart(url: URL, env: Env): Promise<Response> {
  const provided = url.searchParams.get("token");
  if (
    !env.CONNECTOR_TOKEN ||
    !provided ||
    !constantTimeEqual(provided, env.CONNECTOR_TOKEN)
  ) {
    return new Response("unauthorized: bad or missing token", { status: 401 });
  }
  if (!env.OAUTH_CLIENT_ID) {
    return new Response("OAUTH_CLIENT_ID not configured", { status: 500 });
  }
  // Use a single-use random nonce as the OAuth state (stored in KV) rather than
  // the connector token, so the all-powerful CONNECTOR_TOKEN never travels
  // through Google's consent URL or the operator's browser history.
  const state = crypto.randomUUID();
  await env.TOKEN_CACHE.put(`${OAUTH_STATE_PREFIX}${state}`, "1", {
    expirationTtl: OAUTH_STATE_TTL_SECONDS,
  });
  const redirectUri = `${url.origin}${OAUTH_CALLBACK_PATH}`;
  const consent = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  consent.searchParams.set("client_id", env.OAUTH_CLIENT_ID);
  consent.searchParams.set("redirect_uri", redirectUri);
  consent.searchParams.set("response_type", "code");
  consent.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  // access_type=offline + prompt=consent are required to receive a refresh
  // token. Note: refresh tokens still expire after 7 days while the OAuth
  // consent screen is in "Testing" — publish the app to "In production".
  consent.searchParams.set("access_type", "offline");
  consent.searchParams.set("prompt", "consent");
  consent.searchParams.set("include_granted_scopes", "true");
  consent.searchParams.set("state", state);
  return Response.redirect(consent.toString(), 302);
}

// Handles the redirect back from Google, exchanging the auth code for tokens.
async function handleOAuthCallback(url: URL, env: Env): Promise<Response> {
  const state = url.searchParams.get("state");
  if (!state) {
    return htmlResponse("Auth failed: missing state.", 400);
  }
  // Validate and consume the single-use state nonce created by /oauth/start.
  const stateKey = `${OAUTH_STATE_PREFIX}${state}`;
  const known = await env.TOKEN_CACHE.get(stateKey).catch(() => null);
  if (!known) {
    return htmlResponse(
      "Auth failed: state mismatch or expired. Restart at /oauth/start.",
      400,
    );
  }
  await env.TOKEN_CACHE.delete(stateKey).catch(() => {});
  const error = url.searchParams.get("error");
  if (error) {
    return htmlResponse(`Auth failed: ${error}`, 400);
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return htmlResponse("Auth failed: no code returned.", 400);
  }
  try {
    const redirectUri = `${url.origin}${OAUTH_CALLBACK_PATH}`;
    const { hasRefreshToken } = await exchangeAuthCode(env, code, redirectUri);
    if (!hasRefreshToken) {
      return htmlResponse(
        "Authorised, but Google did not return a refresh token. Revoke the app at myaccount.google.com/permissions and try /oauth/start again.",
        200,
      );
    }
    return htmlResponse(
      "✅ Authorised. Refresh token stored. You can close this tab — the connector is ready.",
      200,
    );
  } catch (e) {
    return htmlResponse(`Auth failed: ${(e as Error).message}`, 500);
  }
}

function htmlResponse(message: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem"><p>${htmlEscape(message)}</p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

// Escape interpolated text (OAuth error / exception messages) before it lands
// in the HTML response, even though the callback is already gated by the state
// check.
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = buildServer(env);
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
    await server.close();
  }
}

function buildServer(env: Env): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      instructions:
        "Read-only access to Google Search Console (gsc_*) and Google Merchant Center (mc_*). Start with gsc_list_sites or mc_list_accounts to discover what the connector can see.",
    },
  );
  registerAllTools(server, env);
  return server;
}

function checkPathToken(
  env: Env,
  pathname: string,
): { ok: true } | { ok: false; reason: string } {
  const expected = env.CONNECTOR_TOKEN;
  if (!expected) return { ok: false, reason: "CONNECTOR_TOKEN not configured" };
  const provided = extractToken(pathname);
  if (!provided) return { ok: false, reason: "missing token" };
  if (!constantTimeEqual(provided, expected))
    return { ok: false, reason: "invalid token" };
  return { ok: true };
}

function extractToken(pathname: string): string | null {
  if (!pathname.startsWith(MCP_PREFIX)) return null;
  const rest = pathname.slice(MCP_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(0, slash);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
