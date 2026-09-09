#!/usr/bin/env node
// MCP stdio server exposing SAP "Digital Contract Data (DCD) Cockpit"
// (mdsdlcdcdcockpit / ZDCD_SRV;v=0002) — customer search, contract headers & line
// items, ~130 clause fields, and signed-contract PDF download.
//
// ROUTING HINT FOR THE LLM:
//   DCD is the signed-contract source of truth. Typical flow:
//     "find customer X in DCD" / "客户的合同"          → dcd_search(term) → ERPNUMBER
//     "this customer's contracts / ACV / products"     → dcd_customer_contracts(erp)
//     "contract terms / clauses / T4C / SLA"           → dcd_contract_clauses(erp, caseId)
//     "what documents are on this contract"            → dcd_contract_documents(caseId)
//     "download the signed contract / order form"      → dcd_download_contract(caseId)
//   Cross-system chain (from Harmony): an opp item's PREV_CONTR_ID + the opp header's
//   ACCOUNT_ERP_ID bridge to DCD — call dcd_customer_contracts(ACCOUNT_ERP_ID) and match
//   the row whose SALES_DOC_ID equals PREV_CONTR_ID left-padded to 10 digits → its
//   CASE_ID → dcd_download_contract(caseId). That orchestration lives in the caller/skill.
//   If anything returns an auth-shaped error, call dcd_whoami first.
//
// Fully headless — no Chrome/CDP. Reads go through shared sap-auth SSO.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as d from './dcd-client.mjs';

const server = new Server(
  { name: 'sap-dcd-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

const tools = [
  {
    name: 'dcd_whoami',
    description:
      'Sanity check — verifies the DCD Cockpit OData service (ZDCD_SRV) is reachable with the current SAP SSO cookie by fetching $metadata. **Fully headless: no Chrome/CDP.** Returns { ok, service, base, domain }. Call this first if any other dcd tool returns an auth-shaped error (401/403/SAML). A 403 usually means the caller lacks the DCD Fiori role — an authorization issue, not a bug.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dcd_search',
    description:
      'Free-text customer search in DCD → resolve a customer to its **ERPNUMBER** (the key every other dcd tool needs). Returns rows with ERPNUMBER, BUSINESSPARTNERNAME, COUNTRYNAME, NUMBER_OF_ACTIVE_CASES. A name can match many legal entities across countries (e.g. "Amperex" → CN/HK/DE/HU entities) — pick the right ERPNUMBER by country/name. Note DCD ERPNUMBER is the ERP customer number, NOT a CRM account id; when coming from a Harmony opp, use the opp header field ACCOUNT_ERP_ID directly instead of searching.',
    inputSchema: {
      type: 'object',
      required: ['term'],
      properties: {
        term: { type: 'string', description: 'Customer name (or fragment) to search, e.g. "Amperex".' },
      },
    },
  },
  {
    name: 'dcd_customer_contracts',
    description:
      'All contracts for a customer by ERP number: `contracts` = contract headers (one per case — CASE_ID, OPPORTUNITY_ID, QUOTE_ID, SALES_DOC_ID, AACV, TCV, currency, start/end/signature dates, DEAL_TYPE, DEAL_DESCRIPTION) and `lineItems` = per-product rows (CASE_ID, LPR, NET_VALUE, currency, dates, metric, quantity, QUOTE_ID). Dates are decoded to YYYY-MM-DD. To resolve a Harmony prior order: match the header whose SALES_DOC_ID equals the opp item PREV_CONTR_ID left-padded to 10 digits → its CASE_ID.',
    inputSchema: {
      type: 'object',
      required: ['erp'],
      properties: {
        erp: { type: 'string', description: 'Customer ERP number (from dcd_search or a Harmony opp ACCOUNT_ERP_ID), e.g. "2982402".' },
      },
    },
  },
  {
    name: 'dcd_contract_clauses',
    description:
      'The ~130 legal/commercial clause fields for a customer\'s contracts (T4C, audit rights, price protection, GTC version, SLAs, EU access, DPA, GRC risk level, discounts, termination terms, framework agreement, overall deal health, …). Filtered by ERP number; optionally narrowed to one caseId. Use when the user asks about contract terms, legal clauses, or deal-health flags rather than the commercials.',
    inputSchema: {
      type: 'object',
      required: ['erp'],
      properties: {
        erp: { type: 'string', description: 'Customer ERP number, e.g. "2982402".' },
        caseId: { type: 'string', description: 'Optional — narrow to a single contract case id, e.g. "3063438814".' },
      },
    },
  },
  {
    name: 'dcd_contract_documents',
    description:
      'List the documents attached to a contract case (metadata catalog only — filenames, category, mimetype, DocumentId). Categories include "Contract Documents" (the signed order form / CBT) and "other documents" (e.g. DocuSign certificate). Use this to see what is downloadable before calling dcd_download_contract, or to get a specific DocumentId.',
    inputSchema: {
      type: 'object',
      required: ['caseId'],
      properties: {
        caseId: { type: 'string', description: 'DCD contract case id, e.g. "3063438814".' },
      },
    },
  },
  {
    name: 'dcd_download_contract',
    description:
      'Download signed-contract PDF(s) for a case to disk and return their paths. With no documentId it downloads ONLY documents categorized as "Contract Documents" (the signed paperwork), and lists every other document (certificates, etc.) under `skipped` without downloading them. **Fails closed**: if no document on the case is categorized as a contract, it downloads NOTHING and returns `downloaded: []` with a `note` + `skipped[]` — it never silently dumps certificates as if they were the contract; pass an explicit documentId to fetch one of the skipped docs. Returns { caseId, dir, downloaded: [{ documentId, name, path, bytes, mimetype }], skipped: [{ documentId, name, categoryDesc, reason }], failed: [{ documentId, name, error }] }. Per-document failures land in `failed` without aborting the batch. This is the tool a skill calls when it needs the original signed contract file.',
    inputSchema: {
      type: 'object',
      required: ['caseId'],
      properties: {
        caseId: { type: 'string', description: 'DCD contract case id, e.g. "3063438814".' },
        documentId: { type: 'string', description: 'Optional — a specific DocumentId from dcd_contract_documents (e.g. to fetch a doc that was skipped as non-contract). Omit to download only Contract Documents.' },
        outDir: { type: 'string', description: 'Optional target directory (default: ./dcd-contracts-<caseId>).' },
      },
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    let result;
    switch (name) {
      case 'dcd_whoami':             result = await d.whoami(); break;
      case 'dcd_search':             result = await d.search(args.term); break;
      case 'dcd_customer_contracts': result = await d.customerContracts(args.erp); break;
      case 'dcd_contract_clauses':   result = await d.contractClauses(args.erp, args.caseId); break;
      case 'dcd_contract_documents': result = await d.contractDocuments(args.caseId); break;
      case 'dcd_download_contract':  result = await d.downloadContract(args.caseId, args.documentId, args.outDir); break;
      default: throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
