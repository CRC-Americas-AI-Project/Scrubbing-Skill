// DCD tool definitions and dispatch for scrubbing-mcp.
// Imports client module via workspace package reference — no file duplication.

import * as d from 'sap-dcd-mcp/dcd-client.mjs';

export const DCD_TOOLS = [
  {
    name: 'dcd_whoami',
    description:
      'Sanity check — verifies the DCD Cockpit OData service (ZDCD_SRV) is reachable with the current SAP SSO cookie by fetching $metadata. **Fully headless: no Chrome/CDP.** Returns { ok, service, base, domain }. Call this first if any other dcd tool returns an auth-shaped error (401/403/SAML). A 403 usually means the caller lacks the DCD Fiori role — an authorization issue, not a bug.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dcd_search',
    description:
      'Free-text customer search in DCD → resolve a customer to its **ERPNUMBER** (the key every other dcd tool needs). Returns rows with ERPNUMBER, BUSINESSPARTNERNAME, COUNTRYNAME, NUMBER_OF_ACTIVE_CASES. A name can match many legal entities across countries — pick the right ERPNUMBER by country/name. Note DCD ERPNUMBER is the ERP customer number, NOT a CRM account id; when coming from a Harmony opp, use the opp header field ACCOUNT_ERP_ID directly instead of searching.',
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
      'Download signed-contract PDF(s) for a case to disk and return their paths. With no documentId it downloads ONLY documents categorized as "Contract Documents" (the signed paperwork). **Fails closed**: if no document on the case is categorized as a contract, it downloads NOTHING and returns `downloaded: []` with a `note` + `skipped[]`. Returns { caseId, dir, downloaded: [{ documentId, name, path, bytes, mimetype }], skipped: [...], failed: [...] }.',
    inputSchema: {
      type: 'object',
      required: ['caseId'],
      properties: {
        caseId: { type: 'string', description: 'DCD contract case id, e.g. "3063438814".' },
        documentId: { type: 'string', description: 'Optional — a specific DocumentId from dcd_contract_documents. Omit to download only Contract Documents.' },
        outDir: { type: 'string', description: 'Optional target directory (default: ./dcd-contracts-<caseId>).' },
      },
    },
  },
];

export async function dispatchDcd(name, args) {
  switch (name) {
    case 'dcd_whoami':             return d.whoami();
    case 'dcd_search':             return d.search(args.term);
    case 'dcd_customer_contracts': return d.customerContracts(args.erp);
    case 'dcd_contract_clauses':   return d.contractClauses(args.erp, args.caseId);
    case 'dcd_contract_documents': return d.contractDocuments(args.caseId);
    case 'dcd_download_contract':  return d.downloadContract(args.caseId, args.documentId, args.outDir);
    default: throw new Error(`Unknown dcd tool: ${name}`);
  }
}
