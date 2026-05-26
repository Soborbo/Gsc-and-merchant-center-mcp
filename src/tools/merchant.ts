import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAccessToken } from "../auth";
import type { Env } from "../types";

const BASE = "https://shoppingcontent.googleapis.com/content/v2.1";
const MAX_ERROR_BODY = 500;

const DESTINATIONS = [
  "Shopping",
  "ShoppingAds",
  "DisplayAds",
  "LocalInventoryAds",
  "FreeListings",
  "FreeLocalListings",
  "SurfacesAcrossGoogle",
  "YoutubeShopping",
] as const;

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

function wrap<T>(
  handler: (args: T) => Promise<ReturnType<typeof jsonContent>>,
) {
  return async (args: T) => {
    try {
      return await handler(args);
    } catch (err) {
      return errorContent(err);
    }
  };
}

function extractErrorMessage(body: unknown): string | null {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    typeof (body as { error: unknown }).error === "object" &&
    (body as { error: { message?: unknown } }).error !== null
  ) {
    const m = (body as { error: { message?: unknown } }).error.message;
    if (typeof m === "string") return m;
  }
  return null;
}

function clip(text: string): string {
  return text.length > MAX_ERROR_BODY ? text.slice(0, MAX_ERROR_BODY) : text;
}

// Encode a path segment while preserving colons so productId values like
// "online:en:US:sku123" reach the API in canonical form.
function encodePath(s: string): string {
  return encodeURIComponent(s).replace(/%3A/g, ":");
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
    const clean =
      extractErrorMessage(parsed) ??
      clip(typeof parsed === "string" ? parsed : JSON.stringify(parsed));
    throw new Error(
      `Merchant Center API ${res.status} ${res.statusText}: ${clean}`,
    );
  }
  return parsed;
}

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
    .array(z.enum(DESTINATIONS))
    .optional()
    .describe(
      "Content API destination enum values (PascalCase, no spaces): Shopping, ShoppingAds, FreeListings, DisplayAds, etc.",
    ),
  includePending: z
    .boolean()
    .optional()
    .describe(
      "If true, also surface 'pending' (in-review) products. Default false — only disapproved + warning-state items are returned.",
    ),
};

const accountIssuesInput = {
  merchantId: z
    .string()
    .describe("Owning Merchant Center account ID (the MCA ID for sub-accounts)."),
  accountId: z
    .string()
    .optional()
    .describe(
      "Optional sub-account ID under an MCA. Defaults to merchantId for non-MCA self-checks.",
    ),
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
        "List all Merchant Center accounts this connector has access to, including sub-accounts if it's a multi-client account (MCA). Returns full account details (id, name, websiteUrl, adultContent, sellerId) when accessible.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    wrap(async () => {
      const authinfo = (await mcFetch(
        env,
        `${BASE}/accounts/authinfo`,
      )) as {
        accountIdentifiers?: Array<{
          merchantId?: string;
          aggregatorId?: string;
        }>;
      };
      const ids = authinfo.accountIdentifiers ?? [];

      const results = await Promise.allSettled(
        ids.map(async (id) => {
          const owner = id.aggregatorId ?? id.merchantId;
          const target = id.merchantId ?? id.aggregatorId;
          if (!owner || !target) {
            return { identifier: id, error: "missing identifier" };
          }
          const url = `${BASE}/${encodeURIComponent(owner)}/accounts/${encodeURIComponent(target)}`;
          const account = await mcFetch(env, url);
          return account;
        }),
      );

      const accounts = results.map((r, i) =>
        r.status === "fulfilled"
          ? r.value
          : { identifier: ids[i], error: (r.reason as Error).message },
      );

      return jsonContent({ identifiers: ids, accounts });
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
        "Get disapproved or warning-state products for a Merchant Center account. Returns products that are either disapproved on at least one destination or have item-level issues affecting visibility in Shopping ads and free listings. 'pending' (in-review) products are excluded by default; pass includePending=true to surface them.",
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
      const includePending = args.includePending === true;
      const filtered = all.filter((p) => {
        const hasIssues = (p.itemLevelIssues?.length ?? 0) > 0;
        const hasDisapproved =
          p.destinationStatuses?.some((d) => d.status === "disapproved") ??
          false;
        const hasPending =
          p.destinationStatuses?.some((d) => d.status === "pending") ?? false;
        return hasIssues || hasDisapproved || (includePending && hasPending);
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
        "Get account-level issues, suspensions, and warnings for a Merchant Center account. Critical for catching account-wide problems that block all products. For MCA setups, pass accountId to inspect a specific sub-account.",
      inputSchema: accountIssuesInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    wrap(async (args) => {
      const owner = encodeURIComponent(args.merchantId);
      const target = encodeURIComponent(args.accountId ?? args.merchantId);
      const url = `${BASE}/${owner}/accountstatuses/${target}`;
      const data = await mcFetch(env, url);
      return jsonContent(data);
    }),
  );

  server.registerTool(
    "mc_get_product",
    {
      title: "Get Merchant Center product",
      description:
        "Get full details and current status for a single product including all attribute values and issue history. Either fetch may fail independently (e.g. productstatuses 404 on uncrawled items) — partial results are returned.",
      inputSchema: getProductInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    wrap(async (args) => {
      const mid = encodeURIComponent(args.merchantId);
      const pid = encodePath(args.productId);
      const [productRes, statusRes] = await Promise.allSettled([
        mcFetch(env, `${BASE}/${mid}/products/${pid}`),
        mcFetch(env, `${BASE}/${mid}/productstatuses/${pid}`),
      ]);
      if (productRes.status === "rejected" && statusRes.status === "rejected") {
        throw new Error(
          `Both product and productstatuses fetches failed. product: ${
            (productRes.reason as Error).message
          } | status: ${(statusRes.reason as Error).message}`,
        );
      }
      return jsonContent({
        product:
          productRes.status === "fulfilled"
            ? productRes.value
            : { error: (productRes.reason as Error).message },
        status:
          statusRes.status === "fulfilled"
            ? statusRes.value
            : { error: (statusRes.reason as Error).message },
      });
    }),
  );
}
