import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { registerAllTools } from "./tools/index";
import type { Env } from "./types";

const SERVER_NAME = "seo-mcp";
const SERVER_VERSION = "0.1.0";
const MCP_PREFIX = "/mcp/";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("seo-mcp alive", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
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
