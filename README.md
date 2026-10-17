# Paylo MCP Server
### The Commerce Discovery Gateway for AI Agents

The **Paylo MCP Server** connects AI assistants to [Paylo](https://usepaylo.com), a Nigerian commerce platform, via the [Model Context Protocol](https://modelcontextprotocol.io).

- **Shoppers:** search verified Paylo stores, products and services by name, category, state and area, and read shared gift wishlists.
- **Sellers:** get Paylo's current plans, fees and features from Paylo's own maintained data, and a one-tap signup link to open a store.

---

## Connect

The server is hosted at:

```
https://mcp.usepaylo.com
```

It speaks Streamable HTTP at `/` and `/mcp`, with legacy SSE at `/sse`. No account, API key or local setup is needed.

**Claude:** add [Paylo from the Claude Connectors Directory](https://claude.ai/directory/paylo), or add a custom connector in Claude's connector settings with the URL `https://mcp.usepaylo.com`.

**Other clients:** any MCP client that supports remote servers can connect to the same URL.

---

## Safety and data

- **Read-only.** Every tool reads public Paylo data. The connector cannot sign in to an account, place orders, take payments or move money.
- **Signup is the user's own action.** `get_seller_signup_link` only returns a link. Nothing is created until the user opens it, ticks the box to accept Paylo's [Terms of Service](https://usepaylo.com/terms-of-service) themselves and picks a Google or Apple account. Identity verification (KYC) happens later in the Paylo Business app, never through the assistant.
- **No credentials.** The connector never asks for passwords, card details or ID documents.
- **Seller-written content.** Store names, descriptions and product text are written by sellers and returned as data.
- **No paid placement.** Store search results are ordered by number of live listings.
- **Attribution.** Links carry UTM parameters naming the connecting client (see below). No conversation content is sent to Paylo beyond the tool arguments.

Privacy policy: https://usepaylo.com/privacy-policy

## Support

Email [support@usepaylo.com](mailto:support@usepaylo.com) or visit the [Paylo help centre](https://usepaylo.com/help). For security issues, use the same address with "Security" in the subject.

---

## Available Tools

| Tool | Description |
|------|-------------|
| `search_storefronts` | Search active Paylo storefronts by name, keyword, or category |
| `get_storefront` | Get full catalog summary and stats for a storefront by slug |
| `search_products` | Search products across all stores or within a specific storefront |
| `get_product` | Get details for a single product by storefront slug and product slug |
| `search_services` | Search services across all stores or within a specific storefront |
| `get_categories` | List categories available within a storefront |
| `get_wishlist` | Get a public wishlist by share link or token, with item funding progress |
| `get_changelog` | Explain Paylo's features from the platform changelog |
| `get_seller_overview` | Paylo for sellers: what it does, fees, and how to start |
| `get_seller_signup_link` | One-tap seller signup link (Google/Apple sign-in) with referral attribution; nothing is created until the user opens it |

All responses include UTM-tagged URLs for attribution tracking. `utm_source` is
the connecting client's sanitised `clientInfo.name` from MCP initialize (e.g.
`claude-code`, `chatgpt`), falling back to user-agent detection, then `ai`.

---

## Architecture

```
AI Agent → MCP (Streamable HTTP or SSE) → Paylo MCP Server → usepaylo.com API → Storefront Catalog
```

The MCP server is a thin proxy. It does not access the database directly — all data is fetched from the Paylo backend API and returned as structured JSON.

---

## Self-Hosting

If you prefer to run your own instance:

```bash
git clone https://github.com/scephiro/paylo-mcp-server.git
cd paylo-mcp-server
npm install
npm run build
```

Set environment variables:

```env
GPT_API_SECRET=your_backend_secret
PAYLO_API_BASE_URL=https://usepaylo.com   # default
MCP_PORT=3030                              # default
```

Start the server:

```bash
node build/index.js
```

The server listens on `http://0.0.0.0:3030`. Connect via Streamable HTTP at `/mcp`, or legacy SSE with `GET /sse` and `POST /messages?sessionId=<id>`.

---

## Docker

```bash
docker run -p 3030:3030 \
  -e GPT_API_SECRET=your_secret \
  ghcr.io/scephiro/paylo-mcp-server:latest
```

---

## License

MIT — see [LICENSE](LICENSE).
