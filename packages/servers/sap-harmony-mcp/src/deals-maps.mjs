// deals-maps.mjs — code⇄label decode tables for the Deals-List (Opportunities)
// landing page, plus small helpers used by dealsList() in harmony-client.mjs.
//
// Source of truth: the AppValueHelps entity (ENTITY_NAME in {OPPORTUNITY,GENERAL})
// captured + verified 2026-07-11. Full contract in
// DEALS_LIST_REVERSE_ENGINEERING.md. These are the screenshot-relevant filter
// dropdowns; extend as needed.

// STATUS (Opportunity.STATUS)
export const STATUS = {
  E0001: 'In process',
  E0002: 'Discontinued',
  E0003: 'Won',
  E0004: 'Booked',
  E0005: 'Lost',
  E0007: 'New',
  E0014: 'Discontinuation Check',
};

// FORECAST (Opportunity.FORECAST) — the "Forecast Category" filter
export const FORECAST = {
  1: 'Committed',
  2: 'Probable',
  3: 'Upside',
  4: 'Excluded from Pipeline',
  5: 'Partner Forecasted',
  6: 'Partner Upside',
};

// CURR_PHASE (Opportunity.CURR_PHASE) — the "Phase" filter. ZP* standard,
// ZM* migration, ZF* financial-services; all map to the same 6 named stages.
export const PHASE = {
  ZP1: 'F - Recognize', ZP2: 'E - Consider', ZP3: 'D - Evaluate',
  ZP4: 'C - Select', ZP5: 'B - Negotiate', ZP6: 'A - Purchase',
  ZM1: 'D - Evaluate', ZM2: 'C - Select', ZM3: 'B - Negotiate', ZM4: 'A - Purchase', ZM5: 'E - Consider',
  ZF1: 'F - Recognize (FS)', ZF2: 'E - Consider (FS)', ZF3: 'D - Evaluate (FS)',
  ZF4: 'C - Select (FS)', ZF5: 'B - Negotiate (FS)', ZF6: 'A - Purchase (FS)',
};

// SOURCE (Opportunity.SOURCE) — the "Origin" filter. Full catalog is 102 codes;
// this is the subset needed to decode + to build the "renewal" convenience set.
export const SOURCE = {
  ZRE: 'Active Renewal', ZRA: 'Auto Renewal', ZRC: 'Auto With Changes',
  ZC4: 'Cloud Active-Renewal', ZC3: 'Cloud Auto-Renewal', ZC2: 'Cloud Restructure',
  ZC1: 'Cloud Add-On', ZC5: 'Cloud Exchange', ZC6: 'Cloud Conversion', ZC7: 'Cloud Mixed',
  ZOO: 'Opportunity Owner', ZRP: 'Renewal Pipeline', ZNB: 'New Business',
};

// The set of SOURCE codes that count as a "renewal" deal. Verified 2026-07-11
// as the codes the renewal-focused list variant uses.
export const RENEWAL_SOURCE_CODES = ['ZRE', 'ZRA', 'ZRC', 'ZC4', 'ZC3', 'ZC2'];
// Cloud-only subset (excludes on-prem/general renewal).
export const RENEWAL_SOURCE_CODES_CLOUD = ['ZC4', 'ZC3', 'ZC2'];

// QUARTER_ID (Opportunity.QUARTER_ID) — the "Close Date Quarter" filter.
// Relative tokens + absolute quarter codes. Absolute code = <YYYY><Q>, where
// Q=0 means "all four quarters of that year" (e.g. 20270 = Q1-Q4/2027).
export const QUARTER_RELATIVE = {
  CURR_QTR: 'Current Quarter', NEXT_QTR: 'Next Quarter', 'NEXT_+1': 'Next Quarter + 1',
  LAST_CURR: 'Last and Current Quarter', CURR_YEAR: 'Current Year',
  ROLL_4QTR: 'Rolling 4 Quarters', CURR_NEXT: 'Current and Next Quarter', 99990: 'All',
};

/**
 * Normalize a caller-supplied "quarter" into a QUARTER_ID code.
 * Accepts: an already-valid code ('20270', 'CURR_QTR'); a bare year ('2027',
 * 2027) → whole-year code '20270'; 'Q3/2027' or 'Q3-2027' → '20273'.
 */
export function toQuarterId(q) {
  if (q == null) return null;
  const s = String(q).trim();
  if (QUARTER_RELATIVE[s] || /^\d{5}$/.test(s)) return s;              // already a code
  const bareYear = s.match(/^(\d{4})$/);
  if (bareYear) return `${bareYear[1]}0`;                              // 2027 → 20270 (Q1-Q4)
  const qy = s.match(/^Q([1-4])[\/\-\s]?(\d{4})$/i);
  if (qy) return `${qy[2]}${qy[1]}`;                                   // Q3/2027 → 20273
  const yq = s.match(/^(\d{4})[\/\-\s]?Q([1-4])$/i);
  if (yq) return `${yq[1]}${yq[2]}`;                                   // 2027 Q3 → 20273
  return s;                                                           // pass through; server validates
}

/** Decode an OData v2 `/Date(ms)/` string to ISO yyyy-mm-dd (UTC). Null-safe. */
export function odataDate(v) {
  if (!v) return null;
  const m = String(v).match(/\/Date\((-?\d+)/);
  if (!m) return v;
  const d = new Date(Number(m[1]));
  if (Number.isNaN(d.getTime())) return v;
  return d.toISOString().slice(0, 10);
}

/** Look up a decode table, returning `${code} (label)` or just the code. */
function withLabel(table, code) {
  if (code == null || code === '') return code;
  const label = table[code] ?? table[String(code)];
  return label ? `${code} (${label})` : code;
}

/** Decode the coded fields on one Opportunities row into human-readable text. */
export function decodeOppRow(row) {
  const out = { ...row };
  if ('STATUS' in row) out.STATUS = withLabel(STATUS, row.STATUS);
  if ('FORECAST' in row) out.FORECAST = withLabel(FORECAST, row.FORECAST);
  if ('CURR_PHASE' in row) out.CURR_PHASE = withLabel(PHASE, row.CURR_PHASE);
  if ('SOURCE' in row) out.SOURCE = withLabel(SOURCE, row.SOURCE);
  if ('EXPECT_END' in row) out.EXPECT_END = odataDate(row.EXPECT_END);
  if ('LAST_UPDATED_ON' in row) out.LAST_UPDATED_ON = odataDate(row.LAST_UPDATED_ON);
  return out;
}

// ── Renewal-at-Risk fields (the "Risk Qualification" tab) ───────────────────
// Verified 2026-07-11 across 7 opps + cross-checked one value against the headed
// DOM read. Full evidence in HEADLESS_CAPABILITY_MATRIX.md.
//
// The 6 UI fields the renewal-risk skill reads, and their headless OData source:
//   renewal_risk_reasons → top-level RENEWAL_RISK (code) + RENEWAL_RISK_DESC (label)
//   business_scenario    → top-level RENEW_BUS_SCENARIO (code → BUSINESS_SCENARIO table)
//   risk_category        → top-level RISK_CATEGORY (code → RISK_CATEGORY table)
//   renewal_risk_note    → Notes sub-entity, TDID 'ZO69'  ⭐ high confidence
//   (ZRE4 / ZRE5)        → other renewal free-text notes (medium confidence on exact UI label)
//   (ZOLG)               → generic Opportunity Comments (timestamped)
//
// ⚠️ The renewal-risk skill's workbook uses a curated 27-value vocabulary for
// "Renewal Risk Reasons" that differs from RENEWAL_RISK_DESC's legacy wording.
// For READING/emptiness-checking these are fine; for pushing back to the skill's
// workbook, respect its vocabulary (references/risk-reasons.json).

// Note TDID → which UI free-text field it backs. Confidence noted inline.
export const NOTE_TDID = {
  ZO69: 'renewal_risk_note',       // high confidence (matches headed DOM read)
  ZRE4: 'renewal_note_zre4',       // medium — a renewal judgement/exec-summary-style note
  ZRE5: 'renewal_note_zre5',       // medium — additional renewal text
  ZOLG: 'opportunity_comments',    // high — "Opportunity Comments" + timestamp
};

// RENEW_BUS_SCENARIO code → label (AppValueHelps FIELD_NAME=BUSINESS_SCENARIO).
export const BUSINESS_SCENARIO = {
  1: 'Move to Competition', 2: 'SAP Initiated Full Termination',
  3: 'Partial Termination/Downsell', 4: 'Cloud Concession', 5: 'One-Time Credit',
  6: 'Multi-Year Credit', 7: 'Move to Partner Managed Cloud (PMC)',
  8: 'On-Prem to Cloud Extension (OP2C)', 10: 'HEC Extension',
  12: 'Cloud to On-Prem Extension (C2OP)', 13: 'Move to RISE/GROW',
  14: 'Customer/Partner Initiated Full Termination', 15: 'Termination for Convenience (T4C)',
  16: 'Partner Initiated Risk', 17: 'EU Data Act', 18: 'Swap Right Execution',
  19: 'Flexible Cloud Addendum (FCA) Execution', 20: 'Cloud to Cloud Extension Program (C2CEP)',
  22: 'Commit to Consume (C2C)', 23: 'Public to Private',
};

// RISK_CATEGORY code → label.
export const RISK_CATEGORY = {
  1: 'Product Risk', 2: 'Delivery Risk', 3: 'Commercial & Value Alignment Risk',
  4: 'Partner Risk', 5: 'Standard/Default', 6: 'Strategic Churn', 7: 'Strategic Churn',
  8: 'Partner Risk', 9: 'Non-Controllable', A: 'Shelfware',
};

// REVENUE_RETENTION code → label — this top-level field backs the UI's
// "Risk Retention Lever" dropdown (SAP's OData sap:label is the legacy
// "Revenue Retention Initiative"). Verified live 2026-07-12 by value
// correlation: NON↔None (opp 305902919), CMI↔Commercial Mitigation (opp
// 304315010, the opp risk-retention-lever.json was captured from). The 8 UI
// labels are known (references/risk-retention-lever.json); the remaining codes
// are inferred initialisms pending live confirmation and are marked UNVERIFIED —
// decode is best-effort, and writes rely on read-back not this table.
export const RISK_RETENTION_LEVER = {
  NON: 'None',                                   // verified (305902919)
  CMI: 'Commercial Mitigation',                  // verified (304315010)
  // UNVERIFIED initialisms — confirm codes against a live opp before trusting:
  PMI: 'Partner Mitigation',
  PEM: 'Product Engineering Mitigation',
  RRP: 'Renewal Rescue Program',
  RBV: 'Resell Business Value',
  SAD: 'Solution Area Delivery & Adoption Migration',
  VAS: 'Value Acceleration Services',
};

/**
 * Extract the Renewal-at-Risk fields from a headless `oppRead(id,'Notes')`
 * response (the `d` object of an Opportunities entity with $expand=Notes).
 * Returns human-readable fields + a `filled`/`empty` verdict.
 */
export function extractRiskFields(oppD) {
  const notes = oppD?.Notes?.results ?? [];
  const byTdid = {};
  for (const n of notes) byTdid[n.TDID] = (n.CONC_LINES || '').trim();

  const fields = {
    renewal_risk_reasons: oppD?.RENEWAL_RISK_DESC || '',
    renewal_risk_reasons_code: oppD?.RENEWAL_RISK || '',
    business_scenario: withLabel(BUSINESS_SCENARIO, oppD?.RENEW_BUS_SCENARIO) || '',
    risk_category: withLabel(RISK_CATEGORY, oppD?.RISK_CATEGORY) || '',
    risk_retention_lever: withLabel(RISK_RETENTION_LEVER, oppD?.REVENUE_RETENTION) || '',
    renewal_risk_note: byTdid.ZO69 || '',
    renewal_note_zre4: byTdid.ZRE4 || '',
    renewal_note_zre5: byTdid.ZRE5 || '',
    opportunity_comments: byTdid.ZOLG || '',
  };

  // "Has the renewal risk been filled in?" — the meaningful signals are the
  // Risk Reasons picklist and the free-text Note. Comments (ZOLG) are generic
  // and don't count as risk qualification.
  const hasReasons = !!fields.renewal_risk_reasons &&
    !/^default|not yet maintained/i.test(fields.renewal_risk_reasons);
  const hasNote = !!fields.renewal_risk_note;
  fields._risk_filled = hasReasons || hasNote;
  fields._risk_reasons_meaningful = hasReasons;
  fields._has_note = hasNote;
  return fields;
}
