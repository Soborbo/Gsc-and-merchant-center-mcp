import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAccessToken } from "../auth";
import type { Env } from "../types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ERROR_BODY = 500;
// GSC search analytics data is typically not fully populated for the last
// 2-3 days. Shift the window end back by this many days for freshness.
const GSC_FRESHNESS_LAG_DAYS = 3;

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

async function gscFetch(
  env: Env,
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  const token = await getAccessToken(env);
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${token}`,
    },
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
    throw new Error(`GSC API ${res.status} ${res.statusText}: ${clean}`);
  }
  return parsed;
}

const searchAnalyticsInput = {
  siteUrl: z
    .string()
    .describe(
      'GSC property identifier — "sc-domain:example.com" or "https://example.com/".',
    ),
  startDate: z.string().regex(DATE_RE).describe("YYYY-MM-DD"),
  endDate: z.string().regex(DATE_RE).describe("YYYY-MM-DD"),
  dimensions: z
    .array(
      z.enum([
        "query",
        "page",
        "country",
        "device",
        "date",
        "searchAppearance",
      ]),
    )
    .optional(),
  type: z
    .enum(["web", "image", "video", "news", "discover", "googleNews"])
    .optional(),
  rowLimit: z.number().int().min(1).max(25000).optional(),
  startRow: z.number().int().min(0).optional(),
  dimensionFilterGroups: z
    .array(z.unknown())
    .optional()
    .describe("Pass-through to the API. See GSC docs."),
};

const quickWinsInput = {
  siteUrl: z.string(),
  days: z.number().int().min(1).max(90).optional().describe("Default 28."),
  minImpressions: z.number().int().min(0).optional().describe("Default 100."),
  minPositionRange: z.number().min(1).optional().describe("Default 4."),
  maxPositionRange: z.number().min(1).optional().describe("Default 20."),
  maxCtr: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      "Max CTR threshold in percent (default 5 = 5%). Values <= 1 are interpreted as fractions and converted automatically.",
    ),
  rowLimit: z.number().int().min(1).max(5000).optional().describe("Default 50."),
};

const urlInspectionInput = {
  siteUrl: z.string(),
  inspectionUrl: z.string(),
  languageCode: z
    .string()
    .optional()
    .describe('e.g. "hu", "en-GB". Default "en".'),
};

const listSitemapsInput = {
  siteUrl: z.string(),
};

const getSitemapInput = {
  siteUrl: z.string(),
  sitemapUrl: z.string(),
};

export function registerGscTools(server: McpServer, env: Env): void {
  server.registerTool(
    "gsc_list_sites",
    {
      title: "List GSC properties",
      description:
        "List all Search Console properties this connector has access to.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    wrap(async () => {
      const data = await gscFetch(
        env,
        "https://searchconsole.googleapis.com/webmasters/v3/sites",
      );
      return jsonContent(data);
    }),
  );

  server.registerTool(
    "gsc_search_analytics",
    {
      title: "Search Analytics query",
      description:
        "Query Search Console performance data. Returns rows of impressions, clicks, CTR, and position grouped by the specified dimensions.",
      inputSchema: searchAnalyticsInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    wrap(async (args) => {
      const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
        args.siteUrl,
      )}/searchAnalytics/query`;
      const body: Record<string, unknown> = {
        startDate: args.startDate,
        endDate: args.endDate,
        rowLimit: args.rowLimit ?? 1000,
        startRow: args.startRow ?? 0,
      };
      if (args.dimensions) body.dimensions = args.dimensions;
      if (args.type) body.type = args.type;
      if (args.dimensionFilterGroups)
        body.dimensionFilterGroups = args.dimensionFilterGroups;
      const data = await gscFetch(env, url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return jsonContent(data);
    }),
  );

  server.registerTool(
    "gsc_quick_wins",
    {
      title: "Find SEO quick wins",
      description:
        "Find pages and queries with high impressions but suboptimal position (typically 4-20) — opportunities where small ranking improvements drive significant traffic gains. The query window ends ~3 days before today to account for GSC data freshness lag and is inclusive on both endpoints.",
      inputSchema: quickWinsInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    wrap(async (args) => {
      const days = args.days ?? 28;
      const minImpressions = args.minImpressions ?? 100;
      const minPos = args.minPositionRange ?? 4;
      const maxPos = args.maxPositionRange ?? 20;
      const maxCtrRaw = args.maxCtr ?? 5;
      const maxCtrPct = maxCtrRaw <= 1 ? maxCtrRaw * 100 : maxCtrRaw;
      const rowLimit = args.rowLimit ?? 50;

      const end = new Date();
      end.setUTCDate(end.getUTCDate() - GSC_FRESHNESS_LAG_DAYS);
      const start = new Date(end);
      start.setUTCDate(end.getUTCDate() - (days - 1));
      const fmt = (d: Date) => d.toISOString().slice(0, 10);

      const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
        args.siteUrl,
      )}/searchAnalytics/query`;
      const data = (await gscFetch(env, url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          startDate: fmt(start),
          endDate: fmt(end),
          dimensions: ["query", "page"],
          rowLimit: 5000,
        }),
      })) as {
        rows?: Array<{
          keys: string[];
          clicks: number;
          impressions: number;
          ctr: number;
          position: number;
        }>;
      };

      const rows = data.rows ?? [];
      const filtered = rows
        .filter(
          (r) =>
            r.position >= minPos &&
            r.position <= maxPos &&
            r.impressions >= minImpressions &&
            r.ctr * 100 < maxCtrPct,
        )
        .map((r) => ({
          query: r.keys[0],
          page: r.keys[1],
          clicks: r.clicks,
          impressions: r.impressions,
          ctr: r.ctr,
          position: r.position,
          opportunityScore: r.impressions * (1 - r.ctr),
        }))
        .sort((a, b) => b.opportunityScore - a.opportunityScore)
        .slice(0, rowLimit);

      return jsonContent({
        siteUrl: args.siteUrl,
        startDate: fmt(start),
        endDate: fmt(end),
        criteria: {
          minImpressions,
          minPositionRange: minPos,
          maxPositionRange: maxPos,
          maxCtrPct,
        },
        totalRowsScanned: rows.length,
        rows: filtered,
      });
    }),
  );

  server.registerTool(
    "gsc_url_inspection",
    {
      title: "Inspect URL in Search Console",
      description:
        "Get Search Console URL Inspection data for a specific URL — index status, last crawl date, mobile usability, structured data, AMP results.",
      inputSchema: urlInspectionInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    wrap(async (args) => {
      const data = await gscFetch(
        env,
        "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            siteUrl: args.siteUrl,
            inspectionUrl: args.inspectionUrl,
            languageCode: args.languageCode ?? "en",
          }),
        },
      );
      return jsonContent(data);
    }),
  );

  server.registerTool(
    "gsc_list_sitemaps",
    {
      title: "List sitemaps",
      description:
        "List all sitemaps submitted for a Search Console property.",
      inputSchema: listSitemapsInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    wrap(async (args) => {
      const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
        args.siteUrl,
      )}/sitemaps`;
      const data = await gscFetch(env, url);
      return jsonContent(data);
    }),
  );

  server.registerTool(
    "gsc_get_sitemap",
    {
      title: "Get sitemap details",
      description:
        "Get details for a specific sitemap including submission status, error counts, and content types.",
      inputSchema: getSitemapInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    wrap(async (args) => {
      const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
        args.siteUrl,
      )}/sitemaps/${encodeURIComponent(args.sitemapUrl)}`;
      const data = await gscFetch(env, url);
      return jsonContent(data);
    }),
  );
}
