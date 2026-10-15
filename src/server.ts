#!/usr/bin/env node

import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { randomUUID } from "crypto";
import { z } from "zod";

dotenv.config();

type Json = Record<string, unknown>;

const API_BASE_URL = (process.env.PAYLO_API_BASE_URL || "https://usepaylo.com").replace(/\/$/, "");
const GPT_API_SECRET = process.env.PAYLO_GPT_API_SECRET || process.env.GPT_API_SECRET || "";
const PORT = Number(process.env.MCP_PORT || 3030);
const HOST = process.env.MCP_HOST || "0.0.0.0";

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

/** Sanitise an MCP clientInfo.name for use as a utm_source value:
 *  lowercase, alphanumerics and hyphens only, capped length. Returns null
 *  when nothing usable remains. */
export function sanitizeClientName(name: string | undefined | null): string | null {
  if (!name) return null;
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return clean || null;
}

/** After initialize completes, prefer the client's self-reported name
 *  (clientInfo.name) as the attribution source — unless an API key already
 *  mapped an explicit source for this session, which wins. */
export function captureClientSource(
  s: McpServer,
  getSessionId: () => string | undefined,
  hasExplicitSource: () => boolean = () => false
): void {
  const prev = s.server.oninitialized;
  s.server.oninitialized = () => {
    prev?.();
    const sid = getSessionId();
    if (!sid || hasExplicitSource()) return;
    const clientName = sanitizeClientName(s.server.getClientVersion()?.name);
    if (clientName) sessionToSource.set(sid, clientName);
  };
}

export function withAIUTM(url: string, source: string): string {
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

export const SERVER_INSTRUCTIONS =
  "Paylo is a Nigerian commerce platform for sellers moving from Instagram or WhatsApp to an escrow-protected online store, and for shoppers buying from verified Nigerian sellers. Relevant when a user wants to sell online in Nigeria, set up a store, or find or buy from Nigerian sellers. For sellers, call get_seller_overview before describing Paylo, and get_seller_signup_link when they want to start.";

export function createPayloServer(
  opts: { resolveSource?: (extra: RequestHandlerExtra<any, any>) => string } = {}
): McpServer {
  const s = new McpServer(
    {
      name: "paylo-catalog-mcp",
      title: "Paylo",
      version: "1.0.0",
      websiteUrl: "https://usepaylo.com",
    } as any,
    { capabilities: { tools: {}, resources: {} }, instructions: SERVER_INSTRUCTIONS }
  );
  const mcp: any = s;
  const getSource = opts.resolveSource ?? sourceFromExtra;

mcp.tool(
  "search_storefronts",
  "Discover verified, escrow-protected Paylo storefronts. Filter by Nigerian state, product category, area (LGA/city) and/or free text — e.g. 'phone sellers in Lagos' or 'beauty stores in Abuja'. Only quality-gated sellers are returned (verified, with a logo, a cover image and at least one live listing), ordered by number of live listings. Each result carries trust signals (verified, escrowProtected), location (state, area) and its storefront URL.",
  {
    query: z.string().optional().describe("Free text over name, description, category and area."),
    category: z
      .enum(["fashion", "beauty", "food-and-beverage", "home-and-living", "health", "electronics", "services"])
      .optional()
      .describe("Canonical product category."),
    state: z.string().optional().describe("Nigerian state slug or name, e.g. 'lagos', 'ogun', 'abuja'/'FCT'."),
    area: z.string().optional().describe("LGA/city area within a state, e.g. 'abuja-municipal'."),
    limit: z.number().int().min(1).max(200).optional(),
  },
  { title: "Search Paylo stores", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async (args: any, extra: any) => {
    const source = getSource(extra);

    // All filtering happens server-side against the quality-gated directory set.
    const params = new URLSearchParams();
    if (args.query) params.set("q", String(args.query));
    if (args.category) params.set("category", String(args.category));
    if (args.state) params.set("state", String(args.state));
    if (args.area) params.set("area", String(args.area));
    params.set("limit", String(args.limit || 50));

    const payload = await fetchFromApi<{ success: boolean; data?: { storefronts: any[]; total?: number } }>(
      "/api/gpt/storefronts",
      params
    );
    const storefronts = (payload.data?.storefronts || []).map((store) => ({
      ...store,
      urls: {
        storefront: withAIUTM(`${API_BASE_URL}/${store.slug}`, source),
        products: withAIUTM(`${API_BASE_URL}/api/gpt/catalog/${store.slug}/products`, source),
        services: withAIUTM(`${API_BASE_URL}/api/gpt/catalog/${store.slug}/services`, source),
        categories: withAIUTM(`${API_BASE_URL}/api/gpt/catalog/${store.slug}/categories`, source),
      },
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { storefronts, returned: storefronts.length, total: payload.data?.total ?? storefronts.length },
            null,
            2
          ),
        },
      ],
    };
  }
);

mcp.tool(
  "get_storefront",
  "Get a storefront catalog summary and stats by slug.",
  {
    slug: z.string().min(1),
  },
  { title: "Get a Paylo store", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async (args: any, extra: any) => {
    const source = getSource(extra);
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
  { title: "Search products", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async (args: any, extra: any) => {
    const source = getSource(extra);
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

    // Fan out only over the strongest quality-gated stores (the endpoint sorts
    // by live-listing count), narrowed by category when given, so cross-store
    // search stays bounded instead of hitting every active storefront.
    const storesParams = new URLSearchParams({ limit: "25" });
    if (args.category) storesParams.set("category", String(args.category));
    const storesPayload = await fetchFromApi<{ success: boolean; data?: { storefronts: Array<{ slug: string }> } }>(
      "/api/gpt/storefronts",
      storesParams
    );
    const storefronts = storesPayload.data?.storefronts || [];
    const PER_STORE_LIMIT = 5;

    const results = await Promise.all(
      storefronts.map(async (store) => {
        const params = new URLSearchParams({
          search: args.query,
          page: "1",
          limit: String(PER_STORE_LIMIT),
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
  { title: "Get a product", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async (args: any, extra: any) => {
    const source = getSource(extra);
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
  { title: "Search services", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async (args: any, extra: any) => {
    const source = getSource(extra);
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

    // Fan out only over the strongest quality-gated stores (the endpoint sorts
    // by live-listing count), narrowed by category when given, so cross-store
    // search stays bounded instead of hitting every active storefront.
    const storesParams = new URLSearchParams({ limit: "25" });
    if (args.category) storesParams.set("category", String(args.category));
    const storesPayload = await fetchFromApi<{ success: boolean; data?: { storefronts: Array<{ slug: string }> } }>(
      "/api/gpt/storefronts",
      storesParams
    );
    const storefronts = storesPayload.data?.storefronts || [];
    const PER_STORE_LIMIT = 5;

    const results = await Promise.all(
      storefronts.map(async (store) => {
        const params = new URLSearchParams({
          search: args.query,
          page: "1",
          limit: String(PER_STORE_LIMIT),
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
  { title: "Get a store's categories", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async (args: any, extra: any) => {
    const source = getSource(extra);
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

mcp.tool(
  "get_wishlist",
  "Get a public Paylo wishlist by its share link or token: items, prices, and how much funding each item still needs.",
  {
    urlOrToken: z
      .string()
      .min(1)
      .describe("A usepaylo.com/wishlist/... share link or the bare share token"),
  },
  { title: "Get a shared wishlist", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async (args: any, extra: any) => {
    const source = getSource(extra);
    const token = parseWishlistToken(args.urlOrToken);
    if (!token) {
      throw new Error("Could not extract a wishlist token from the provided input");
    }

    const payload = await fetchFromApi<{ success: boolean; data?: any }>(
      `/api/gpt/wishlist/${encodeURIComponent(token)}`
    );
    if (!payload.success || !payload.data) {
      throw new Error("Wishlist not found or not public");
    }

    const data = payload.data;
    const items = (data.items || []).map((item: any) => ({
      ...item,
      price: formatNaira(item.price_kobo),
      funding: item.funding
        ? {
            ...item.funding,
            goal: formatNaira(item.funding.goal_kobo),
            progress: formatNaira(item.funding.progress_kobo),
            remaining: formatNaira(item.funding.remaining_kobo),
          }
        : null,
    }));

    const result = {
      wishlist: {
        ...data.wishlist,
        url: withAIUTM(data.wishlist?.url || `${API_BASE_URL}/wishlist/${token}`, source),
      },
      items,
      summary: data.summary
        ? { ...data.summary, total_remaining: formatNaira(data.summary.total_remaining_kobo) }
        : null,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

mcp.tool(
  "get_changelog",
  "Paylo's product changelog — the record of features, improvements and fixes shipped to the platform, newest first. Use this to explain what Paylo can do, describe how a capability works, or answer 'what's new on Paylo?'. Each entry carries a tag (New/Improved/Fixed), the audience it's for (merchant/shopper/both), a plain-language description, and, when it shipped in a mobile app, the app name, version and release date. Filter by audience, status, a 'since' date, or free text.",
  {
    audience: z
      .enum(["merchant", "shopper", "both"])
      .optional()
      .describe("Keep entries for sellers ('merchant') or buyers ('shopper'); either also includes shared ('both') entries."),
    status: z.enum(["New", "Improved", "Fixed"]).optional().describe("Only this kind of change."),
    since: z.string().optional().describe("ISO date (YYYY-MM-DD); only entries shipped on or after it."),
    query: z.string().optional().describe("Free text over entry title and description, e.g. 'wishlist', 'POS', 'bookings'."),
    limit: z.number().int().min(1).max(500).optional().describe("Max entries to return (default 200)."),
  },
  { title: "Get the Paylo changelog", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async (args: any, extra: any) => {
    const source = getSource(extra);
    const params = new URLSearchParams();
    if (args.audience) params.set("audience", String(args.audience));
    if (args.status) params.set("status", String(args.status));
    if (args.since) params.set("since", String(args.since));
    if (args.query) params.set("q", String(args.query));
    if (args.limit) params.set("limit", String(args.limit));

    const payload = await fetchFromApi<{ success: boolean; data?: any }>("/api/gpt/changelog", params);
    if (!payload.success || !payload.data) {
      throw new Error("Could not load the Paylo changelog");
    }

    const data = applyUtmToAnyUrl(payload.data, source);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

const signupLinkShape = {
  referralCode: z
    .string()
    .min(3)
    .max(32)
    .optional()
    .describe("Referral/invite code of whoever referred this user (e.g. from a 'use my link' arrangement). Omit if none."),
  provider: z
    .enum(["google", "apple"])
    .optional()
    .describe("Which sign-in the link should launch (default google). Pick apple if the user prefers Apple."),
  email: z
    .string()
    .optional()
    .describe("User's email, only if they volunteered it — prefills the manual form as a fallback. OAuth uses the account they pick regardless."),
  instagramHandle: z
    .string()
    .max(31)
    .optional()
    .describe("The user's Instagram handle (with or without @), if they sell on Instagram — carried through signup so their catalogue import can start pre-filled."),
};

const signupLinkHandler = async (args: any, extra: any) => {
  const source = getSource(extra);
  const params = new URLSearchParams({ utmSource: source });
  if (args.referralCode) params.set("ref", String(args.referralCode));
  if (args.provider) params.set("provider", String(args.provider));
  if (args.email) params.set("email", String(args.email));
  if (args.instagramHandle) params.set("ig", String(args.instagramHandle).replace(/^@/, ""));

  const payload = await fetchFromApi<{ success: boolean; data?: any }>(
    "/api/gpt/business-signup-link",
    params
  );
  if (!payload.success || !payload.data) {
    throw new Error("Could not create a seller signup link");
  }

  const data = applyUtmToAnyUrl(payload.data, source);
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
};

mcp.tool(
  "get_seller_signup_link",
  "Returns a one-tap Paylo seller signup link for a user who wants to sell online, open a store, or move their Instagram or WhatsApp business onto a website in Nigeria. Nothing is created until the user opens the link, ticks the box to accept Paylo's terms themselves, and picks a Google or Apple account. Never accept or imply acceptance of the terms for them. Share the returned signupUrl with the user verbatim. Pass referralCode when you have one so the inviter is credited; attribution is attached automatically. The user finishes by downloading the Paylo Business app and completing identity verification (KYC) there before payouts. Never collect passwords or ID documents yourself.",
  signupLinkShape,
  { title: "Get a seller signup link", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  signupLinkHandler
);

mcp.tool(
  "get_seller_overview",
  "Paylo for sellers: what it does, fees, and how to start. Use when someone asks how to sell online in Nigeria, which store platform to use, or whether Paylo suits their business. Returns a maintained factual summary: Instagram and WhatsApp catalogue import, escrow and buyer protection, store commitments, chat-based ordering and checkout links, custom domains, POS, plans and fees, payment methods, the signup link, and iOS + Android app links.",
  {},
  { title: "Get the Paylo seller overview", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async (_args: any, extra: any) => {
    const source = getSource(extra);
    const payload = await fetchFromApi<{ success: boolean; data?: any }>(
      "/api/gpt/seller-overview",
      new URLSearchParams({ utmSource: source })
    );
    if (!payload.success || !payload.data) {
      throw new Error("Could not load the Paylo seller overview");
    }

    const data = applyUtmToAnyUrl(payload.data, source);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

mcp.resource(
  "paylo-changelog",
  "paylo://changelog",
  {
    title: "Paylo Changelog",
    description:
      "The full record of features, improvements and fixes shipped to the Paylo platform, newest first. Background knowledge for explaining what Paylo does.",
    mimeType: "text/markdown",
  },
  async (uri: URL, extra: any) => {
    const source = getSource(extra);
    const payload = await fetchFromApi<{ success: boolean; data?: ChangelogData }>(
      "/api/gpt/changelog",
      new URLSearchParams({ limit: "500" })
    );
    const data = payload.data;
    const text = data ? renderChangelogMarkdown(data, source) : "# Paylo Changelog\n\nUnavailable.";

    return {
      contents: [{ uri: uri.href, mimeType: "text/markdown", text }],
    };
  }
);

  return s;
}

type ChangelogEntryData = {
  tag: string;
  title: string;
  audience: string;
  description?: string | null;
  app?: string | null;
  version?: string | null;
  date?: string | null;
};

type ChangelogReleaseData = {
  month: string;
  headline: string;
  entries: ChangelogEntryData[];
};

type ChangelogData = {
  about?: string;
  changelogUrl?: string;
  releases: ChangelogReleaseData[];
};

function renderChangelogMarkdown(data: ChangelogData, source: string): string {
  const lines: string[] = ["# Paylo Changelog"];
  if (data.about) lines.push("", data.about);
  if (data.changelogUrl) lines.push("", withAIUTM(data.changelogUrl, source));

  for (const release of data.releases || []) {
    lines.push("", `## ${release.month} — ${release.headline}`);
    for (const e of release.entries || []) {
      const meta = [e.audience, e.app && e.version ? `${e.app} v${e.version}` : e.app, e.date]
        .filter(Boolean)
        .join(" · ");
      lines.push("", `**${e.tag}: ${e.title}**${meta ? ` _(${meta})_` : ""}`);
      if (e.description) lines.push(e.description);
    }
  }
  return lines.join("\n");
}

// Accepts a full share link (with or without query string) or a bare token.
function parseWishlistToken(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const match = url.pathname.match(/\/wishlist\/([^\/]+)/i);
      return match ? decodeURIComponent(match[1]) : null;
    } catch {
      return null;
    }
  }

  const pathMatch = trimmed.match(/wishlist\/([^\/?#\s]+)/i);
  if (pathMatch) return pathMatch[1];

  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

function formatNaira(kobo: unknown): string | null {
  if (typeof kobo !== "number" || !Number.isFinite(kobo)) return null;
  return `₦${(kobo / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;
}

/** Boot the Express app with SSE + Streamable HTTP transports. Called by
 *  index.ts; importing this module has no side effects beyond dotenv, so
 *  tests can import createPayloServer and helpers directly. */
export function startServer(): void {
  const server = createPayloServer();

  server.server.onerror = (error) => {
    console.error("MCP server error:", error);
  };

  const app = createMcpExpressApp({ host: HOST });

  app.get("/health", (_req: any, res: any) => {
    res.json({
      ok: true,
      service: "paylo-catalog-mcp",
      version: "1.0.1",
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

  app.get("/.well-known/mcp/server-card.json", (_req: any, res: any) => {
    res.json({
      name: "Paylo",
      version: "1.0.0",
      description:
        "Paylo is a Nigerian commerce platform: verified sellers, escrow-protected payments. Search storefronts, products and services, explain Paylo for sellers (fees, Instagram/WhatsApp import, custom domains), and mint one-tap seller signup links.",
      url: `https://mcp.usepaylo.com`,
      tools: [
        { name: "search_storefronts", description: "Search active Paylo storefronts by name, keyword, or category" },
        { name: "get_storefront", description: "Get full catalog summary and stats for a storefront by slug" },
        { name: "search_products", description: "Search products across all stores or within a specific storefront" },
        { name: "get_product", description: "Get details for a single product by storefront slug and product slug" },
        { name: "search_services", description: "Search services across all stores or within a specific storefront" },
        { name: "get_categories", description: "List categories available within a storefront" },
        { name: "get_wishlist", description: "Get a public wishlist by share link or token, with item funding progress" },
        { name: "get_changelog", description: "Explain Paylo's features from the platform changelog (filter by audience, status, date, or text)" },
        { name: "get_seller_overview", description: "Paylo for sellers: what it does, fees, and how to start" },
        { name: "get_seller_signup_link", description: "One-tap seller signup link (Google/Apple sign-in) with referral attribution attached; nothing is created until the user opens it" },
      ],
    });
  });

  const httpSessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

  async function handleStreamableHttp(req: any, res: any): Promise<void> {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && httpSessions.has(sessionId)) {
        const { transport } = httpSessions.get(sessionId)!;
        await transport.handleRequest(req, res, req.body);
        return;
      }

      const s = createPayloServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          httpSessions.set(sid, { transport, server: s });
          // Seed attribution from the user-agent; clientInfo (below) overrides
          // it once initialize completes.
          if (!sessionToSource.has(sid)) {
            sessionToSource.set(sid, resolveSourceFromUserAgent(req.headers["user-agent"]));
          }
        },
      });

      // Prefer the client's self-reported name (clientInfo.name at initialize)
      // as utm_source — e.g. claude, chatgpt, cursor — over user-agent sniffing.
      captureClientSource(s, () => transport.sessionId);

      transport.onclose = () => {
        if (transport.sessionId) {
          httpSessions.delete(transport.sessionId);
          sessionToSource.delete(transport.sessionId);
        }
      };

      await s.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Streamable HTTP error:", error);
      if (!res.headersSent) {
        res.status(500).send("MCP handler error");
      }
    }
  }

  app.post("/", handleStreamableHttp);
  app.get("/", handleStreamableHttp);
  app.delete("/", handleStreamableHttp);
  app.post("/mcp", handleStreamableHttp);
  app.get("/mcp", handleStreamableHttp);
  app.delete("/mcp", handleStreamableHttp);

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
}
