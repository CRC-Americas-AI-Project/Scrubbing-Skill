/**
 * SAP Scrubbing MCP — Unified HTTP server (Harmony + DCD).
 *
 * Multi-user: each caller is identified by the X-User-Id request header
 * (e.g. "i749420"). Each user gets a dedicated stdio worker child process
 * with its own HOME directory, keeping SAP SSO cookies fully isolated.
 * Workers are reused across requests and shut down after 30 min of inactivity.
 *
 * Browser support: Chrome and Edge on Mac, Windows, Linux.
 * For Linux headless servers, set BROWSER_WS_ENDPOINT=ws://localhost:9222
 * pointing at a Chrome/Edge instance started with --remote-debugging-port=9222.
 *
 * Usage:
 *   node src/mcp-server-http.mjs              # default port 8812
 *   PORT=9000 node src/mcp-server-http.mjs
 *
 * Endpoints:
 *   POST http://0.0.0.0:8812/mcp   (Streamable HTTP — MCP protocol)
 *   GET  http://0.0.0.0:8812/mcp   (health check)
 *
 * Environment variables:
 *   PORT                 Default 8812
 *   SCRUBBING_USERS_DIR  Base dir for per-user HOME dirs (default: <package>/users)
 *   BROWSER_PATH         Override auto-detected Chrome/Edge path
 *   BROWSER_WS_ENDPOINT  Connect to a remote CDP browser (ws://host:port)
 */

import { createServer }                    from 'http';
import { mkdirSync }                       from 'fs';
import { fileURLToPath }                   from 'url';
import { dirname, join }                   from 'path';
import { Client }                          from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport }            from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server }                          from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport }   from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const __dir  = dirname(fileURLToPath(import.meta.url));
const PORT   = parseInt(process.env.PORT ?? '8812', 10);
const USERS_DIR = process.env.SCRUBBING_USERS_DIR ?? join(__dir, '..', 'users');
const IDLE_MS   = 30 * 60 * 1000; // 30 minutes

// ── OAuth2 / XSUAA config (for MCP Authorization Server Discovery) ─────────────
const { XSUAA_BASE, XSUAA_CLIENT_ID, XSUAA_CLIENT_SECRET } = (() => {
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES ?? '{}');
    const creds = vcap?.xsuaa?.[0]?.credentials ?? {};
    return {
      XSUAA_BASE:          creds.url ?? null,
      XSUAA_CLIENT_ID:     creds.clientid ?? null,
      XSUAA_CLIENT_SECRET: creds.clientsecret ?? null,
    };
  } catch { return { XSUAA_BASE: null, XSUAA_CLIENT_ID: null, XSUAA_CLIENT_SECRET: null }; }
})();
const MCP_BASE_URL = process.env.MCP_BASE_URL ?? `https://scrubbing-mcp-server-chipper-porcupine-zr.cfapps.us10-001.hana.ondemand.com`;

// ── Sparticuz Chromium bootstrap (Linux CF only) ───────────────────────────────
// On BTP CF, @sparticuz/chromium provides a headless Chromium binary optimized
// for container environments (no snap, no display required). We pre-extract it
// at startup so BROWSER_PATH is set before any worker spawns.
if (!process.env.BROWSER_PATH && process.platform === 'linux') {
  try {
    const { default: chromium } = await import('@sparticuz/chromium');
    const execPath = await chromium.executablePath();
    process.env.BROWSER_PATH = execPath;
    console.log(`[scrubbing-mcp] Sparticuz Chromium ready at: ${execPath}`);
  } catch (e) {
    console.warn(`[scrubbing-mcp] @sparticuz/chromium not available: ${e.message}`);
  }
}

// ── Per-user worker pool ───────────────────────────────────────────────────────

/** @type {Map<string, { client: Client, lastUsed: number }>} */
const workers = new Map();

async function getWorker(userId, btpJwt, sapCookie) {
  const existing = workers.get(userId);
  if (existing) {
    existing.lastUsed = Date.now();
    // Refresh credentials on every request so expired tokens/cookies get updated.
    if (btpJwt)    existing.env.BTP_USER_JWT       = btpJwt;
    if (sapCookie) existing.env.SAP_SESSION_COOKIE  = sapCookie;
    return existing.client;
  }

  const userHome = join(USERS_DIR, userId);
  mkdirSync(userHome, { recursive: true });

  const childEnv = { ...process.env, HOME: userHome };
  if (btpJwt)    childEnv.BTP_USER_JWT       = btpJwt;
  if (sapCookie) childEnv.SAP_SESSION_COOKIE  = sapCookie;

  const stdioTransport = new StdioClientTransport({
    command: process.execPath,
    args:    [join(__dir, 'worker.mjs')],
    env:     childEnv,
  });

  const client = new Client({ name: `scrubbing-proxy-${userId}`, version: '1.0.0' }, {});
  await client.connect(stdioTransport);

  workers.set(userId, { client, lastUsed: Date.now(), env: childEnv });
  console.log(`[scrubbing-mcp] worker started for user: ${userId}`);
  return client;
}

// Evict workers idle for more than IDLE_MS.
setInterval(async () => {
  const now = Date.now();
  for (const [userId, entry] of workers) {
    if (now - entry.lastUsed > IDLE_MS) {
      console.log(`[scrubbing-mcp] evicting idle worker for user: ${userId}`);
      await entry.client.close().catch(() => {});
      workers.delete(userId);
    }
  }
}, 60_000).unref(); // don't block process exit

// ── User identity resolution ───────────────────────────────────────────────────

function resolveUserId(req) {
  const fromHeader = req.headers['x-user-id'];
  if (fromHeader) return String(fromHeader).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  // Fallback: derive from remote IP (acceptable for trusted-LAN deployments).
  return (req.socket.remoteAddress ?? 'default').replace(/[^a-zA-Z0-9]/g, '_');
}

// ── Per-request proxy server ───────────────────────────────────────────────────

function makeProxyServer(mcpClient) {
  const proxy = new Server(
    { name: 'scrubbing-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  proxy.setRequestHandler(ListToolsRequestSchema, () => mcpClient.listTools());
  proxy.setRequestHandler(CallToolRequestSchema,  (req) =>
    mcpClient.callTool({ name: req.params.name, arguments: req.params.arguments ?? {} }),
  );
  return proxy;
}

// ── HTTP server ────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data',  chunk => { body += chunk; });
    req.on('end',   () => resolve(body));
    req.on('error', reject);
  });
}

const httpServer = createServer(async (req, res) => {
  const url = (req.url ?? '').replace(/\/$/, '');

  // ── Destination diagnostic endpoint ───────────────────────────────────────────
  // Tests the HARMONY_DEST directly in the parent process using the caller's JWT.
  // Usage: GET /diag/harmony with Authorization: Bearer <jwt>
  if (req.method === 'GET' && url === '/diag/harmony') {
    const jwt = (req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '') || undefined;
    try {
      const { getDestination } = await import('@sap-cloud-sdk/connectivity');
      const { executeHttpRequest } = await import('@sap-cloud-sdk/http-client');
      const dest = await getDestination({ destinationName: 'HARMONY_DEST', jwt, useCache: false });
      if (!dest) { res.writeHead(404); res.end('HARMONY_DEST not found'); return; }
      // Try actual call to whoami
      const result = await executeHttpRequest(dest, {
        method: 'GET',
        url: '/1c83fff3-0c88-41fa-a608-c0fa5d3dec6f.hdm.hdm/user-api/currentUser',
        headers: { Accept: 'application/json' },
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: result.status, data: result.data }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message, cause: e.cause?.message, stack: e.stack?.slice(0,500) }));
    }
    return;
  }

  // ── JWT diagnostic endpoint — shows claims from the caller's JWT ─────────────
  if (req.method === 'GET' && url === '/diag/jwt') {
    const jwt = (req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '');
    if (!jwt) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('No Authorization header'); return; }
    try {
      const [, payload] = jwt.split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        zid:       claims.zid,
        user_name: claims.user_name,
        origin:    claims.origin,
        email:     claims.email,
        sub:       claims.sub,
        iss:       claims.iss,
        aud:       claims.aud,
        exp:       claims.exp ? new Date(claims.exp * 1000).toISOString() : null,
        grant_type: claims.grant_type,
        scope:     claims.scope,
      }, null, 2));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to decode JWT', detail: e.message }));
    }
    return;
  }
  if (req.method === 'GET' && url === '/diag/sso') {
    try {
      const { createAuthClient } = await import('sap-auth');
      const client = createAuthClient({
        domain: 'sapit-sales-prod-budgie.launchpad.cfapps.eu10.hana.ondemand.com',
        method: 'sap-sso',
        entryUrl: 'https://sapit-sales-prod-budgie.launchpad.cfapps.eu10.hana.ondemand.com/1c83fff3-0c88-41fa-a608-c0fa5d3dec6f.hdm.hdm/index.html',
      });
      const result = await client.fetch('https://sapit-sales-prod-budgie.launchpad.cfapps.eu10.hana.ondemand.com/1c83fff3-0c88-41fa-a608-c0fa5d3dec6f.hdm.hdm/user-api/currentUser');
      const body = await result.text();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: result.status, body: body.slice(0, 500) }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // Joule Desktop queries these endpoints to discover the Authorization Server.
  if (req.method === 'GET' && (
    url === '/.well-known/openid-configuration' ||
    url === '/.well-known/oauth-authorization-server' ||
    url === '/.well-known/oauth-protected-resource' ||
    url === '/.well-known/oauth-protected-resource/mcp'
  )) {
    const issuer = XSUAA_BASE ?? `https://628d1b7dtrial.authentication.us10.hana.ondemand.com`;
    const discovery = {
      issuer,
      authorization_endpoint: `${MCP_BASE_URL}/authorize`,
      token_endpoint: `${MCP_BASE_URL}/oauth/token`,
      jwks_uri: `${issuer}/token_keys`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'client_credentials'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['openid'],
      // RFC 9728 / MCP OAuth2: point back to this server as the resource
      resource: `${MCP_BASE_URL}/mcp`,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(discovery));
    return;
  }

  // ── OAuth2 Token Proxy ────────────────────────────────────────────────────────
  // Joule uses PKCE (no client_secret). XSUAA requires client_secret.
  // We act as a proxy: receive the code from Joule, inject secret, forward to XSUAA.
  if (req.method === 'POST' && url === '/oauth/token') {
    const issuer = XSUAA_BASE ?? 'https://628d1b7dtrial.authentication.us10.hana.ondemand.com';
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    // Inject XSUAA credentials (Joule sends PKCE without secret)
    if (XSUAA_CLIENT_ID)     params.set('client_id',     XSUAA_CLIENT_ID);
    if (XSUAA_CLIENT_SECRET) params.set('client_secret', XSUAA_CLIENT_SECRET);
    try {
      const tokenRes = await fetch(`${issuer}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const tokenData = await tokenRes.text();
      res.writeHead(tokenRes.status, { 'Content-Type': 'application/json' });
      res.end(tokenData);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'token_proxy_error', error_description: err.message }));
    }
    return;
  }
  // Joule sends the user's browser to /authorize — we redirect to XSUAA.
  if (req.method === 'GET' && url.startsWith('/authorize')) {
    const issuer = XSUAA_BASE ?? `https://628d1b7dtrial.authentication.us10.hana.ondemand.com`;
    const xsuaaAuthUrl = `${issuer}/oauth/authorize${req.url?.replace('/authorize', '') ?? ''}`;
    res.writeHead(302, { Location: xsuaaAuthUrl });
    res.end();
    return;
  }

  // Diagnostic endpoint — shows VCAP_SERVICES structure (no secrets)
  if (req.method === 'GET' && url === '/debug') {
    const vcap = process.env.VCAP_SERVICES ? JSON.parse(process.env.VCAP_SERVICES) : null;
    const summary = vcap ? Object.fromEntries(
      Object.entries(vcap).map(([k, v]) => [k, v.map(s => ({
        name: s.name,
        label: s.label,
        plan: s.plan,
        hasCredentials: !!s.credentials,
        credentialKeys: s.credentials ? Object.keys(s.credentials) : [],
        url: s.credentials?.url,
        apiurl: s.credentials?.apiurl,
      }))])
    ) : 'VCAP_SERVICES not set';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ vcapSummary: summary, isBtp: !!process.env.VCAP_SERVICES }, null, 2));
    return;
  }

  if (req.method === 'GET' && url === '/mcp') {
    // Handle MCP Streamable HTTP GET — used by some clients for SSE session init
    // Also handle as health check for clients that do GET discovery
    const accept = req.headers['accept'] ?? '';
    if (accept.includes('text/event-stream')) {
      // SSE session init — let the MCP transport handle it
      try {
        const userId     = resolveUserId(req);
        const btpJwt     = (req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '') || undefined;
        const sapCookie  = req.headers['x-sap-cookie'] || undefined;
        const mcpClient  = await getWorker(userId, btpJwt, sapCookie);
        const rawBody    = undefined;
        const transport  = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const proxy      = makeProxyServer(mcpClient);
        res.on('close', async () => {
          await transport.close().catch(() => {});
          await proxy.close().catch(() => {});
        });
        await proxy.connect(transport);
        await transport.handleRequest(req, res, rawBody);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id: null }));
        }
      }
      return;
    }
    // Plain health check
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', server: 'scrubbing-mcp', tools: 41, workers: workers.size }));
    return;
  }

  if (url !== '/mcp') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found — use POST /mcp');
    return;
  }

  try {
    const userId     = resolveUserId(req);
    const btpJwt     = (req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '') || undefined;
    const sapCookie  = req.headers['x-sap-cookie'] || undefined;
    console.log(`[scrubbing-mcp] request user=${userId} hasJwt=${!!btpJwt} hasCookie=${!!sapCookie}`);

    // Log JWT claims for diagnostic (shows zid, user_name, origin)
    if (btpJwt) {
      try {
        const [, payload] = btpJwt.split('.');
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
        console.log(`[scrubbing-mcp] JWT claims: zid=${claims.zid} user_name=${claims.user_name} origin=${claims.origin} iss=${claims.iss?.slice(0,50)}`);
      } catch {}
    }

    // MCP OAuth2: if no auth provided, respond with 401 + WWW-Authenticate so
    // the client knows to initiate the OAuth2 flow before retrying.
    if (!btpJwt && !sapCookie && process.env.VCAP_SERVICES) {
      const issuer = XSUAA_BASE ?? 'https://628d1b7dtrial.authentication.us10.hana.ondemand.com';
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer realm="${MCP_BASE_URL}", resource_metadata="${MCP_BASE_URL}/.well-known/oauth-protected-resource"`,
      });
      res.end(JSON.stringify({ error: 'unauthorized', error_description: 'Bearer token required. Configure OAuth2 in your MCP client.' }));
      return;
    }

    const mcpClient  = await getWorker(userId, btpJwt, sapCookie);
    const rawBody    = await readBody(req);
    const parsedBody = rawBody ? JSON.parse(rawBody) : undefined;

    // If client doesn't accept SSE, force JSON-only response (Joule Desktop compatibility)
    const acceptsSSE = (req.headers['accept'] ?? '').includes('text/event-stream');
    if (!acceptsSSE) {
      req.headers['accept'] = 'application/json';
    } else {
      req.headers['accept'] = 'application/json, text/event-stream';
    }

    const transport  = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const proxy      = makeProxyServer(mcpClient);

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

// Bind to 0.0.0.0 so the server is reachable from other machines on the network.
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   SAP Scrubbing MCP — Unified Server         ║');
  console.log('║   Harmony (35 tools) + DCD (6 tools)         ║');
  console.log(`║   URL: http://0.0.0.0:${PORT}/mcp              ║`);
  console.log('║   Auth: per-user worker pool (X-User-Id)     ║');
  console.log('╚══════════════════════════════════════════════╝');
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown() {
  console.log('[scrubbing-mcp] shutting down...');
  httpServer.close();
  await Promise.all([...workers.values()].map(w => w.client.close().catch(() => {})));
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
