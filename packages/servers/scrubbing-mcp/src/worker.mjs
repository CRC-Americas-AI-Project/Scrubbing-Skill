#!/usr/bin/env node
// Unified stdio MCP worker — merges sap-harmony-mcp (35 tools) + sap-dcd-mcp (6 tools).
// Runs as a per-user child process spawned by mcp-server-http.mjs.
// Each instance gets its own HOME directory so sap-auth stores cookies in isolation.
// On BTP, BTP_USER_JWT is set in env and forwarded to the clients for Principal Propagation.

import { Server }              from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { HARMONY_TOOLS, dispatchHarmony } from './tools/harmony-tools.mjs';
import { DCD_TOOLS, dispatchDcd }         from './tools/dcd-tools.mjs';
import * as h from 'sap-harmony-mcp/harmony-client.mjs';
import * as d from 'sap-dcd-mcp/dcd-client.mjs';

// On BTP CF, propagate the user JWT to both clients so they use
// BTP Destination Service instead of Puppeteer SSO.
const btpJwt = process.env.BTP_USER_JWT;
if (btpJwt) {
  h.setBtpJwt(btpJwt);
  d.setBtpJwt(btpJwt);

  // Diagnostic: verify Destinations are reachable before first tool call
  try {
    const { getDestination } = await import('@sap-cloud-sdk/connectivity');
    for (const name of ['HARMONY_DEST', 'DCD_DEST']) {
      try {
        const dest = await getDestination({ destinationName: name, jwt: btpJwt, useCache: false });
        process.stdout.write(`[worker] ${name}: ${dest ? `OK (url=${dest.url})` : 'NOT FOUND'}\n`);
      } catch (e) {
        process.stdout.write(`[worker] ${name} check FAILED: ${e.message}\n`);
      }
    }
  } catch (e) {
    process.stdout.write(`[worker] Destination diagnostic error: ${e.message}\n`);
  }
}

const ALL_TOOLS = [...HARMONY_TOOLS, ...DCD_TOOLS]; // 41 tools

const server = new Server(
  { name: 'scrubbing-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ALL_TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    let result;
    if (name.startsWith('harmony_'))      result = await dispatchHarmony(name, args);
    else if (name.startsWith('dcd_'))     result = await dispatchDcd(name, args);
    else throw new Error(`Unknown tool: ${name}`);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
