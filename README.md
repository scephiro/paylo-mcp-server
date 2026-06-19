# Paylo MCP Server
### The Commerce Discovery Gateway for AI Agents

The **Paylo MCP Server** connects AI agents to the Paylo storefront network via the [Model Context Protocol](https://modelcontextprotocol.io). Agents can search merchants, browse products and services, and retrieve catalog data — all through a live hosted SSE endpoint.

---

## Connect

The server is hosted at:

```
https://mcp.usepaylo.com/sse
```

No local setup required. Point your MCP client at this URL.

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

All responses include UTM-tagged URLs for attribution tracking.

---

## Architecture

```
AI Agent → MCP (SSE) → Paylo MCP Server → usepaylo.com API → Storefront Catalog
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

The server listens on `http://0.0.0.0:3030`. Connect via `GET /sse` and send messages to `POST /messages?sessionId=<id>`.

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
