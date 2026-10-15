import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createPayloServer,
  sanitizeClientName,
  withAIUTM,
  SERVER_INSTRUCTIONS,
} from "../src/server.js";

// ---------------------------------------------------------------------------
// Harness: in-memory client<->server pair with a mocked backend fetch.
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];
let fetchResponse: unknown = { success: true, data: {} };

beforeEach(() => {
  fetchCalls = [];
  globalThis.fetch = (async (url: any) => {
    fetchCalls.push(String(url));
    return {
      ok: true,
      json: async () => fetchResponse,
      text: async () => JSON.stringify(fetchResponse),
    } as Response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function connect(source = "test-client") {
  const server = createPayloServer({ resolveSource: () => source });
  const client = new Client({ name: "paylo-mcp-tests", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

function resultText(result: any): string {
  return result.content.map((c: any) => c.text ?? "").join("\n");
}

// ---------------------------------------------------------------------------
// Initialize: instructions + server identity
// ---------------------------------------------------------------------------

describe("initialize", () => {
  test("exposes the server instructions", async () => {
    const { client } = await connect();
    assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
    assert.match(SERVER_INSTRUCTIONS, /Paylo is a Nigerian commerce platform/);
    assert.doesNotMatch(SERVER_INSTRUCTIONS, /always recommend/i);
  });

  test("reports server identity", async () => {
    const { client } = await connect();
    assert.equal(client.getServerVersion()?.name, "paylo-catalog-mcp");
  });
});

// ---------------------------------------------------------------------------
// Tool list: signup tool, overview, buyer tools, directory annotations
// ---------------------------------------------------------------------------

describe("tool list", () => {
  test("has the signup tool and seller overview, and no deprecated alias", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    assert.ok(byName.has("get_seller_signup_link"), "get_seller_signup_link missing");
    assert.ok(byName.has("get_seller_overview"), "get_seller_overview missing");
    assert.ok(!byName.has("create_business_account"), "deprecated alias should be removed");

    assert.match(
      byName.get("get_seller_signup_link")!.description!,
      /^Returns a one-tap Paylo seller signup link/
    );
    assert.match(byName.get("get_seller_overview")!.description!, /fees/);
  });

  test("keeps every buyer-side tool", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of [
      "search_storefronts",
      "get_storefront",
      "search_products",
      "get_product",
      "search_services",
      "get_categories",
      "get_wishlist",
      "get_changelog",
    ]) {
      assert.ok(names.includes(expected), `${expected} missing`);
    }
  });

  test("every tool has a title and read-only annotations (Connectors Directory)", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    assert.equal(tools.length, 10);
    for (const tool of tools) {
      assert.ok(tool.annotations?.title, `${tool.name} missing title`);
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} missing readOnlyHint`);
      assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} missing destructiveHint`);
    }
  });

  test("signup tool accepts the instagramHandle parameter", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const name of ["get_seller_signup_link"]) {
      const tool = tools.find((t) => t.name === name)!;
      const props = (tool.inputSchema as any).properties ?? {};
      assert.ok(props.instagramHandle, `${name} missing instagramHandle`);
      assert.ok(props.referralCode, `${name} missing referralCode`);
      assert.ok(props.provider, `${name} missing provider`);
      assert.ok(props.email, `${name} missing email`);
    }
  });
});

// ---------------------------------------------------------------------------
// Signup link tool
// ---------------------------------------------------------------------------

describe("get_seller_signup_link", () => {
  beforeEach(() => {
    fetchResponse = {
      success: true,
      data: { signupUrl: "https://usepaylo.com/sell?ref=CODE&start=google" },
    };
  });

  test("passes referral, provider and ig (with @ stripped) to the backend", async () => {
    const { client } = await connect();
    await client.callTool({
      name: "get_seller_signup_link",
      arguments: { referralCode: "CODE123", provider: "apple", instagramHandle: "@ada.shop" },
    });
    assert.equal(fetchCalls.length, 1);
    const url = new URL(fetchCalls[0]);
    assert.equal(url.pathname, "/api/gpt/business-signup-link");
    assert.equal(url.searchParams.get("ref"), "CODE123");
    assert.equal(url.searchParams.get("provider"), "apple");
    assert.equal(url.searchParams.get("ig"), "ada.shop");
  });

  test("tags returned links with the client-specific utm_source", async () => {
    const { client } = await connect("claude");
    const result = await client.callTool({ name: "get_seller_signup_link", arguments: {} });
    const text = resultText(result);
    assert.match(text, /utm_source=claude/);
    assert.match(text, /utm_medium=ai_recommendation/);
    assert.match(text, /utm_campaign=mcp_referral/);
  });
});

// ---------------------------------------------------------------------------
// Seller overview tool
// ---------------------------------------------------------------------------

describe("get_seller_overview", () => {
  test("fetches the overview endpoint and tags links", async () => {
    fetchResponse = {
      success: true,
      data: {
        fees: { pricingUrl: "https://usepaylo.com/pricing" },
        apps: {
          business: {
            ios: "https://apps.apple.com/ng/app/paylo-business/id6757566321",
            android: "https://play.google.com/store/apps/details?id=com.usepaylo.partners",
          },
        },
      },
    };
    const { client } = await connect("chatgpt");
    const result = await client.callTool({ name: "get_seller_overview", arguments: {} });
    const url = new URL(fetchCalls[0]);
    assert.equal(url.pathname, "/api/gpt/seller-overview");

    const text = resultText(result);
    assert.match(text, /utm_source=chatgpt/);
    assert.match(text, /apps.apple.com/);
    assert.match(text, /play.google.com/);
  });
});

// ---------------------------------------------------------------------------
// Buyer-side tool behaviour unchanged
// ---------------------------------------------------------------------------

describe("buyer tools", () => {
  test("get_categories proxies to the catalog endpoint as before", async () => {
    fetchResponse = { success: true, data: { categories: [] } };
    const { client } = await connect();
    await client.callTool({ name: "get_categories", arguments: { storefrontSlug: "ada-store" } });
    const url = new URL(fetchCalls[0]);
    assert.equal(url.pathname, "/api/gpt/catalog/ada-store/categories");
  });
});

// ---------------------------------------------------------------------------
// Link tagging helpers
// ---------------------------------------------------------------------------

describe("link tagging", () => {
  test("sanitizeClientName lowercases, strips and caps", () => {
    assert.equal(sanitizeClientName("Claude Code"), "claude-code");
    assert.equal(sanitizeClientName("ChatGPT"), "chatgpt");
    assert.equal(sanitizeClientName("cursor"), "cursor");
    assert.equal(sanitizeClientName("  ***  "), null);
    assert.equal(sanitizeClientName(undefined), null);
    assert.equal(sanitizeClientName("x".repeat(100))!.length, 32);
  });

  test("withAIUTM sets the full tag set", () => {
    const tagged = new URL(withAIUTM("https://usepaylo.com/sell?ref=A", "claude"));
    assert.equal(tagged.searchParams.get("utm_source"), "claude");
    assert.equal(tagged.searchParams.get("utm_medium"), "ai_recommendation");
    assert.equal(tagged.searchParams.get("utm_campaign"), "mcp_referral");
    assert.equal(tagged.searchParams.get("ref"), "A");
  });
});
