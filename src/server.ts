#!/usr/bin/env node

import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { z } from "zod";

dotenv.config();

type Json = Record<string, unknown>;

const API_BASE_URL = (process.env.PAYLO_API_BASE_URL || "https://usepaylo.com").replace(/\/$/, "");
const GPT_API_SECRET = process.env.PAYLO_GPT_API_SECRET || process.env.GPT_API_SECRET || "";
const PORT = Number(process.env.MCP_PORT || 3030);
const HOST = process.env.MCP_HOST || "0.0.0.0";
const DEFAULT_UTM_SOURCE = process.env.DEFAULT_UTM_SOURCE || "ai";

const sessionToSource = new Map<string, string>();
const transports: Record<string, SSEServerTransport> = {};

function parseApiKeyMap(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;

  for (const pair of raw.split(",")) {
    const [apiKey, source] = pair.split(":").map((v) => v?.trim());
    if (apiKey && source) {
      map.set(apiKey, source);
    }
  }
  return map;
}

const apiKeyToSource = parseApiKeyMap(process.env.MCP_API_KEY_SOURCES);

function getApiKeyFromRequest(req: { headers: Record<string, string | string[] | undefined>; query?: Record<string, unknown> }): string | null {
  const headerKey = req.headers["x-api-key"] || req.headers["x-paylo-api-key"];
  if (typeof headerKey === "string" && headerKey.trim()) {
    return headerKey.trim();
  }

  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }

  const queryValue = req.query?.apiKey;
  if (typeof queryValue === "string" && queryValue.trim()) {
    return queryValue.trim();
  }

  return null;
}

function resolveSourceForApiKey(apiKey: string | null): string | null {
  if (apiKey && apiKeyToSource.has(apiKey)) {
    return apiKeyToSource.get(apiKey) || "ai";
  }

  if (apiKeyToSource.size > 0) {
    return null;
  }

  return null;
}

function resolveSourceFromUserAgent(userAgent: string | undefined): string {
  const ua = (userAgent || "").toLowerCase();
  if (!ua) return "ai";

  if (ua.includes("claude") || ua.includes("anthropic")) return "claude";
  if (ua.includes("perplexity")) return "perplexity";
  if (ua.includes("gemini") || ua.includes("google") || ua.includes("bard")) return "gemini";
  if (ua.includes("chatgpt") || ua.includes("openai") || ua.includes("gpt")) return "chatgpt";
  if (ua.includes("copilot")) return "copilot";

  return "ai";
}

function withAIUTM(url: string, source: string): string {
  const u = new URL(url);
  u.searchParams.set("utm_source", source);
  u.searchParams.set("utm_medium", "ai_recommendation");
  u.searchParams.set("utm_campaign", "mcp_referral");
  return u.toString();
}

function applyUtmToAnyUrl(value: unknown, source: string): unknown {
  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    try {
      return withAIUTM(value, source);
    } catch {
      return value;
    }
  }

  if (Array.isArray(value)) {
    return value.map((item) => applyUtmToAnyUrl(item, source));
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = applyUtmToAnyUrl(v, source);
    }
    return out;
  }

  return value;
}

async function fetchFromApi<T>(path: string, search: URLSearchParams = new URLSearchParams()): Promise<T> {
  const url = `${API_BASE_URL}${path}${search.size ? `?${search.toString()}` : ""}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (GPT_API_SECRET) {
    headers["x-gpt-api-secret"] = GPT_API_SECRET;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed (${response.status}) for ${path}: ${text.slice(0, 300)}`);
  }

  return (await response.json()) as T;
}

function sourceFromExtra(extra: RequestHandlerExtra<any, any>): string {
  const sid = extra.sessionId;
  if (sid && sessionToSource.has(sid)) {
    return sessionToSource.get(sid) || "ai";
  }
  return "ai";
}

type StorefrontCatalogData = {
  storefront?: Record<string, unknown>;
  products?: unknown[];
  services?: unknown[];
  categories?: unknown[];
};

const server = new McpServer(
  {
    name: "paylo-catalog-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const mcp: any = server;

mcp.tool(
  "search_storefronts",
  "Search Paylo storefronts with optional query and category filters.",
  {
    query: z.string().optional(),
    category: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  async (args: any, extra: any) => {
    const source = sourceFromExtra(extra);
    const payload = await fetchFromApi<{ success: boolean; data?: { storefronts: any[] } }>("/api/gpt/storefronts");
    const storefronts = payload.data?.storefronts || [];

    const q = args.query?.toLowerCase().trim();
    const cat = args.category?.toLowerCase().trim();

    const filtered = storefronts
      .filter((store) => {
        const category = String(store.category || "").toLowerCase();
        const haystack = `${store.name || ""} ${store.slug || ""} ${store.description || ""} ${category}`.toLowerCase();
        if (q && !haystack.includes(q)) return false;
        if (cat && category !== cat) return false;
        return true;
      })
      .slice(0, args.limit || 50)
      .map((store) => ({
        ...store,
        urls: {
          storefront: withAIUTM(`${API_BASE_URL}/${store.slug}`, source),
          products: withAIUTM(`${API_BASE_URL}/api/gpt/catalog/${store.slug}/products`, source),
          services: withAIUTM(`${API_BASE_URL}/api/gpt/catalog/${store.slug}/services`, source),
          categories: withAIUTM(`${API_BASE_URL}/api/gpt/catalog/${store.slug}/categories`, source),
        },
      }));

    return {
      content: [{ type: "text", text: JSON.stringify({ storefronts: filtered, total: filtered.length }, null, 2) }],
    };
  }
);

mcp.tool(
  "get_storefront",
  "Get a storefront catalog summary and stats by slug.",
  {
    slug: z.string().min(1),
  },
  async (args: any, extra: any) => {
    const source = sourceFromExtra(extra);
    const params = new URLSearchParams({ utmSource: source });
    const payload = await fetchFromApi<{ success: boolean; data?: any }>(`/api/gpt/catalog/${encodeURIComponent(args.slug)}`, params);

    if (!payload.success || !payload.data) {
      throw new Error("Storefront not found");
    }

    const data = applyUtmToAnyUrl(payload.data, source) as StorefrontCatalogData;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              storefront: data.storefront,
              stats: {
                totalProducts: data.products?.length || 0,
                totalServices: data.services?.length || 0,
                totalCategories: data.categories?.length || 0,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

mcp.tool(
  "search_products",
  "Search products by query, optionally scoped to a storefront and category, with pagination.",
  {
    query: z.string().min(1),
    storefrontSlug: z.string().optional(),
    category: z.string().optional(),
    page: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  async (args: any, extra: any) => {
    const source = sourceFromExtra(extra);
    const page = args.page || 1;
    const limit = args.limit || 20;

    if (args.storefrontSlug) {
      const params = new URLSearchParams({
        search: args.query,
        page: String(page),
        limit: String(limit),
        utmSource: source,
      });
      if (args.category) params.set("category", args.category);

      const payload = await fetchFromApi<{ success: boolean; data?: any }>(
        `/api/gpt/catalog/${encodeURIComponent(args.storefrontSlug)}/products`,
        params
      );
      const data = applyUtmToAnyUrl(payload.data || {}, source);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    const storesPayload = await fetchFromApi<{ success: boolean; data?: { storefronts: Array<{ slug: string }> } }>("/api/gpt/storefronts");
    const storefronts = (storesPayload.data?.storefronts || []).slice(0, 12);
    const perStoreLimit = Math.max(1, Math.ceil(limit / Math.max(1, storefronts.length)));

    const results = await Promise.all(
      storefronts.map(async (store) => {
        const params = new URLSearchParams({
          search: args.query,
          page: "1",
          limit: String(perStoreLimit),
          utmSource: source,
        });
        if (args.category) params.set("category", args.category);

        const payload = await fetchFromApi<{ success: boolean; data?: any }>(`/api/gpt/catalog/${encodeURIComponent(store.slug)}/products`, params);
        const products = payload.data?.products || [];
        return products.map((product: Json) => ({ ...product, storefrontSlug: store.slug }));
      })
    );

    const products = applyUtmToAnyUrl(results.flat().slice(0, limit), source);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              products,
              pagination: {
                page,
                limit,
                total: Array.isArray(products) ? products.length : 0,
                totalPages: 1,
                hasMore: false,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

mcp.tool(
  "get_product",
  "Get a single product by storefront slug and product slug.",
  {
    storefrontSlug: z.string().min(1),
    productSlug: z.string().min(1),
  },
  async (args: any, extra: any) => {
    const source = sourceFromExtra(extra);
    const params = new URLSearchParams({ utmSource: source });
    const payload = await fetchFromApi<{ success: boolean; data?: any }>(
      `/api/gpt/catalog/${encodeURIComponent(args.storefrontSlug)}`,
      params
    );

    const products: Array<Record<string, unknown>> = payload.data?.products || [];
    const normalizedSlug = args.productSlug.toLowerCase();

    const byUrl = products.find((p) => {
      const url = typeof p?.urls === "object" && p.urls && typeof (p.urls as Json).product === "string" ? String((p.urls as Json).product) : "";
      if (!url) return false;
      try {
        const pathname = new URL(url).pathname.toLowerCase();
        return pathname.includes(`/${normalizedSlug}`);
      } catch {
        return url.toLowerCase().includes(normalizedSlug);
      }
    });

    const fallback = byUrl
      ? null
      : products.find((p) => {
          const name = String(p.name || "").toLowerCase();
          return name.includes(normalizedSlug.replace(/-/g, " "));
        });

    const product = applyUtmToAnyUrl(byUrl || fallback, source);

    if (!product) {
      throw new Error("Product not found");
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ product }, null, 2) }],
    };
  }
);

mcp.tool(
  "search_services",
  "Search services by query, optionally scoped to a storefront and category, with pagination.",
  {
    query: z.string().min(1),
    storefrontSlug: z.string().optional(),
    category: z.string().optional(),
    page: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  async (args: any, extra: any) => {
    const source = sourceFromExtra(extra);
    const page = args.page || 1;
    const limit = args.limit || 20;

    if (args.storefrontSlug) {
      const params = new URLSearchParams({
        search: args.query,
        page: String(page),
        limit: String(limit),
        utmSource: source,
      });
      if (args.category) params.set("category", args.category);

      const payload = await fetchFromApi<{ success: boolean; data?: any }>(
        `/api/gpt/catalog/${encodeURIComponent(args.storefrontSlug)}/services`,
        params
      );
      const data = applyUtmToAnyUrl(payload.data || {}, source);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    const storesPayload = await fetchFromApi<{ success: boolean; data?: { storefronts: Array<{ slug: string }> } }>("/api/gpt/storefronts");
    const storefronts = (storesPayload.data?.storefronts || []).slice(0, 12);
    const perStoreLimit = Math.max(1, Math.ceil(limit / Math.max(1, storefronts.length)));

    const results = await Promise.all(
      storefronts.map(async (store) => {
        const params = new URLSearchParams({
          search: args.query,
          page: "1",
          limit: String(perStoreLimit),
          utmSource: source,
        });
        if (args.category) params.set("category", args.category);

        const payload = await fetchFromApi<{ success: boolean; data?: any }>(`/api/gpt/catalog/${encodeURIComponent(store.slug)}/services`, params);
        const services = payload.data?.services || [];
        return services.map((service: Json) => ({ ...service, storefrontSlug: store.slug }));
      })
    );

    const services = applyUtmToAnyUrl(results.flat().slice(0, limit), source);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              services,
              pagination: {
                page,
                limit,
                total: Array.isArray(services) ? services.length : 0,
                totalPages: 1,
                hasMore: false,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

mcp.tool(
  "get_categories",
  "Get categories for a storefront slug.",
  {
    storefrontSlug: z.string().min(1),
  },
  async (args: any, extra: any) => {
    const source = sourceFromExtra(extra);
    const params = new URLSearchParams({ utmSource: source });
    const payload = await fetchFromApi<{ success: boolean; data?: any }>(
      `/api/gpt/catalog/${encodeURIComponent(args.storefrontSlug)}/categories`,
      params
    );

    const data = applyUtmToAnyUrl(payload.data || {}, source);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.server.onerror = (error) => {
  console.error("MCP server error:", error);
};

const app = createMcpExpressApp({ host: HOST });

app.get("/health", (_req: any, res: any) => {
  res.json({
    ok: true,
    service: "paylo-catalog-mcp",
    apiBaseUrl: API_BASE_URL,
    usingApiKeyMap: apiKeyToSource.size > 0,
  });
});

app.get("/sse", async (req: any, res: any) => {
  const apiKey = getApiKeyFromRequest(req as any);
  const mappedSource = resolveSourceForApiKey(apiKey);
  const source = mappedSource || resolveSourceFromUserAgent(req.headers["user-agent"]);

  if (apiKeyToSource.size > 0 && apiKey && !mappedSource) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  try {
    const transport = new SSEServerTransport("/messages", res);
    const sid = transport.sessionId;
    transports[sid] = transport;
    sessionToSource.set(sid, source);

    transport.onclose = () => {
      delete transports[sid];
      sessionToSource.delete(sid);
    };

    await server.connect(transport);
  } catch (error) {
    console.error("Failed to establish SSE transport:", error);
    if (!res.headersSent) {
      res.status(500).send("Failed to establish SSE stream");
    }
  }
});

app.post("/messages", async (req: any, res: any) => {
  const sessionId = req.query.sessionId;
  if (typeof sessionId !== "string" || !sessionId) {
    res.status(400).send("Missing sessionId");
    return;
  }

  const transport = transports[sessionId];
  if (!transport) {
    res.status(404).send("Session not found");
    return;
  }

  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP message:", error);
    if (!res.headersSent) {
      res.status(500).send("Failed to handle MCP message");
    }
  }
});

app.listen(PORT, () => {
  console.log(`Paylo catalog MCP SSE server listening on http://${HOST}:${PORT}`);
  console.log(`Connect with GET /sse and POST /messages?sessionId=<id>`);
});

process.on("SIGINT", async () => {
  try {
    for (const [sessionId, transport] of Object.entries(transports)) {
      await transport.close();
      delete transports[sessionId];
      sessionToSource.delete(sessionId);
    }
    await server.close();
  } finally {
    process.exit(0);
  }
});
