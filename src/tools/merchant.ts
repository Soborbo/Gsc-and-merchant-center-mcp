import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAccessToken } from "../auth";
import type { Env } from "../types";

const BASE = "https://shoppingcontent.googleapis.com/content/v2.1";

function jsonContent(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorContent(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function wrap<T>(handler: (args: T) => Promise<ReturnType<typeof jsonContent>>) {
  return async (args: T) => {
    try {
      return await handler(args);
    } catch (err) {
      return errorContent(err);
    }
  };
}

async function mcFetch(env: Env, url: string): Promise<unknown> {
  const token = await getAccessToken(env);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    throw new Error(
      `Merchant Center API ${res.status} ${res.statusText}: ${
        typeof parsed === "string" ? parsed : JSON.stringify(parsed)
      }`,
    );
  }
  return parsed;
}

const listAccountsInput = {} as const;

const listProductsInput = {
  merchantId: z.string(),
  maxResults: z.number().int().min(1).max(250).optional().describe("Default 50."),
  pageToken: z.string().optional(),
};

const productIssuesInput = {
  merchantId: z.string(),
  maxResults: z.number().int().min(1).max(250).optional().describe("Default 100."),
  pageToken: z.string().optional(),
  destinations: z
    .array(z.enum(["Shopping", "Free listings", "Shopping ads"]))
    .optional(),
};

const accountIssuesInput = {
  merchantId: z.string(),
};

const getProductInput = {
  merchantId: z.string(),
  productId: z.string(),
};

export function registerMerchantTools(server: McpServer, env: Env): void {
  server.registerTool(
    "mc_list_accounts",
    {
      title: "List Merchant Center accounts",
      description:
        "List all Merchant Center accounts this connector has access to, including sub-accounts if it's a multi-client account (MCA).",
      inputSchema: listAccountsInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    wrap(async () => {
      const data = await mcFetch(env, `${BASE}/accounts/authinfo`);
      return jsonContent(data);
    }),
  );

  server.registerTool(
    "mc_list_products",
    {
      title: "List Merchant Center products",
      description:
        "List products in a Merchant Center account with pagination support. Use this for product inventory audits and bulk operations.",
      inputSchema: listProductsInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    wrap(async (args) => {
      const params = new URLSearchParams();
      params.set("maxResults", String(args.maxResults ?? 50));
      if (args.pageToken) params.set("pageToken", args.pageToken);
      const url = `${BASE}/${encodeURIComponent(args.merchantId)}/products?${params}`;
      const data = await mcFetch(env, url);
      return jsonContent(data);
    }),
  );

  server.registerTool(
    "mc_product_issues",
    {
      title: "Get Merchant Center product issues",
      description:
        "Get disapproved or warning-state products for a Merchant Center account. Returns products that are either fully disapproved or have item-level issues affecting visibility in Shopping ads and free listings.",
      inputSchema: productIssuesInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    wrap(async (args) => {
      const params = new URLSearchParams();
      params.set("maxResults", String(args.maxResults ?? 100));
      if (args.pageToken) params.set("pageToken", args.pageToken);
      if (args.destinations) {
        for (const d of args.destinations) params.append("destinations", d);
      }
      const url = `${BASE}/${encodeURIComponent(args.merchantId)}/productstatuses?${params}`;
      const data = (await mcFetch(env, url)) as {
        resources?: Array<{
          productId: string;
          title?: string;
          link?: string;
          itemLevelIssues?: unknown[];
          destinationStatuses?: Array<{
            status?: string;
            destination?: string;
          }>;
        }>;
        nextPageToken?: string;
      };

      const all = data.resources ?? [];
      const filtered = all.filter((p) => {
        const hasIssues = (p.itemLevelIssues?.length ?? 0) > 0;
        const notApproved =
          p.destinationStatuses?.some(
            (d) => d.status && d.status !== "approved",
          ) ?? false;
        return hasIssues || notApproved;
      });

      return jsonContent({
        merchantId: args.merchantId,
        totalScanned: all.length,
        problematicCount: filtered.length,
        nextPageToken: data.nextPageToken,
        products: filtered,
      });
    }),
  );

  server.registerTool(
    "mc_account_issues",
    {
      title: "Get Merchant Center account issues",
      description:
        "Get account-level issues, suspensions, and warnings for a Merchant Center account. Critical for catching account-wide problems that block all products.",
      inputSchema: accountIssuesInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    wrap(async (args) => {
      const mid = encodeURIComponent(args.merchantId);
      const url = `${BASE}/${mid}/accountstatuses/${mid}`;
      const data = await mcFetch(env, url);
      return jsonContent(data);
    }),
  );

  server.registerTool(
    "mc_get_product",
    {
      title: "Get Merchant Center product",
      description:
        "Get full details and current status for a single product including all attribute values and issue history.",
      inputSchema: getProductInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    wrap(async (args) => {
      const mid = encodeURIComponent(args.merchantId);
      const pid = encodeURIComponent(args.productId);
      const [product, status] = await Promise.all([
        mcFetch(env, `${BASE}/${mid}/products/${pid}`),
        mcFetch(env, `${BASE}/${mid}/productstatuses/${pid}`),
      ]);
      return jsonContent({ product, status });
    }),
  );
}
