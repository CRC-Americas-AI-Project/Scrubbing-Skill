'use strict';

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const { app } = require('electron');

let mcpProcess = null;
let status = { running: false, authenticated: false, tools: 0, pid: null };
let restartTimer = null;

const SERVER_PORT = 8812;
const MCP_SERVER_PATH = path.join(__dirname, '..', '..', 'scrubbing-mcp', 'src', 'mcp-server-http.mjs');
const USERS_DIR = path.join(app.getPath('userData'), 'scrubbing-users');

function getServerStatus() {
  return { ...status };
}

function startMcpServer(tray) {
  if (mcpProcess) return;

  const env = {
    ...process.env,
    PORT: String(SERVER_PORT),
    SCRUBBING_USERS_DIR: USERS_DIR,
    BROWSER_WS_ENDPOINT: 'http://127.0.0.1:9222',
    PUPPETEER_SKIP_DOWNLOAD: 'true',
    NODE_ENV: 'production',
  };

  console.log('[desktop] Starting MCP server...');
  mcpProcess = spawn(process.execPath, [MCP_SERVER_PATH], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  mcpProcess.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    console.log('[mcp-server]', msg);
    if (msg.includes('worker started') || msg.includes('Auth: per-user')) {
      status.running = true;
    }
  });

  mcpProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg.includes('SSO completed') || msg.includes('No stored credentials')) {
      status.authenticated = msg.includes('SSO completed');
    }
  });

  mcpProcess.on('exit', (code) => {
    console.log(`[desktop] MCP server exited (code ${code}). Restarting in 3s...`);
    mcpProcess = null;
    status.running = false;
    status.authenticated = false;
    restartTimer = setTimeout(() => startMcpServer(tray), 3000);
  });

  // Poll for readiness
  waitForServer(() => {
    status.running = true;
    status.pid = mcpProcess?.pid ?? null;
    checkAuthentication();
    console.log('[desktop] MCP server ready on port', SERVER_PORT);
  });
}

function stopMcpServer() {
  if (restartTimer) clearTimeout(restartTimer);
  if (mcpProcess) {
    mcpProcess.kill();
    mcpProcess = null;
  }
  status = { running: false, authenticated: false, tools: 0, pid: null };
}

function waitForServer(onReady, attempts = 0) {
  if (attempts > 30) {
    console.error('[desktop] MCP server failed to start after 30 attempts');
    return;
  }
  http.get(`http://127.0.0.1:${SERVER_PORT}/mcp`, (res) => {
    if (res.statusCode === 200) {
      onReady();
    } else {
      setTimeout(() => waitForServer(onReady, attempts + 1), 1000);
    }
  }).on('error', () => {
    setTimeout(() => waitForServer(onReady, attempts + 1), 1000);
  });
}

function checkAuthentication() {
  // Do a quick tools/list to verify server is responding with tools
  const body = JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
  const req = http.request({
    hostname: '127.0.0.1',
    port: SERVER_PORT,
    path: '/mcp',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(body),
    }
  }, (res) => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
      try {
        const line = data.split('\n').find(l => l.startsWith('data:'));
        if (line) {
          const json = JSON.parse(line.replace('data:', '').trim());
          status.tools = json?.result?.tools?.length ?? 0;
          status.authenticated = status.tools > 0;
        }
      } catch {}
    });
  });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

module.exports = { startMcpServer, stopMcpServer, getServerStatus };
