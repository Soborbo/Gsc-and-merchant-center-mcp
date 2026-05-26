import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGscTools } from "./gsc";
import { registerMerchantTools } from "./merchant";
import type { Env } from "../types";

export function registerAllTools(server: McpServer, env: Env): void {
  registerGscTools(server, env);
  registerMerchantTools(server, env);
}
