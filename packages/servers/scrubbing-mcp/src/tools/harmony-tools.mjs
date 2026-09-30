// Harmony tool definitions and dispatch for scrubbing-mcp.
// Imports client modules via workspace package references — no file duplication.

import * as h from 'sap-harmony-mcp/harmony-client.mjs';
import { connectCdpBrowser, dismissKnownDialogs } from 'sap-harmony-mcp/browser-helpers.mjs';

// cpq-client is lazy-loaded so starting the worker never triggers Chrome/CDP dependency.
let _cpq = null;
async function cpq() {
  if (!_cpq) _cpq = await import('sap-harmony-mcp/cpq-client.mjs');
  return _cpq;
}

export const HARMONY_TOOLS = [
  {
    name: 'renew_auth',
    description: 'Renova os cookies SAP (Harmony + DCD) via sap-auth SSO. Chamar IMEDIATAMENTE quando harmony_whoami ou dcd_whoami retornar erro de autenticação (401/403/SAML/CSRF/fetch failed). O sap-auth abre Edge/Chrome automaticamente com SSO corporativo Windows. Aguardar até ~60s. Após conclusão, repetir whoami para confirmar.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'harmony_whoami',
    description: 'Returns the currently authenticated Harmony user. Cheap end-to-end auth check via shared sap-auth (headless SSO). First call if anything else auth-errors.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'harmony_quote_permissions',
    description: 'Check read/write access for a quote by its composite number (e.g. "028981001204").',
    inputSchema: {
      type: 'object',
      required: ['quoteCompositeNumber'],
      properties: { quoteCompositeNumber: { type: 'string' } },
    },
  },
  {
    name: 'harmony_quote_read',
    description: 'Read full quote payload: Header, Items, and QuoteTables (Health_Discussion, PartnerFunctions, Deal_Review, Contractitems, etc). Composite number format: "028981001204" (12-digit composite, NOT the short cartId). ⚠️ "price date" gotcha: the per-line PriceDate in QuoteTables.Contractitems (YYYY-MM-DD, main rows only) is a DIFFERENT field from the editable Cart per-item AI_CL_PriceDate (EditableGroup 2, MM/DD/YY, seen via harmony_cart_execute_action(18) Items[].Values[]). Editing the Cart AI_CL_PriceDate does NOT change Contractitems.PriceDate. Data-layer field names here ≠ the editable Cart field ids — confirm the real field id + EditableGroup in a Cart snapshot before writing.',
    inputSchema: {
      type: 'object',
      required: ['quoteCompositeNumber'],
      properties: {
        quoteCompositeNumber: { type: 'string' },
        param: { type: 'string', description: 'What to fetch. Default "QuoteTables". Other values: "Header", "Items", or a comma list.', default: 'QuoteTables' },
      },
    },
  },
  {
    name: 'harmony_opp_read',
    description: 'Read an opportunity via OData: metadata + PartiesInvolved + Items + Attributes.',
    inputSchema: {
      type: 'object',
      required: ['oppId'],
      properties: {
        oppId: { type: 'string', description: 'Opportunity ID, e.g. "306192295"' },
        expand: { type: 'string', default: 'PartiesInvolved,Items,Attributes' },
      },
    },
  },
  {
    name: 'harmony_a8_check',
    description: 'Check opp line items for A8 special-approval / A4 informational SKUs (SAP "CLOUD Materials Requiring Approval in Selling" list). A8 = approver sign-off must be attached to quote; A4 = heads-up only. Neither blocks the material. Headless. Accepts one oppId or an array. See A8_CHECK.md.',
    inputSchema: {
      type: 'object',
      required: ['oppIds'],
      properties: {
        oppIds: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'A single opportunity ID or an array of IDs (checked one by one).',
        },
        type: { type: 'string', enum: ['A8', 'all'], default: 'A8', description: '"A8" (default) flags only special-approval materials; "all" also surfaces A4 (informational).' },
        refresh: { type: 'boolean', default: false, description: 'Force a re-fetch of the wiki list, bypassing the 24h cache.' },
      },
    },
  },
  {
    name: 'harmony_opp_list_quotes',
    description: 'List all quotes under an opportunity, with QuoteStatus, Description, TotalSummary, etc.',
    inputSchema: {
      type: 'object',
      required: ['oppId'],
      properties: {
        oppId: { type: 'string' },
        mainOnly: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'harmony_resolve_employee',
    description: 'Resolve an SAP i-number or name to their CPQ business-partner (BP) id via EmployeeSearch. Needed before filtering deals by owner/sales-team-member (Opportunity.OWNER stores the BP id, not the i-number). Returns { PARTNER, NAME, USERID, ADDRESS }.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'i-number (I077894), name, or an already-resolved BP id.' },
      },
    },
  },
  {
    name: 'harmony_read_risk_notes',
    description: 'Read an opp\'s Renewal-at-Risk fields — HEADLESS. Returns Renewal Risk Reasons, Business Scenario, Risk Category, the free-text Risk Note, and a `filled`/missing verdict per opp. Read counterpart to the renewal-risk skill (writing still goes through that skill). Accepts one oppId or an array.',
    inputSchema: {
      type: 'object',
      properties: {
        oppId: { type: 'string', description: 'Single opportunity ID.' },
        oppIds: { type: 'array', items: { type: 'string' }, description: 'Multiple opportunity IDs (batch — returns a missing/filled summary).' },
      },
    },
  },
  {
    name: 'harmony_deals_list',
    description: 'Query the Harmony "Deals List" worklist with human-friendly filters — HEADLESS. Auto-resolves owner/salesTeamMember i-number→BP id, translates quarter ("2027", "Q3/2027", "CURR_QTR"), expands origin="renewal" to the renewal SOURCE codes, and decodes STATUS/FORECAST/PHASE/SOURCE codes. Returns { count, resolved, filter, rows }.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Deal owner: i-number, name, or BP id. Auto-resolved to BP.' },
        salesTeamMember: { type: 'string', description: 'Sales team member: i-number, name, or BP id. Auto-resolved.' },
        quarter: { type: 'string', description: 'Close Date Quarter. "2027" (whole year) | "Q3/2027" | relative "CURR_QTR"/"NEXT_QTR" | raw code "20270".' },
        origin: {
          description: 'Origin/SOURCE. Keyword "renewal" (all renewal codes ZRE/ZRA/ZRC/ZC2/ZC3/ZC4) | "renewal-cloud" (ZC2/ZC3/ZC4 only) | a SOURCE code or array of codes.',
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        status: { description: 'STATUS code(s): E0001 In process, E0003 Won, E0007 New, E0002 Discontinued, E0004 Booked, E0005 Lost. Omit = all statuses.', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        forecast: { description: 'FORECAST code(s): 1 Committed, 2 Probable, 3 Upside, 4 Excluded, 5 Partner Forecasted, 6 Partner Upside.', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        account: { description: 'ACCOUNT id(s).', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        dealType: { description: 'DEAL_TYPE code(s), e.g. CN, UP, OD.', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        oppId: { type: 'string', description: 'Exact OPPT_ID.' },
        contractId: { type: 'string', description: 'Exact ORDER_ID (Contract ID).' },
        search: { type: 'string', description: 'Free-text (SAP fuzzy) search over the searchFocus field.' },
        searchFocus: { type: 'string', description: 'Field for free-text search (default ACCOUNT).' },
        top: { type: 'number', description: 'Page size (default 100).' },
        skip: { type: 'number', description: 'Rows to skip for paging (default 0).' },
        orderby: { type: 'string', description: 'OData $orderby (default "EXPECT_END asc").' },
        raw: { type: 'boolean', description: 'Return raw OData rows without code→label decode / date parsing (default false).' },
      },
    },
  },
  {
    name: 'harmony_cpq_script',
    description: 'Low-level: call any Callidus CPQ 1.0 script via the launchpad proxy (the layer the UI uses). Reverse-engineering entrypoint.',
    inputSchema: {
      type: 'object',
      required: ['scriptname', 'param'],
      properties: {
        scriptname: { type: 'string', description: 'Script name, e.g. "Q_API_GetQuoteData".' },
        param: { type: 'object', description: 'Script params as a JSON object; automatically JSON-encoded into the request body\'s Param field.' },
      },
    },
  },
  {
    name: 'harmony_messages_set',
    description: 'Query the OData MessagesSet — the "business rule warnings" the UI shows on the Deal Review pane (e.g. "No competitor identified"). Check what\'s blocking approval without opening the UI. Headless.',
    inputSchema: {
      type: 'object',
      required: ['oppId'],
      properties: {
        oppId: { type: 'string', description: 'Opportunity ID, e.g. "306192295".' },
        type: { type: 'string', default: 'E', description: 'Message type filter. E = Error (default), W = Warning, I = Info.' },
      },
    },
  },
  {
    name: 'harmony_open_session',
    description: 'Launch/reuse the headed Chrome on :9222 that CPQ-direct / Cart tools depend on, optionally deep-linking to an opp or quote. Reuses an existing tab for the same URL; never disrupts a session. CANNOT log you in (SSO is interactive) — complete login by hand, then verify with harmony_cpq_auth_check. ⚠️ quoteId MUST be the full 12-digit COMPOSITE number (e.g. 028981001207), NOT the short cartId.',
    inputSchema: {
      type: 'object',
      properties: {
        oppId: { type: ['string', 'number'], description: 'Optional opportunity id to deep-link to, e.g. 306165617.' },
        quoteId: { type: ['string', 'number'], description: 'Optional quote id. Requires oppId; deep-links straight to the quote (Cart page). MUST be the full 12-digit composite number, not the short cartId.' },
      },
    },
  },
  {
    name: 'harmony_cpq_auth_check',
    description: 'Diagnostic: verify the CPQ-direct auth path (cookies + csrf token from Chrome :9222) before calling harmony_cart_* / harmony_configurator_* / harmony_cpq_direct_script.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'harmony_cpq_direct_script',
    description: 'Low-level: call a CPQ 1.0 script on the CPQ-direct endpoint (uses SHORT numeric quoteId, not the composite). Differs from harmony_cpq_script (launchpad proxy). Requires an active Chrome session.',
    inputSchema: {
      type: 'object',
      required: ['scriptName', 'shortQuoteId', 'param'],
      properties: {
        scriptName: { type: 'string', description: 'Script name, e.g. "Q_API_DealHealthTimestamp".' },
        shortQuoteId: { type: ['string', 'number'], description: 'Short numeric quote id, e.g. 1205. If you pass a 12-digit composite, it\'s auto-shortened.' },
        param: { type: 'object', description: 'Script parameters as JSON.' },
      },
    },
  },
  {
    name: 'harmony_cart_change_cells',
    description: 'Edit a CPQ 1.0 QuoteTable field via the CPQ-direct path (bypasses OData MERGE validation). Needs the target table Id + row Id + column Id (find via harmony_quote_read). Requires an active Chrome session.',
    inputSchema: {
      type: 'object',
      required: ['shortQuoteId', 'tabId', 'dirtyQuoteTables'],
      properties: {
        shortQuoteId: { type: ['string', 'number'], description: 'Short numeric quote id, e.g. 1205.' },
        tabId: { type: ['string', 'number'], description: 'Tab id where the quote table lives, e.g. 5 (Deal Review).' },
        dirtyQuoteTables: {
          type: 'array',
          description: 'Array of table edits. Each item: {Id: <tableId>, Rows: [{Id: <rowId>, Cells: [{ColumnId: <colId>, Value: "<value>"}]}]}.',
          items: { type: 'object' },
        },
        itemsFilterQuery: { type: 'array', description: 'Optional itemsFilterQuery to preserve UI collapse/expand state. Defaults to [].', default: [] },
      },
    },
  },
  {
    name: 'harmony_cart_execute_action',
    description: 'Trigger a CPQ 1.0 Cart action by numeric actionId (e.g. 18 = read snapshot, 19 = Save). Requires an active Chrome session. ⚠️ PAGINATION: actionId 18 returns only the FIRST PAGE of main items — always confirm len(Items)==TotalItems before editing.',
    inputSchema: {
      type: 'object',
      required: ['shortQuoteId', 'actionId'],
      properties: {
        shortQuoteId: { type: ['string', 'number'], description: 'Short numeric quote id, e.g. 1205.' },
        actionId: { type: ['string', 'number'], description: 'Numeric actionId, e.g. 19 (save after cell edit).' },
        payload: {
          type: 'object',
          description: 'Optional extra payload; merged into the default {GroupToActivate:1, DirtyCells:{}, DirtyCustomFields:{}, ItemsFilterQuery:[]}.',
        },
      },
    },
  },
  {
    name: 'harmony_cart_set_active_editable_group',
    description: 'Activate a Cart editable group — required BEFORE saving DirtyCells in a non-default group (Net Price / Discount edits). Canonical 3-step save sequence: set group → calculate → execute 19. Requires an active Chrome session.',
    inputSchema: {
      type: 'object',
      required: ['shortQuoteId', 'editableGroup'],
      properties: {
        shortQuoteId: { type: ['string', 'number'], description: 'Short numeric quote id, e.g. 1205.' },
        editableGroup: { type: ['string', 'number'], description: 'Editable group number. Look up from a Cart snapshot (ExecuteAction(18)).Items[].Values[].EditableGroup.' },
        itemsFilterQuery: { type: 'array', description: 'Optional collapse/expand state array. Defaults to [].', default: [] },
      },
    },
  },
  {
    name: 'harmony_cart_calculate',
    description: 'Cart/Calculate — dry-run pricing preview (apply DirtyCells without persisting). ⚠️ Side effect: for non-default editable groups the dirty state becomes server-side sticky, so a following ExecuteAction(19) saves it. Requires an active Chrome session.',
    inputSchema: {
      type: 'object',
      required: ['shortQuoteId'],
      properties: {
        shortQuoteId: { type: ['string', 'number'], description: 'Short numeric quote id, e.g. 1205.' },
        payload: { type: 'object', description: 'Optional payload; merged into the default {GroupToActivate:1, DirtyCells:{}, DirtyCustomFields:{}, ItemsFilterQuery:[], QuoteTableFilters:null}.' },
      },
    },
  },
  {
    name: 'harmony_configurator_add_to_quote',
    description: 'Add a configured product to the current CPQ 1.0 quote. Payload shape is product/configurator-specific — copy it from a captured live UI flow. Requires an active Chrome session.',
    inputSchema: {
      type: 'object',
      required: ['payload'],
      properties: {
        payload: { type: 'object', description: 'Configurator state payload — copy from a probed live flow.' },
      },
    },
  },
  {
    name: 'harmony_odata_merge',
    description: 'Low-level: partial-update a non-Opportunity OData entity via POST + X-HTTP-Method:MERGE. ⚠️ Does NOT work for Opportunity edits (MERGE handler unimplemented → HTTP 501) — for opp fields use harmony_set_no_competitor / harmony_set_no_engaged_si / harmony_set_opp_description instead.',
    inputSchema: {
      type: 'object',
      required: ['path', 'patch'],
      properties: {
        path: { type: 'string', description: `Entity path, e.g. "Opportunities('306192295')".` },
        patch: { type: 'object', description: 'JSON body containing only the fields to update.' },
      },
    },
  },
  {
    name: 'harmony_set_no_competitor',
    description: 'Clear the "No competitor identified" error on an opp by setting the No-Competitor-Involved flag — HEADLESS, full-entity POST, verified to touch only NO_COMP_INV + ERROR.',
    inputSchema: {
      type: 'object',
      required: ['oppId'],
      properties: { oppId: { type: 'string', description: 'Opportunity ID, e.g. "306165617".' } },
    },
  },
  {
    name: 'harmony_set_no_engaged_si',
    description: 'Clear the "add an Engaged SI or mark No Engaged SI" error on an opp by setting the No-Engaged-SI flag — HEADLESS, full-entity POST.',
    inputSchema: {
      type: 'object',
      required: ['oppId'],
      properties: { oppId: { type: 'string', description: 'Opportunity ID, e.g. "304527974".' } },
    },
  },
  {
    name: 'harmony_set_opp_description',
    description: 'Set an opp\'s DESCRIPTION field — HEADLESS, full-entity POST. Self-guards: re-reads and diffs afterward. `ok` is true ONLY when the write landed AND nothing unexpected changed.',
    inputSchema: {
      type: 'object',
      required: ['oppId', 'text'],
      properties: {
        oppId: { type: 'string', description: 'Opportunity ID, e.g. "305597474".' },
        text: { type: 'string', description: 'The new DESCRIPTION value to write.' },
      },
    },
  },
  {
    name: 'harmony_set_renewal_risk',
    description: 'Set the editable Renewal-at-Risk code fields (Renewal Risk Reasons, Business Scenario, Risk Retention Lever) on an opp — HEADLESS, full-entity POST. Refuses closed opps. Verifies by read-back.',
    inputSchema: {
      type: 'object',
      required: ['oppId'],
      properties: {
        oppId: { type: 'string', description: 'Opportunity ID, e.g. "306192295".' },
        renewalRisk: { type: 'string', description: 'RENEWAL_RISK code — the Renewal Risk Reasons picklist value.' },
        renewBusScenario: { type: 'string', description: 'RENEW_BUS_SCENARIO code — Business Scenario (e.g. "2" = SAP Initiated Full Termination, "15" = Termination for Convenience/T4C).' },
        riskRetentionLever: { type: 'string', description: 'REVENUE_RETENTION code — the "Risk Retention Lever" dropdown (e.g. "NON" = None, "CMI" = Commercial Mitigation).' },
      },
    },
  },
  {
    name: 'harmony_set_risk_notes',
    description: 'Set the three editable Renewal-at-Risk free-text boxes (Renewal Risk Note, Executive Summary / Engagement Actions, Support Needed) on an opp — HEADLESS, full-entity deep-insert. Refuses closed opps. Verifies by read-back.',
    inputSchema: {
      type: 'object',
      required: ['oppId'],
      properties: {
        oppId: { type: 'string', description: 'Opportunity ID, e.g. "305902919".' },
        renewalRiskNote:  { type: 'string', description: 'Renewal Risk Note / Internal Roadblocks (TDID ZO69).' },
        executiveSummary: { type: 'string', description: 'Renewal Close Plan — CRE + AO/AE (TDID ZRE5).' },
        supportNeeded:    { type: 'string', description: 'Support Needed (TDID ZO92).' },
        obvValidated:     { type: 'string', description: 'OBV Validated note — comparison and delta analysis (TDID ZRE1).' },
        gtcDeviations:    { type: 'string', description: 'GTC Deviations note — non-standard contract terms (TDID ZRE3).' },
        redlines:         { type: 'string', description: 'Redlines note — MUST be identical copy of gtcDeviations (TDID ZREE).' },
        perAnnumLanguage: { type: 'string', description: 'Per Annum Language note — IPCA/CPI language evidence (TDID ZRE6).' },
        upliftRemarks:    { type: 'string', description: 'Uplift % Remarks — calculated IPCA % with months used (TDID ZRE8).' },
      },
    },
  },
  {
    name: 'harmony_read_renewal_execution',
    description: 'Read the RenewalExecution entity for an opportunity — HEADLESS. Returns all fields: RENEWAL_MOTION, OBV_VALIDATED, GTC_DATE, GTC_DEVIATIONS, CONTR_UPLF_TYP, NEG_UPLF_LANG, ROADBLOCK, REDLINE, SLIP_RISK, etc.',
    inputSchema: {
      type: 'object',
      required: ['oppId'],
      properties: {
        oppId: { type: 'string', description: 'Opportunity ID, e.g. "306445317".' },
      },
    },
  },
  {
    name: 'harmony_set_renewal_execution',
    description: 'Partial-update the RenewalExecution entity via MERGE — HEADLESS. Accepts friendly keys (renewalMotion, obvValidated, gtcDate, gtcDeviations, contrUpliftType, negUpliftLang, roadblock, redline, slipRisk, rsnPaLang, etc.) OR raw OData field names. GTC_DATE / EXP_SIGN_DATE accept ISO "YYYY-MM-DD". Verifies by read-back.',
    inputSchema: {
      type: 'object',
      required: ['oppId', 'patch'],
      properties: {
        oppId: { type: 'string', description: 'Opportunity ID, e.g. "306445317".' },
        patch: {
          type: 'object',
          description: 'Fields to update. Friendly keys: renewalMotion, engagement, obvValidated (Y/N), obvAmount, gtcDate (YYYY-MM-DD), gtcDeviations (Y/N), contrUpliftPc, contrUpliftType, contrUpliftTerm, dealUpliftPc, dealUpliftReason, negUpliftLang, churnRecov, churnRecovAmt, psChurnType, expSignDate (YYYY-MM-DD), docusign, roadblock, redline, slipRisk (Y/N), rsnPaLang. Raw OData field names also accepted.',
        },
      },
    },
  },
  {
    name: 'harmony_set_renewal_execution_notes',
    description: 'Write the Renewal Execution section text notes on an opp — HEADLESS, full-entity deep-insert POST. TDIDs verified: obvValidatedNote→ZRE1, gtcDeviationsText→ZRE3, renewalClosePlan→ZRE4, internalRoadblocks→ZRED, upliftRemarks→ZRE6, perAnnumLanguage→ZRE8, redlines→ZREE. All are additive (append, never overwrite). Returns { ok, status, changedNotes, unexpectedChanges }.',
    inputSchema: {
      type: 'object',
      required: ['oppId'],
      properties: {
        oppId: { type: 'string', description: 'Opportunity ID, e.g. "306252511".' },
        obvValidatedNote: { type: 'string', description: 'OBV Validated analysis note (TDID ZRE1). Include predecessor OBV vs current OBV delta.' },
        gtcDeviationsText: { type: 'string', description: 'GTC Deviations text (TDID ZRE3). Use "- This is an active-renewal contract." for active renewals.' },
        renewalClosePlan: { type: 'string', description: 'Renewal Close Plan (TDID ZRE4). Include CRE name, AO name, close timeline.' },
        internalRoadblocks: { type: 'string', description: 'Internal Roadblocks note (TDID ZRED). Include blockers, locked fields, missing documents, etc.' },
        upliftRemarks: { type: 'string', description: 'Uplift % Remarks (TDID ZRE6). Include IPCA cumulative calculation detail.' },
        perAnnumLanguage: { type: 'string', description: 'Per Annum Language evidence (TDID ZRE8). Include IPCA clause text from contract.' },
        redlines: { type: 'string', description: 'Redlines (TDID ZREE). Must be identical copy of gtcDeviationsText per scrubbing rules.' },
      },
    },
  },
  {
    name: 'harmony_set_close_date',
    description: 'Set the opportunity Close Date (EXPECT_END) headlessly — HEADLESS. Checks CLOSE_DATE_EDITABLE first; if locked returns { ok: false, wasEditable: false } without touching the server. Returns { ok, status, wasEditable, closeDateAfter, errorMessage? }. errorMessage is populated with the SAP backend error text when ok: false.',
    inputSchema: {
      type: 'object',
      required: ['oppId', 'date'],
      properties: {
        oppId: { type: 'string', description: 'Opportunity ID, e.g. "305988635".' },
        date: { type: 'string', description: 'New close date in YYYY-MM-DD format, e.g. "2027-08-31".' },
      },
    },
  },
  {
    name: 'harmony_odata_function',
    description: 'Low-level: invoke a Harmony OData FunctionImport (RPC action). Read-only imports run freely; destructive imports (CancelAllQuotes, DiscontinueHDMOpp, CreateDeal, CopyOpportunity, ...) are BLOCKED unless confirmDestructive:true.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'FunctionImport name, e.g. "GetContractsFromOpp".' },
        params: { type: 'object', description: 'Parameters as key-value pairs. String values are auto-quoted for OData.' },
        method: { type: 'string', enum: ['GET', 'POST'], default: 'GET' },
        confirmDestructive: { type: 'boolean', default: false, description: 'Required true to run a destructive/unknown import or any POST.' },
      },
    },
  },
  {
    name: 'harmony_odata_metadata',
    description: 'Fetch the raw EDMX schema for the zharmony_callidus_srv OData service. Use to discover entities, properties, and FunctionImports.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'harmony_cpq2_list_quotes',
    description: 'List all CPQ 2.0 quotes under an opp (QuoteId short int for API calls, QuoteNumber composite for display, status, TCV, dates, item count). CPQ 2.0 quotes do NOT appear in harmony_opp_list_quotes — use this for opps with CPQ_SYSTEM_ID="2". Headless.',
    inputSchema: {
      type: 'object',
      required: ['oppId'],
      properties: {
        oppId: { type: 'string', description: 'Opportunity ID, e.g. "305571784".' },
      },
    },
  },
  {
    name: 'harmony_cpq2_read_quote',
    description: 'Read a CPQ 2.0 quote header — custom fields (contract dates, T&C, deal health, pricing), involved parties, QuoteTable names, pricing totals. Use the short QuoteId from harmony_cpq2_list_quotes, not the composite. Headless.',
    inputSchema: {
      type: 'object',
      required: ['shortQuoteId'],
      properties: {
        shortQuoteId: { type: ['string', 'number'], description: 'Short numeric quote ID (e.g. 20758). Get from harmony_cpq2_list_quotes → QuoteId.' },
      },
    },
  },
  {
    name: 'harmony_cpq2_read_items',
    description: 'Read all line items of a CPQ 2.0 quote with selected attributes and pricing conditions. Headless.',
    inputSchema: {
      type: 'object',
      required: ['shortQuoteId'],
      properties: {
        shortQuoteId: { type: ['string', 'number'], description: 'Short numeric quote ID.' },
        expand: { type: 'string', default: 'selectedAttributes,pricingConditions', description: 'Comma-separated expansions.' },
      },
    },
  },
  {
    name: 'harmony_cpq2_read_table',
    description: 'Read rows of a CPQ 2.0 QuoteTable by exact name (e.g. Cloud_Pricing_Summary, Deal_Approval_Questionnaire, T4CRights, Price_Protection). Get the full table-name list from harmony_cpq2_read_quote → QuoteTables. Headless.',
    inputSchema: {
      type: 'object',
      required: ['shortQuoteId', 'tableName'],
      properties: {
        shortQuoteId: { type: ['string', 'number'], description: 'Short numeric quote ID.' },
        tableName: { type: 'string', description: 'QuoteTable name (exact, case-sensitive). Get the full list from harmony_cpq2_read_quote → QuoteTables array.' },
      },
    },
  },
  {
    name: 'harmony_cpq2_execute_action',
    description: 'Execute a Cart action on a CPQ 2.0 quote — HEADLESS (no Chrome, unlike CPQ 1.0). actionId 18=Reprice, 19=Save. ⚠️ 19 (Save) persists to production — use with care.',
    inputSchema: {
      type: 'object',
      required: ['shortQuoteId', 'actionId'],
      properties: {
        shortQuoteId: { type: ['string', 'number'], description: 'Short numeric quote ID.' },
        actionId: { type: ['string', 'number'], description: 'Numeric actionId. 18=Reprice, 19=Save.' },
        payload: { type: 'object', description: 'Optional extra payload; merged into default {GroupToActivate:1, DirtyCells:{}, DirtyCustomFields:{}, ItemsFilterQuery:[]}.' },
      },
    },
  },
  {
    name: 'harmony_cpq2_script',
    description: 'Low-level: call a CPQ 2.0 custom script via the budgie OAuth proxy — HEADLESS. CPQ 2.0 counterpart to harmony_cpq_script (different domain, JSON body).',
    inputSchema: {
      type: 'object',
      required: ['scriptName', 'param'],
      properties: {
        scriptName: { type: 'string', description: 'Script name (PascalCase), e.g. "Q_API_GetOpportunityQuotes".' },
        param: { type: 'object', description: 'Script parameters as JSON object.' },
      },
    },
  },
];

export async function dispatchHarmony(name, args) {
  switch (name) {
    case 'renew_auth': return h.renewAuth();
    case 'harmony_whoami': return h.whoami();
    case 'harmony_quote_permissions': return h.quotePermissions(args.quoteCompositeNumber);
    case 'harmony_quote_read': return h.quoteRead(args.quoteCompositeNumber, args.param);
    case 'harmony_opp_read': return h.oppRead(args.oppId, args.expand);
    case 'harmony_a8_check': return h.a8CheckOpps(args.oppIds, { type: args.type, refresh: args.refresh });
    case 'harmony_opp_list_quotes': return h.oppListQuotes(args.oppId, args.mainOnly);
    case 'harmony_resolve_employee': return h.resolveEmployee(args.query);
    case 'harmony_read_risk_notes': {
      if (Array.isArray(args.oppIds) && args.oppIds.length) return h.readRiskNotesBatch(args.oppIds);
      if (args.oppId) return h.readRiskNotes(args.oppId);
      throw new Error('harmony_read_risk_notes requires oppId or oppIds');
    }
    case 'harmony_deals_list': {
      const { top, skip, orderby, raw, ...filters } = args;
      return h.dealsList(filters, { top, skip, orderby, raw });
    }
    case 'harmony_cpq_script': return h.callidusScript(args.scriptname, args.param);
    case 'harmony_messages_set': return h.messagesSet(args.oppId, args.type);
    case 'harmony_open_session': {
      const session = await (await cpq()).openSession(args);
      if (session.cdpReady) {
        try {
          if (session.openedTab || session.launched) await new Promise(r => setTimeout(r, 2500));
          const browser = await connectCdpBrowser();
          try {
            const context = browser.contexts()[0];
            if (context) {
              const sweep = await dismissKnownDialogs(context);
              session.popupsDismissed = sweep.dismissed;
              session.popupsClicked = sweep.clicked;
            }
          } finally {
            await browser.close().catch(() => {});
          }
        } catch (e) {
          session.popupSweepError = e.message;
        }
      }
      return session;
    }
    case 'harmony_cpq_auth_check': return (await cpq()).cpqAuthContext({ force: true }).then(c => ({
      ok: true, hasCsrf: !!c.csrf, samlSessionSet: c.samlSessionSet, cookieCount: c.cookieCount, readAt: c.readAt,
    }));
    case 'harmony_cpq_direct_script': return (await cpq()).cpqScript(args.scriptName, args.shortQuoteId, args.param);
    case 'harmony_cart_change_cells': return (await cpq()).cartChangeCells(args.shortQuoteId, args.tabId, args.dirtyQuoteTables, args.itemsFilterQuery);
    case 'harmony_cart_execute_action': return (await cpq()).cartExecuteAction(args.shortQuoteId, args.actionId, args.payload);
    case 'harmony_cart_set_active_editable_group': return (await cpq()).cartSetActiveEditableGroup(args.shortQuoteId, args.editableGroup, args.itemsFilterQuery);
    case 'harmony_cart_calculate': return (await cpq()).cartCalculate(args.shortQuoteId, args.payload);
    case 'harmony_configurator_add_to_quote': return (await cpq()).configuratorAddToQuote(args.payload);
    case 'harmony_odata_merge': return h.odataMerge(args.path, args.patch);
    case 'harmony_set_no_competitor': return h.setNoCompetitor(args.oppId);
    case 'harmony_set_no_engaged_si': return h.setNoEngagedSI(args.oppId);
    case 'harmony_set_opp_description': return h.setOppDescription(args.oppId, args.text);
    case 'harmony_set_renewal_risk': {
      const patch = {};
      if (args.renewalRisk != null) patch.renewalRisk = args.renewalRisk;
      if (args.renewBusScenario != null) patch.renewBusScenario = args.renewBusScenario;
      if (args.riskRetentionLever != null) patch.riskRetentionLever = args.riskRetentionLever;
      return h.setRenewalRisk(args.oppId, patch);
    }
    case 'harmony_set_risk_notes': {
      const patch = {};
      if (args.renewalRiskNote != null) patch.renewalRiskNote = args.renewalRiskNote;
      if (args.executiveSummary != null) patch.executiveSummary = args.executiveSummary;
      if (args.supportNeeded != null) patch.supportNeeded = args.supportNeeded;
      if (args.obvValidated != null) patch.obvValidated = args.obvValidated;
      if (args.gtcDeviations != null) patch.gtcDeviations = args.gtcDeviations;
      if (args.redlines != null) patch.redlines = args.redlines;
      if (args.perAnnumLanguage != null) patch.perAnnumLanguage = args.perAnnumLanguage;
      if (args.upliftRemarks != null) patch.upliftRemarks = args.upliftRemarks;
      return h.setRiskNotes(args.oppId, patch);
    }
    case 'harmony_read_renewal_execution': return h.readRenewalExecution(args.oppId);
    case 'harmony_set_renewal_execution': return h.setRenewalExecution(args.oppId, args.patch);
    case 'harmony_set_renewal_execution_notes': return h.setRenewalExecutionNotes(args.oppId, args);
    case 'harmony_set_close_date': return h.setCloseDate(args.oppId, args.date);
    case 'harmony_odata_function': return h.odataFunction(args.name, args.params, args.method, args.confirmDestructive);
    case 'harmony_odata_metadata': return { xml: (await h.odataMetadata()).slice(0, 40000) };
    case 'harmony_cpq2_list_quotes': return h.cpq2ListQuotes(args.oppId);
    case 'harmony_cpq2_read_quote': return h.cpq2ReadQuote(args.shortQuoteId);
    case 'harmony_cpq2_read_items': return h.cpq2ReadItems(args.shortQuoteId, args.expand);
    case 'harmony_cpq2_read_table': return h.cpq2ReadTable(args.shortQuoteId, args.tableName);
    case 'harmony_cpq2_execute_action': return h.cpq2ExecuteAction(args.shortQuoteId, args.actionId, args.payload);
    case 'harmony_cpq2_script': return h.cpq2Script(args.scriptName, args.param);
    default: throw new Error(`Unknown harmony tool: ${name}`);
  }
}
