/**
 * SAP Harmony MCP Server — Streamable HTTP transport (MCP-compliant).
 *
 * Proxies the stdio MCP server (mcp-server.mjs) over Streamable HTTP so that
 * Joule Desktop and other HTTP-capable MCP clients can connect without running
 * a local Claude Code session.
 *
 * Usage:
 *   node mcp-server-http.mjs              # default port 8810
 *   node mcp-server-http.mjs --port 9000
 *
 * Endpoint:
 *   POST http://localhost:8810/mcp        (Streamable HTTP — MCP protocol)
 *   GET  http://localhost:8810/mcp        (health check)
 *
 * Joule Desktop config:
 *   MCP Server URL: http://localhost:8810/mcp
 */

import { createServer }                    from 'http';
import { fileURLToPath }                   from 'url';
import { dirname, join }                   from 'path';
import { Client }                          from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport }            from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server }                          from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport }   from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── CLI args ──────────────────────────────────────────────────────────────────
const portIdx = process.argv.indexOf('--port');
const PORT    = portIdx !== -1 ? parseInt(process.argv[portIdx + 1], 10) : 8810;

// ── MCP client → stdio child ──────────────────────────────────────────────────
const stdioTransport = new StdioClientTransport({
  command: process.execPath,
  args:    [join(__dir, 'mcp-server.mjs')],
  env:     process.env,
});

const mcpClient = new Client({ name: 'sap-harmony-http-proxy', version: '1.0.0' }, {});
await mcpClient.connect(stdioTransport);

// ── Proxy server factory ───────────────────────────────────────────────────────
// Each incoming HTTP request gets a fresh stateless Server+Transport pair that
// delegates all tool calls and listings to the persistent mcpClient above.
function makeProxyServer() {
  const proxy = new Server(
    { name: 'sap-harmony-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  proxy.setRequestHandler(ListToolsRequestSchema, async () => {
    return await mcpClient.listTools();
  });

  proxy.setRequestHandler(CallToolRequestSchema, async (req) => {
    return await mcpClient.callTool({ name: req.params.name, arguments: req.params.arguments ?? {} });
  });

  return proxy;
}

// ── HTTP server ───────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end',  () => resolve(body));
    req.on('error', reject);
  });
}

const httpServer = createServer(async (req, res) => {
  const url = (req.url ?? '').replace(/\/$/, '');

  // Health check
  if (req.method === 'GET' && url === '/mcp') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('SAP Harmony MCP — Streamable HTTP ready (POST /mcp)');
    return;
  }

  if (url !== '/mcp') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found — use POST /mcp');
    return;
  }

  try {
    const rawBody   = await readBody(req);
    const parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const proxy     = makeProxyServer();

    // Clean up after the response is fully sent
    res.on('close', async () => {
      await transport.close().catch(() => {});
      await proxy.close().catch(() => {});
    });

    await proxy.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: err.message },
        id: null,
      }));
    }
  }
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   SAP Harmony MCP Server (HTTP)          ║');
  console.log('║   Quotes | Opportunities | CPQ           ║');
  console.log('║   Renewal Execution | Deals List         ║');
  console.log(`║   URL: http://localhost:${PORT}/mcp         ║`);
  console.log('╚══════════════════════════════════════════╝');
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown() {
  httpServer.close();
  await mcpClient.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
