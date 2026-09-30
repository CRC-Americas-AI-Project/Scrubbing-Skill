// harmony-client.mjs — thin API client for Harmony Quote (Callidus CPQ).
//
// Backed by SAP Harmony (a Callidus CPQ tenant hosted on Cloud Foundry):
//   Host:        sapit-sales-prod-budgie.launchpad.cfapps.eu10.hana.ondemand.com
//   App prefix:  /1c83fff3-0c88-41fa-a608-c0fa5d3dec6f.hdm.hdm
//   Services:    OData `zharmony_callidus_srv` (entities + FunctionImports)
//                Callidus scripts `/callidus/customapi/executescriptfed`
//
// Authentication: shared sap-auth package (headless SSO → cookie in
// ~/.sap-mcp/auth.json → auto-refresh). Same mechanism as sap-one360-mcp,
// sap-ekx-mcp, sap-wiki-mcp. No Chrome / no CDP at request time — the auth
// browser only runs when the cookie is missing or expired.
//
// For calls that hit the CPQ domain directly (sap-ies-sales.cpq.cloud.sap),
// see cpq-client.mjs — that path has separate auth and MUST NOT import
// sap-auth (its process manager would kill the user's CDP Chrome).

import { createAuthClient, AuthManager } from 'sap-auth';
import { isBtp, btpFetch } from 'btp-fetch';
import {
  toQuarterId, decodeOppRow, RENEWAL_SOURCE_CODES, RENEWAL_SOURCE_CODES_CLOUD,
  extractRiskFields,
} from './deals-maps.mjs';
import { getA8Map, a8Check } from './a8-list.mjs';

const BUDGIE_HOST = 'sapit-sales-prod-budgie.launchpad.cfapps.eu10.hana.ondemand.com';
const BUDGIE = `https://${BUDGIE_HOST}`;
const APP_PREFIX = '/1c83fff3-0c88-41fa-a608-c0fa5d3dec6f.hdm.hdm';
const ODATA_ROOT = `${BUDGIE}${APP_PREFIX}/sap/opu/odata/sap/zharmony_callidus_srv`;

// ── Auth mode: cookie passthrough > BTP JWT > sap-auth local ─────────────────
// 1. SAP_SESSION_COOKIE set  → use cookie directly (forwarded by caller)
// 2. _btpJwt set             → JWT from Joule OAuth2 → Principal Propagation via BTP Destination
// 3. fallback                → sap-auth Puppeteer SSO (development only)
let _btpJwt = null;
export function setBtpJwt(jwt) { _btpJwt = jwt; }

async function apiFetch(url, init) {
  const sapCookie = process.env.SAP_SESSION_COOKIE;
  if (sapCookie) {
    // Cookie passthrough mode: cookie was forwarded by the caller (e.g. Joule header)
    const res = await fetch(url, {
      ...init,
      headers: { Accept: 'application/json', ...init?.headers, Cookie: sapCookie },
    });
    if (res.status === 401 || res.status === 403) throw new Error(`Harmony ${res.status}: SAP cookie may have expired. Refresh X-Sap-Cookie header.`);
    if (res.status === 200) {
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('text/html')) {
        const body = await res.text();
        if (isSamlLoginBody(body)) throw new Error('Harmony: SAP cookie expired (SAML redirect). Refresh X-Sap-Cookie header.');
        return new Response(body, { status: 200, headers: res.headers });
      }
    }
    return res;
  }
  if (_btpJwt) {
    const path = url.startsWith(BUDGIE) ? url.slice(BUDGIE.length) : url;
    try {
      return await btpFetch('HARMONY_DEST', _btpJwt, path, init);
    } catch (e) {
      process.stdout.write(`[harmony-client] btpFetch error: ${e.message}\n`);
      throw new Error(`Harmony via BTP: ${e.message}`);
    }
  }
  // Development fallback: sap-auth Puppeteer SSO (never runs on BTP CF when Joule sends JWT)
  return authClient.fetch(url, init);
}

// ── Auth (shared sap-auth) ──────────────────────────────────────────────────
// The gateway returns a small SAML-fragment HTML body (200 OK, text/html) when
// the session is invalid — detect that so authClient.fetch() force-refreshes
// and retries. Same pattern as sap-one360-mcp.
function isSamlLoginBody(text) {
  if (!text || typeof text !== 'string') return false;
  if (!(text.startsWith('<html') || text.startsWith('<!DOCTYPE'))) return false;
  return /fragmentAfterLogin|SAMLRequest|SAMLResponse|nonce=/i.test(text.slice(0, 800));
}

const authClient = createAuthClient({
  domain: BUDGIE_HOST,
  method: 'sap-sso',
  // Landing page — same URL the user sees when opening the app in a browser.
  entryUrl: `${BUDGIE}${APP_PREFIX}/index.html`,
  isAuthFailure: async (r) => {
    if (r.status === 401 || r.status === 403) return true;
    if (r.status === 200) {
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('text/html')) {
        const body = await r.text();
        if (isSamlLoginBody(body)) return true;
      }
    }
    return false;
  },
});

/** Low-level: call the Callidus executescriptfed with a named script + params. */
export async function callidusScript(scriptname, param) {
  const body = new URLSearchParams({
    scriptname,
    domain: 'SAP',
    Param: JSON.stringify(param),
  }).toString();
  const url = `${BUDGIE}${APP_PREFIX}/callidus/customapi/executescriptfed`;
  const res = await apiFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body,
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { _raw: text }; }
  if (!res.ok) throw new Error(`callidus ${scriptname} HTTP ${res.status}: ${text.slice(0, 400)}`);
  return parsed;
}

/** Low-level: OData GET on the zharmony_callidus_srv service. */
export async function odataGet(path, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, v);
  const url = `${ODATA_ROOT}/${path}${qs.toString() ? `?${qs}` : ''}`;
  const res = await apiFetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`OData GET ${path} HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return res.json();
}

// ============ High-level tools ============

/** Who am I? Cheap end-to-end auth check. */
export async function whoami() {
  const url = `${BUDGIE}${APP_PREFIX}/user-api/currentUser`;
  const res = await apiFetch(url);
  return res.json();
}

/** Read/write permission check for a specific quote. */
export async function quotePermissions(quoteCompositeNumber) {
  const r = await callidusScript('GetQuoteAuth', { QuoteNumber: quoteCompositeNumber });
  return r.data;
}

/** Full quote payload: Header + QuoteTables (Health_Discussion, Deal_Review, PartnerFunctions, ...) */
export async function quoteRead(quoteCompositeNumber, param = 'QuoteTables') {
  const r = await callidusScript('Q_API_GetQuoteData', {
    Param: param,
    QuoteCompositeNumber: quoteCompositeNumber,
  });
  return r;
}

/** All quotes under an opportunity. */
export async function oppListQuotes(oppId, mainOnly = false) {
  const r = await callidusScript('GetOpportunityQuotes', {
    OpportunityIds: [String(oppId)],
    MainOnly: mainOnly,
  });
  return r.data;
}

/**
 * Query the OData MessagesSet — the same "business rule warnings" list the UI
 * shows on the Deal Review pane. Returns unresolved rule violations for an Opp.
 * type: 'E' (Error, default) | 'W' (Warning) | 'I' (Info).
 *
 * Endpoint discovered via harmony_probe_capture: every UI interaction on a
 * quote triggers this call to refresh the error list.
 */
export async function messagesSet(oppId, type = 'E') {
  const qs = new URLSearchParams();
  qs.set('$filter', `Type eq '${type}'`);
  qs.set('search', String(oppId));
  const url = `${ODATA_ROOT}/MessagesSet?${qs}`;
  const res = await apiFetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`MessagesSet HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const j = await res.json();
  return j?.d?.results ?? j;
}

/** Opportunity metadata + related entities. */
export async function oppRead(oppId, expand = 'PartiesInvolved,Items,Attributes') {
  return odataGet(`Opportunities('${oppId}')`, { $expand: expand });
}

/** Read just an opp's line items (array), from the OData Items navigation. */
export async function oppItems(oppId) {
  const r = await oppRead(oppId, 'Items');
  const items = r?.d?.Items;
  return items?.results ?? (Array.isArray(items) ? items : []);
}

/**
 * Check one or more opportunities for restricted SKUs against the "CLOUD
 * Materials Requiring Approval in Selling" wiki page (A8 = special approval
 * required, attached to the quote; A4 = informational, surfaced with type:'all').
 *
 * A8/A4 do NOT block the material — this is a heads-up + who-to-contact, not a
 * gate. Fully headless: opp Items over OData + the cached wiki list.
 */
export async function a8CheckOpps(oppIds, { type = 'A8', refresh = false } = {}) {
  const { map, meta } = await getA8Map({ refresh });
  return a8Check(oppIds, { map, meta, type, readItems: oppItems });
}

// ── Deals List (the "#harmonyquote-Display" landing page) ───────────────────
// Backed by the Opportunities entity — fully headless (Layer-1 OData), unlike
// the per-quote Cart page. Full reverse-engineering in
// DEALS_LIST_REVERSE_ENGINEERING.md.

/**
 * Resolve an employee by i-number (or name) to their CPQ business-partner id.
 * ⭐ Critical: the Opportunity.OWNER / SALES_TEAM_MEMBER fields store the BP id
 * (e.g. "14782138"), NOT the i-number. Filtering `OWNER eq 'I077894'` returns 0
 * rows. Always resolve first. Returns { PARTNER, NAME, USERID, ADDRESS } or null.
 */
export async function resolveEmployee(query) {
  const j = await odataGet('EmployeeSearch', {
    $top: '10',
    'search-focus': 'PARTNER',
    search: String(query),
    $select: 'NAME,PARTNER,USERID,ADDRESS',
  });
  const rows = j?.d?.results ?? [];
  if (!rows.length) return null;
  // Prefer an exact USERID (i-number) match; else the first hit.
  const q = String(query).toUpperCase();
  return rows.find((r) => (r.USERID || '').toUpperCase() === q) ?? rows[0];
}

// Columns the deals list selects — mirrors the UI's $select (the LineItem set
// plus the fields that power the row icons and the Cart-page bridge).
const DEALS_SELECT = [
  'OPPT_ID', 'ACCOUNT_NAME', 'ACCOUNT', 'GROW_ACCOUNT', 'DEAL_TYPE', 'HARMONY_TYPE',
  'SOURCE', 'REVENUE_TYPE', 'STATUS', 'FORECAST', 'CURR_PHASE', 'EXPECT_END',
  'EXPECTED_VALUE', 'CURRENCY', 'DESCRIPTION', 'OWNER', 'OWNER_NAME',
  'MAINQUOTE', 'CPQ_QUOTE', 'QUOTE_STATUS', 'ORDER_ID', 'ERROR', 'IS_FAVORITE', 'URL',
];

/** Escape a single-quote for an OData string literal (' → ''). */
function odataLiteral(v) { return `'${String(v).replace(/'/g, "''")}'`; }

/** Build one `(FIELD eq 'a' or FIELD eq 'b')` (or bare `FIELD eq 'a'`) clause. */
function orClause(field, values) {
  const list = (Array.isArray(values) ? values : [values]).filter((v) => v != null && v !== '');
  if (!list.length) return null;
  const parts = list.map((v) => `${field} eq ${odataLiteral(v)}`);
  return parts.length === 1 ? parts[0] : `(${parts.join(' or ')})`;
}

/**
 * Query the Deals List (Opportunities) with human-friendly filters.
 *
 * @param {object} f
 * @param {string} [f.owner]        i-number or BP id; resolved to BP automatically.
 * @param {string} [f.salesTeamMember] i-number or BP id; resolved automatically.
 * @param {string|number} [f.quarter] "2027" | "Q3/2027" | "CURR_QTR" | "20270" → QUARTER_ID.
 * @param {string|string[]} [f.origin] "renewal" | "renewal-cloud" | SOURCE code(s).
 * @param {string|string[]} [f.status]  STATUS code(s) (e.g. "E0001"); omit = all.
 * @param {string|string[]} [f.forecast] FORECAST code(s).
 * @param {string|string[]} [f.account]  ACCOUNT id(s).
 * @param {string|string[]} [f.dealType] DEAL_TYPE code(s).
 * @param {string} [f.oppId]        OPPT_ID exact.
 * @param {string} [f.contractId]   ORDER_ID exact.
 * @param {string} [f.search]       free-text (SAP fuzzy) search.
 * @param {string} [f.searchFocus]  defaults 'ACCOUNT'.
 * @param {object} [opts]
 * @param {number} [opts.top=100] page size.
 * @param {number} [opts.skip=0]
 * @param {string} [opts.orderby='EXPECT_END asc']
 * @param {boolean} [opts.decode=true] decode codes → labels + parse dates.
 * @param {boolean} [opts.raw=false] return raw OData rows (no decode).
 * @returns {Promise<{count:number, resolved:object, filter:string, rows:object[]}>}
 */
export async function dealsList(f = {}, opts = {}) {
  const { top = 100, skip = 0, orderby = 'EXPECT_END asc', decode = true, raw = false } = opts;
  const resolved = {};

  // Resolve owner / sales-team-member i-number → BP id when needed.
  async function resolveIfNeeded(val, key) {
    if (!val) return null;
    if (/^\d{6,}$/.test(String(val))) return String(val);  // already a BP id
    const emp = await resolveEmployee(val);
    if (!emp) throw new Error(`Could not resolve ${key} "${val}" to a business partner via EmployeeSearch`);
    resolved[key] = { input: val, PARTNER: emp.PARTNER, NAME: emp.NAME, USERID: emp.USERID };
    return emp.PARTNER;
  }
  const ownerBp = await resolveIfNeeded(f.owner, 'owner');
  const stmBp = await resolveIfNeeded(f.salesTeamMember, 'salesTeamMember');

  // Expand origin convenience keywords → SOURCE code sets.
  let originVals = f.origin;
  if (originVals === 'renewal') originVals = RENEWAL_SOURCE_CODES;
  else if (originVals === 'renewal-cloud') originVals = RENEWAL_SOURCE_CODES_CLOUD;

  const clauses = [
    ownerBp && `OWNER eq ${odataLiteral(ownerBp)}`,
    stmBp && `SALES_TEAM_MEMBER eq ${odataLiteral(stmBp)}`,
    f.quarter != null && `QUARTER_ID eq ${odataLiteral(toQuarterId(f.quarter))}`,
    orClause('STATUS', f.status),
    orClause('FORECAST', f.forecast),
    orClause('SOURCE', originVals),
    orClause('ACCOUNT', f.account),
    orClause('DEAL_TYPE', f.dealType),
    f.oppId && `OPPT_ID eq ${odataLiteral(f.oppId)}`,
    f.contractId && `ORDER_ID eq ${odataLiteral(f.contractId)}`,
  ].filter(Boolean);

  const filter = clauses.join(' and ');
  const common = {
    ...(filter ? { $filter: filter } : {}),
    'search-focus': f.searchFocus || 'ACCOUNT',
    search: f.search || '',
  };

  // $count first (cheap total), then the page.
  const countJson = await odataGet('Opportunities/$count', common);
  const count = typeof countJson === 'number' ? countJson : Number(countJson) || 0;

  const dataJson = await odataGet('Opportunities', {
    ...common,
    $top: String(top),
    $skip: String(skip),
    $orderby: orderby,
    $select: DEALS_SELECT.join(','),
  });
  let rows = dataJson?.d?.results ?? [];
  rows = rows.map((r) => { const { __metadata, ...rest } = r; return rest; });
  if (decode && !raw) rows = rows.map(decodeOppRow);

  return { count, resolved, filter, top, skip, rows };
}

/**
 * Read the Renewal-at-Risk fields for ONE opportunity — HEADLESS (no browser).
 * Uses `Opportunities('id')?$expand=Notes` and decodes the risk picklists +
 * the free-text notes (Renewal Risk Note = Notes TDID 'ZO69'). This is the
 * headless READ counterpart to the renewal-risk skill's Playwright pull.
 *
 * ⚠️ Reading is fully headless; WRITING these fields back is NOT — Layer-1
 * MERGE is gated by full-entity validation, so risk-note writes still go
 * through the skill's UI-form path. See HEADLESS_CAPABILITY_MATRIX.md.
 *
 * @returns {{ opp_id, filled, risk_reasons, risk_reasons_meaningful, note, fields }}
 */
export async function readRiskNotes(oppId) {
  const r = await oppRead(oppId, 'Notes');
  const d = r?.d ?? {};
  const fields = extractRiskFields(d);
  return {
    opp_id: String(oppId),
    account: (d.ACCOUNT_NAME || '').trim(),
    filled: fields._risk_filled,
    risk_reasons: fields.renewal_risk_reasons,
    risk_reasons_meaningful: fields._risk_reasons_meaningful,
    note: fields.renewal_risk_note,
    has_note: fields._has_note,
    fields,
  };
}

/**
 * Batch version — read risk notes for many opps, sequentially (OData is fast,
 * ~1s each; keeps load gentle). Returns per-opp results + a summary of which
 * ones are missing risk qualification.
 */
export async function readRiskNotesBatch(oppIds = []) {
  const results = [];
  for (const id of oppIds) {
    try {
      results.push(await readRiskNotes(id));
    } catch (e) {
      results.push({ opp_id: String(id), error: e.message, filled: null });
    }
  }
  const missing = results.filter((r) => r.filled === false).map((r) => r.opp_id);
  const filled = results.filter((r) => r.filled === true).map((r) => r.opp_id);
  const errored = results.filter((r) => r.filled == null).map((r) => r.opp_id);
  return { total: results.length, filled_count: filled.length, missing_count: missing.length, missing, errored, results };
}


/** Utility: extract a flat map of {Key: Value} from Quote_Container rows. */
export function quoteContainerFlat(quoteReadResp) {
  const rows = quoteReadResp?.data?.QuoteTables?.Quote_Container?.Rows ?? [];
  const out = {};
  for (const r of rows) if (r.Key) out[r.Key] = r.Value;
  return out;
}

/** Fetch the OData service $metadata (EDMX XML). Used for discovering entities, properties, FunctionImports. */
export async function odataMetadata() {
  const url = `${ODATA_ROOT}/$metadata`;
  const res = await apiFetch(url, { headers: { Accept: 'application/xml' } });
  if (!res.ok) throw new Error(`metadata HTTP ${res.status}`);
  return res.text();
}

// ============ Write & action support ============

let cachedCsrf = null;
let cachedCsrfAt = 0;
const CSRF_TTL_MS = 5 * 60_000;   // SAP CSRF tokens are session-scoped, cheap to refetch

/** Fetch a fresh CSRF token from the OData service root. Required for any write. */
export async function fetchCsrf() {
  const now = Date.now();
  if (cachedCsrf && now - cachedCsrfAt < CSRF_TTL_MS) return cachedCsrf;
  const res = await apiFetch(`${ODATA_ROOT}/`, {
    headers: { 'X-CSRF-Token': 'Fetch', 'Accept': 'application/json' },
  });
  const token = res.headers.get('x-csrf-token');
  if (!token || token.toLowerCase() === 'required') throw new Error('Failed to fetch CSRF token');
  cachedCsrf = token; cachedCsrfAt = now;
  return token;
}

/**
 * OData MERGE (partial update) on an entity.
 * NOTE: Harmony's OData validates the FULL entity on any write, so partial
 * updates that touch validation-sensitive fields may fail with business errors
 * (e.g. "No Competitor Involved selected"). For such fields, prefer the
 * appropriate FunctionImport, or fall back to UI automation.
 *
 * Returns { ok, status, body } — status 204 = success (no content).
 * Common business-error responses arrive with HTTP 501 but a JSON body
 * describing the exact rule; we surface that untouched.
 *
 * Uses POST + X-HTTP-Method: MERGE because Cloud Foundry blocks the raw MERGE verb.
 */
export async function odataMerge(path, patch) {
  const csrf = await fetchCsrf();
  const url = `${ODATA_ROOT}/${path}`;
  const res = await apiFetch(url, {
    method: 'POST',
    headers: {
      'X-CSRF-Token': csrf,
      'X-HTTP-Method': 'MERGE',
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'If-Match': '*',
    },
    body: JSON.stringify(patch),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { _raw: text }; }
  return { ok: res.ok, status: res.status, body };
}

/**
 * OData create-style POST to a collection with a FULL entity body.
 *
 * This is how Harmony's UI actually persists Opportunity edits (verified by
 * network capture 2026-07-11): a plain POST to /Opportunities carrying the
 * whole entity, NOT a MERGE. The MERGE handler (`OPPORTUNITIES_UPDATE_ENTITY`)
 * is not implemented server-side, but the collection POST handler is, and it
 * runs full-entity validation and upserts by key (OPPT_ID). Use this for
 * field edits (e.g. CHANGE_FLAGS.NO_COMP_INV) that MERGE rejects.
 *
 * `entity` must be a clean entity object (no __metadata / __deferred / nav
 * properties). Returns { ok, status, body }; 201 = success.
 */
export async function odataCreate(collection, entity) {
  const csrf = await fetchCsrf();
  const url = `${ODATA_ROOT}/${collection}`;
  const res = await apiFetch(url, {
    method: 'POST',
    headers: {
      'X-CSRF-Token': csrf,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(entity),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { _raw: text }; }
  return { ok: res.ok, status: res.status, body };
}

/**
 * Read an Opportunity and return a clean entity object (no __metadata, no
 * __deferred navigation properties, nested complex types cleaned) suitable for
 * POSTing back via odataCreate.
 */
async function readCleanOppEntity(oppId) {
  const read = await odataGet(`Opportunities('${oppId}')`);
  const d = read?.d;
  if (!d) return null;
  const entity = {};
  for (const [k, v] of Object.entries(d)) {
    if (k === '__metadata') continue;
    if (v && typeof v === 'object' && v.__deferred) continue;     // nav property
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = {};
      for (const [ik, iv] of Object.entries(v)) {
        if (ik === '__metadata') continue;
        if (iv && typeof iv === 'object' && iv.__deferred) continue;
        inner[ik] = iv;
      }
      entity[k] = inner;
    } else {
      entity[k] = v;
    }
  }
  return entity;
}

/**
 * Apply `mutate(entity)` to a clean copy of the opp, POST it back (the UI's
 * persist path), and report whether the whole opp's ERROR field cleared.
 * `echoKeys` are extra top-level fields to surface from the server echo.
 */
async function patchOpportunity(oppId, mutate, echoKeys = []) {
  const entity = await readCleanOppEntity(oppId);
  if (!entity) return { ok: false, status: 0, error: 'could not read opportunity' };
  mutate(entity);
  const res = await odataCreate('Opportunities', entity);
  const echo = res.body?.d;
  const out = {
    ok: res.ok,
    status: res.status,
    errorCleared: echo ? echo.ERROR === '' : null,
    body: res.ok ? undefined : res.body,   // only surface body on failure
  };
  for (const k of echoKeys) out[k] = echo ? echo[k] : null;
  return out;
}

export async function setNoCompetitor(oppId) {
  // Verified by capture: top-level NO_COMP_INV holds the option CODE
  // ("4" = "No Competitor Involved/not known"); CHANGE_FLAGS.NO_COMP_INV holds
  // the "X" dirty-flag so the backend knows this field changed.
  return patchOpportunity(oppId, (e) => {
    e.NO_COMP_INV = '4';
    e.CHANGE_FLAGS = { ...(e.CHANGE_FLAGS || {}), NO_COMP_INV: 'X' };
  }, ['NO_COMP_INV']);
}

/**
 * Clear the "add an Engaged SI or mark No Engaged SI" error (ZHARMONY/088) by
 * setting the "No Engaged SI" flag. Verified by field comparison: opps without
 * this error have NO_ENGAGED_PARTNER='X'; opps with it have ''. Uses the same
 * POST path. Returns { ok, status, errorCleared, noEngagedPartner }.
 */
export async function setNoEngagedSI(oppId) {
  return patchOpportunity(oppId, (e) => {
    e.NO_ENGAGED_PARTNER = 'X';
  }, ['NO_ENGAGED_PARTNER']);
}

/**
 * Fields that change on every full-entity POST regardless of what we edited
 * (server-stamped timestamps / session handles). Excluded from the change
 * diff so setOppDescription can assert nothing *unexpected* changed. Start
 * conservative; widen only from empirically-observed noise (see the skill's
 * single-live-write verification). Top-level only — CHANGE_FLAGS is handled
 * separately (it is always expected to change).
 */
const OPP_WRITE_NOISE_FIELDS = new Set([
  'CHANGED_AT', 'LAST_UPDATED_ON', 'STATUS_SINCE', 'TIME_STAMP', 'SESSION_GUID',
  // DATA_CENTER is server-derived and wobbles on a full-entity POST for
  // ZRE-type (Active Renewal) opps — observed 2026-07-11 on 305597474-batch
  // opp 306015814 (before/after both effectively empty; DESCRIPTION landed
  // correctly). Not a real edit, so it's noise, not an unexpected change.
  'DATA_CENTER',
]);

/** Top-level fields that changed between two clean opp entities. Scalars are
 *  compared with empty-value normalization ('' and null/undefined treated as
 *  equal) so a backend '' <-> null round-trip does not read as a spurious change
 *  and false-block a batch. Nested objects are compared by a stable JSON
 *  serialization (except CHANGE_FLAGS, always expected to move and allowed by the
 *  caller) so a silent nested-block mutation cannot slip past the guard as an
 *  empty `changed` list. */
function changedTopLevelFields(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const norm = (x) => (x == null ? '' : x);
  const changed = [];
  for (const k of keys) {
    if (k === 'CHANGE_FLAGS') continue; // always expected to move; allowed separately
    const bv = before?.[k];
    const av = after?.[k];
    if ((bv && typeof bv === 'object') || (av && typeof av === 'object')) {
      // Compare nested blocks by serialization rather than skipping them, so an
      // unexpected mutation inside a nested object is not invisible to the guard.
      if (JSON.stringify(bv ?? null) !== JSON.stringify(av ?? null)) changed.push(k);
      continue;
    }
    if (norm(bv) !== norm(av)) changed.push(k);
  }
  return changed;
}

/**
 * Set an opportunity's DESCRIPTION headlessly via the UI's persist path
 * (full-entity POST — MERGE is not implemented for opps). Self-guards: reads
 * the opp before and after, and reports every top-level field that changed so
 * the caller can refuse if anything beyond DESCRIPTION/ERROR moved.
 *
 * Verified live 2026-07-11 on opp 305597474 ("津村PE" → "#MXBOM #CERP Tsumura
 * Q4-27"): the POST changed ONLY DESCRIPTION; the sole volatile field was
 * CHANGED_AT (already in OPP_WRITE_NOISE_FIELDS). ERROR was pre-existing 'X'
 * and stayed untouched.
 *
 * Returns { ok, status, unchanged?, DESCRIPTION, expected, changedFields,
 * unexpectedChanges, errorField }. `ok` is true only when the POST succeeded,
 * DESCRIPTION now equals the requested text, AND no unexpected field changed.
 * A non-empty `unexpectedChanges` forces ok:false — treat it as "do not
 * proceed" and stop any batch.
 */
export async function setOppDescription(oppId, text) {
  const before = await readCleanOppEntity(oppId);
  if (!before) return { ok: false, status: 0, error: 'could not read opportunity' };

  const oldText = before.DESCRIPTION ?? '';
  if (oldText === text) {
    return {
      ok: true, status: 200, unchanged: true,
      DESCRIPTION: oldText, expected: text,
      changedFields: [], unexpectedChanges: [], errorField: before.ERROR ?? '',
    };
  }

  const res = await patchOpportunity(oppId, (e) => {
    e.DESCRIPTION = text;
    e.CHANGE_FLAGS = { ...(e.CHANGE_FLAGS || {}), DESCRIPTION: 'X' };
  }, ['DESCRIPTION']);

  const after = await readCleanOppEntity(oppId);
  const changedFields = after
    ? changedTopLevelFields(before, after).filter((f) => !OPP_WRITE_NOISE_FIELDS.has(f))
    : [];
  // DESCRIPTION is the only field we intend to move. ERROR is tolerated ONLY when
  // it did not get worse — a clean -> 'X' transition means the write newly broke a
  // business rule and must stop the batch, so it counts as unexpected. A cleared or
  // unchanged ERROR is fine.
  const errorWorsened = !!after && (before.ERROR ?? '') !== 'X' && (after.ERROR ?? '') === 'X';
  const ALLOWED = new Set(errorWorsened ? ['DESCRIPTION'] : ['DESCRIPTION', 'ERROR']);
  const unexpectedChanges = changedFields.filter((f) => !ALLOWED.has(f));

  const wrote = !!after && (after.DESCRIPTION ?? '') === text;
  return {
    ok: res.ok && wrote && unexpectedChanges.length === 0,
    status: res.status,
    DESCRIPTION: after ? after.DESCRIPTION : null,
    expected: text,
    changedFields,
    unexpectedChanges,
    errorField: after ? after.ERROR : null,
    body: res.ok && wrote && unexpectedChanges.length === 0 ? undefined : res.body,
  };
}

// ── Renewal-at-Risk write path (headless) ───────────────────────────────────
//
// Writes the two EDITABLE code fields on the "Risk Qualification" tab:
//   renewalRisk      → top-level RENEWAL_RISK        (Renewal Risk Reasons picklist)
//   renewBusScenario → top-level RENEW_BUS_SCENARIO  (Business Scenario dropdown)
//
// NOT written here (deliberate): RISK_CATEGORY is non-editable in the UI (it is
// derived from Reasons/Scenario), and the three free-text fields live in the
// Notes sub-entity (a separate CRM-text write path). See the RISK QUALIFICATION
// panel layout + deals-maps.mjs.
//
// ⚠️ Open question this tool exists to answer: unlike DESCRIPTION / NO_COMP_INV,
// these fields have NO entry in the CHANGE_FLAGS dirty-flag map (they are
// "Tier-B"). setOppDescription lands because it also sets CHANGE_FLAGS.<field>=
// "X" to tell the backend the field is dirty.
//
// VERIFIED LIVE 2026-07-12 (controlled write on opp 303833283): a Tier-B field
// (RENEW_BUS_SCENARIO) PERSISTS via full-entity POST WITHOUT any CHANGE_FLAGS
// entry — so these fields do NOT need a dirty-flag. The tool therefore sets the
// value only and sets no flag. The read-back still decides truth:
//   read-back == expected  → wrote (the normal case).                    ✅
//   read-back == old value → SILENT NO-OP; report silentNoOp:true,
//                            ok:false, never lie.                        ❌
//
// The same live test also exposed a sharper hazard: the opp was Lost (STATUS
// E0005, IS_EDITABLE=false), yet the headless POST still mutated it — bypassing
// the UI edit-lock that would have stopped a human. So setRenewalRisk GATES on
// IS_EDITABLE before any POST (see below): only In-Process opps are writable.
//
// The most dangerous failure mode is HTTP 201 + value-unchanged. We therefore
// re-read and assert the value LANDED — status alone is never treated as success.
// This is the same self-diff contract setOppDescription already gets right.

// The only fields this tool is allowed to write. Anything else is rejected so
// this never becomes a general opp-write primitive (privilege minimization).
const RISK_WRITE_FIELDS = new Set(['RENEWAL_RISK', 'RENEW_BUS_SCENARIO', 'REVENUE_RETENTION']);

/**
 * Pure validator for a renewal-risk write request. Network-free so the
 * whitelist / code-table policy is testable without touching OData (mirrors
 * classifyFunctionImport). Maps the caller's friendly keys to top-level opp
 * fields, rejecting unknown keys, empty values, and out-of-vocabulary Business
 * Scenario codes.
 *
 * @param {{renewalRisk?: string, renewBusScenario?: string|number, riskRetentionLever?: string}} patch
 * @returns {{ok: boolean, reason?: string, edits?: Record<string,string>}}
 *   `edits` maps top-level FIELD → string value to POST.
 */
export function validateRiskWrite(patch = {}) {
  // riskRetentionLever → REVENUE_RETENTION: the "Risk Retention Lever" UI dropdown
  // is backed by the top-level REVENUE_RETENTION field (SAP's OData label is the
  // legacy "Revenue Retention Initiative"). Verified live 2026-07-12 by 2-point
  // value correlation (NON↔None on 305902919, CMI↔Commercial Mitigation on
  // 304315010) + a controlled Tier-B write (NON→CMI→NON): it persists via
  // full-entity POST with no CHANGE_FLAGS entry, no *_DESC sibling.
  const map = {
    renewalRisk: 'RENEWAL_RISK',
    renewBusScenario: 'RENEW_BUS_SCENARIO',
    riskRetentionLever: 'REVENUE_RETENTION',
  };
  const edits = {};
  for (const [key, value] of Object.entries(patch)) {
    const field = map[key];
    if (!field) return { ok: false, reason: `unknown field "${key}" — only ${Object.keys(map).join(', ')} are writable` };
    if (!RISK_WRITE_FIELDS.has(field)) return { ok: false, reason: `field "${field}" is not writable` };
    if (value == null || String(value).trim() === '') {
      return { ok: false, reason: `"${key}" must be a non-empty code (got ${JSON.stringify(value)})` };
    }
    const v = String(value).trim();
    // NOTE: we deliberately do NOT validate RENEW_BUS_SCENARIO against the
    // BUSINESS_SCENARIO code table — that table is reverse-engineered and
    // incomplete (e.g. code 11 is live in production data but absent from it),
    // so a table check would false-reject legitimate values. Both fields are
    // therefore accepted as any non-empty scalar; the read-back is the real
    // guard against a bad code (it simply won't land). deals-maps.mjs is still
    // used to DECODE codes into labels for reads.
    edits[field] = v;
  }
  if (Object.keys(edits).length === 0) {
    return { ok: false, reason: 'nothing to write — provide renewalRisk, renewBusScenario, and/or riskRetentionLever' };
  }
  return { ok: true, edits };
}

/**
 * Set the two editable Renewal-at-Risk CODE fields (RENEWAL_RISK,
 * RENEW_BUS_SCENARIO) headlessly via the UI's persist path (full-entity POST —
 * MERGE is not implemented for opps). Same self-diff contract as
 * setOppDescription: read before → POST → read after → assert the target fields
 * LANDED and nothing unexpected moved.
 *
 * First version sets field VALUES only and sets NO CHANGE_FLAGS entry (these are
 * Tier-B fields with no known flag). The read-back is the source of truth:
 *   - target read-back == expected           → ok:true (Tier-B needs no flag).
 *   - target read-back == old value (201'd)   → silentNoOp:true, ok:false. This
 *     is the "HTTP 201 but value unchanged" trap; we NEVER report it as success.
 *
 * @param {string} oppId
 * @param {{renewalRisk?: string, renewBusScenario?: string|number}} patch
 * @returns {{ ok, status, unchanged?, silentNoOp?, expected, actual,
 *   changedFields, unexpectedChanges, errorField, reason? }}
 *   `ok` is true ONLY when the POST succeeded, every target field now equals its
 *   expected code, AND no unexpected top-level field changed. A non-empty
 *   `unexpectedChanges`, or `silentNoOp:true`, forces ok:false — treat as "do
 *   not proceed" and stop any batch.
 */
export async function setRenewalRisk(oppId, patch = {}) {
  const v = validateRiskWrite(patch);
  if (!v.ok) return { ok: false, status: 0, reason: v.reason };
  const edits = v.edits;                          // { FIELD: 'code', ... }
  const targets = Object.keys(edits);

  const before = await readCleanOppEntity(oppId);
  if (!before) return { ok: false, status: 0, reason: 'could not read opportunity' };

  // Editability gate — refuse to write unless the opp is editable. Only an
  // In-Process opp accepts these edits; Discontinued / Lost / Booked opps do
  // not. The headless full-entity POST path can otherwise BYPASS the UI's edit
  // lock and silently mutate a closed opp — proven live 2026-07-12 on Lost opp
  // 303833283 (STATUS E0005), where a 2→15 write persisted despite
  // IS_EDITABLE=false, and the reverse then silent-no-op'd. So we gate here,
  // before any POST, rather than trusting the backend to reject it.
  if (before.IS_EDITABLE === false) {
    return {
      ok: false, status: 0,
      reason: `opportunity is not editable (IS_EDITABLE=false, STATUS=${before.STATUS ?? '?'}) — only In-Process opps accept renewal-risk edits; refusing to write`,
      expected: edits,
      actual: Object.fromEntries(targets.map((f) => [f, before[f] ?? ''])),
    };
  }

  // Same-value probe: if every target already equals the expected code, this is
  // a no-op with zero business impact (the same-value probe path). Report it as
  // unchanged rather than firing a needless write.
  const norm = (x) => (x == null ? '' : String(x));
  const allAlreadySet = targets.every((f) => norm(before[f]) === norm(edits[f]));
  if (allAlreadySet) {
    return {
      ok: true, status: 200, unchanged: true,
      expected: edits,
      actual: Object.fromEntries(targets.map((f) => [f, before[f] ?? ''])),
      changedFields: [], unexpectedChanges: [], errorField: before.ERROR ?? '',
    };
  }

  // First version: set field values ONLY. Do NOT touch CHANGE_FLAGS — we don't
  // know the flag name these Tier-B fields need (if any), and guessing would
  // confound the read-back verdict. The read-back decides whether a flag is
  // required (see silentNoOp below).
  const res = await patchOpportunity(oppId, (e) => {
    for (const [field, value] of Object.entries(edits)) e[field] = value;
  }, targets);

  const after = await readCleanOppEntity(oppId);
  const changedFields = after
    ? changedTopLevelFields(before, after).filter((f) => !OPP_WRITE_NOISE_FIELDS.has(f))
    : [];

  // Fields we intend to (or expect the backend to) move:
  //   - the target code fields we wrote
  //   - RENEWAL_RISK_DESC: server-derived label for RENEWAL_RISK
  //   - RISK_CATEGORY (+ its label): non-editable, DERIVED from Reasons/Scenario,
  //     so a backend-driven change here is an expected side effect, not a rogue edit
  //   - ERROR: tolerated only when it did not newly break (clean → 'X' is unexpected)
  const errorWorsened = !!after && (before.ERROR ?? '') !== 'X' && (after.ERROR ?? '') === 'X';
  const ALLOWED = new Set([
    ...targets,
    'RENEWAL_RISK_DESC', 'RISK_CATEGORY', 'RISK_CATEGORY_DESC',
    ...(errorWorsened ? [] : ['ERROR']),
  ]);
  const unexpectedChanges = changedFields.filter((f) => !ALLOWED.has(f));

  // Did every target code actually land? This is the anti-silent-failure gate.
  const actual = Object.fromEntries(targets.map((f) => [f, after ? (after[f] ?? '') : null]));
  const allLanded = !!after && targets.every((f) => norm(after[f]) === norm(edits[f]));
  const silentNoOp = res.ok && !allLanded;        // 201'd but value didn't change

  const ok = res.ok && allLanded && unexpectedChanges.length === 0;
  return {
    ok,
    status: res.status,
    ...(silentNoOp ? { silentNoOp: true } : {}),
    expected: edits,
    actual,
    changedFields,
    unexpectedChanges,
    errorField: after ? after.ERROR : null,
    ...(silentNoOp ? { reason: 'HTTP 201 but target field(s) did not change — the backend accepted the POST without persisting the edit (e.g. opp not in an editable state). Write did NOT land.' } : {}),
    body: ok ? undefined : res.body,
  };
}

// ── Renewal-at-Risk FREE-TEXT write path (headless deep-insert) ─────────────
//
// Writes the three EDITABLE free-text boxes on the "Risk Qualification" tab.
// Unlike the code fields (top-level scalars), these live in the Notes
// sub-entity, keyed by TDID. Verified mapping (live 2026-07-12 on opp
// 305902919, confirmed against the UI):
//   renewalRiskNote  → TDID ZO69  (Renewal Risk Note)
//   executiveSummary → TDID ZRE5  (Executive Summary / Engagement Actions)
//   supportNeeded    → TDID ZO92  (Support Needed)
//
// NOT written here (deliberate): ZRE4 (Renewal Close Plan Updates) and ZOLG
// (Opportunity Comments — a system-appended timestamped log). Neither is in the
// friendly-key map, so a caller cannot reach them.
//
// Write mechanism: full-entity POST /Opportunities with the Notes navigation
// property carried back as a deep-insert array (readCleanOppEntity DROPS Notes
// because it's a __deferred nav prop, so we clean the entity ourselves here and
// keep Notes). Verified: the target note's CONC_LINES persists (HTTP 201 +
// read-back match), other content notes are untouched.
//
// ⚠️ ZOLG side effect: every deep-insert POST makes the backend AUTO-APPEND a
// new timestamped Opportunity Comments entry to ZOLG (it grows monotonically).
// This is backend behaviour, not our edit — analogous to CHANGED_AT noise on
// the top-level write path — so ZOLG is treated as expected noise in the diff,
// never an unexpectedChange.

// TDID of each writable free-text box. The friendly key → TDID map is the write
// whitelist; anything not here is rejected so this never becomes a general
// note-write primitive (privilege minimization). ZRE4/ZOLG are absent by design.
const RISK_NOTE_TDID = {
  renewalRiskNote:   'ZO69',   // Renewal Risk Note / Internal Roadblocks
  executiveSummary:  'ZRE5',   // Renewal Close Plan (CRE + AO/AE)
  supportNeeded:     'ZO92',   // Support Needed
  obvValidated:      'ZRE1',   // OBV Validated (scrubbing note)
  gtcDeviations:     'ZRE3',   // GTC Deviations
  redlines:          'ZREE',   // Redlines (copy of GTC Deviations)
  perAnnumLanguage:  'ZRE6',   // Per Annum Language note
  upliftRemarks:     'ZRE8',   // Uplift % Remarks
};

// Notes the backend mutates on every deep-insert regardless of what we edited.
// ZOLG is auto-appended (timestamped Opportunity Comments) on each POST, so it
// is expected noise, never an unexpected change (mirrors OPP_WRITE_NOISE_FIELDS
// for the top-level path).
const NOTE_WRITE_NOISE_TDIDS = new Set(['ZOLG']);

/**
 * Pure validator for a risk-notes write request. Network-free so the whitelist
 * policy is testable without touching OData (mirrors validateRiskWrite). Maps
 * the caller's friendly keys to Notes TDIDs, rejecting unknown keys, empty /
 * whitespace-only values, and an empty patch.
 *
 * Unlike the code validator, note values are NOT trimmed — a note is free text,
 * so interior and edge whitespace is meaningful. Only a whitespace-only value is
 * rejected (there's nothing to write).
 *
 * @param {{renewalRiskNote?: string, executiveSummary?: string, supportNeeded?: string}} patch
 * @returns {{ok: boolean, reason?: string, edits?: Record<string,string>}}
 *   `edits` maps TDID → free-text value to write.
 */
export function validateRiskNotesWrite(patch = {}) {
  const edits = {};
  for (const [key, value] of Object.entries(patch)) {
    const tdid = RISK_NOTE_TDID[key];
    if (!tdid) return { ok: false, reason: `unknown field "${key}" — only ${Object.keys(RISK_NOTE_TDID).join(', ')} are writable` };
    if (value == null || String(value).trim() === '') {
      return { ok: false, reason: `"${key}" must be a non-empty note (got ${JSON.stringify(value)})` };
    }
    // Preserve the value verbatim — free text, no trim.
    edits[tdid] = String(value);
  }
  if (Object.keys(edits).length === 0) {
    return { ok: false, reason: 'nothing to write — provide renewalRiskNote, executiveSummary, and/or supportNeeded' };
  }
  return { ok: true, edits };
}

/**
 * Derive the CRM text-object key (OBJECT_ID / TDNAME / TDOBJECT / TDSPRAS) for a
 * brand-new note row from the opportunity entity's own top-level fields.
 *
 * Verified against live opps (2026-07-31): OBJECT_ID = OPPT_ID, TDNAME = GUID
 * (hyphens removed, uppercased), TDOBJECT = "CRM_ORDERH", TDSPRAS = "EN". The
 * EDMX ReferentialConstraint confirms the OPPT_ID → OBJECT_ID mapping.
 *
 * Returns null if the entity is missing OPPT_ID or GUID (refuse to derive from
 * incomplete data — the caller should fail closed with a descriptive reason).
 *
 * @param {object} entity - cleaned opp entity (from readOppEntityWithNotes)
 * @returns {{ OBJECT_ID: string, TDNAME: string, TDOBJECT: string, TDSPRAS: string } | null}
 */
export function deriveNoteMetadata(entity) {
  const oppId = entity?.OPPT_ID;
  const guid = entity?.GUID;
  if (!oppId || !guid) return null;
  return {
    OBJECT_ID: String(oppId),
    TDNAME: String(guid).replace(/-/g, '').toUpperCase(),
    TDOBJECT: 'CRM_ORDERH',
    TDSPRAS: 'EN',
  };
}

/**
 * Read an Opportunity with $expand=Notes and return a clean entity that KEEPS
 * the Notes array (as clean note objects) for deep-insert. readCleanOppEntity
 * drops Notes (it's a __deferred nav prop); this variant is used only by the
 * notes writer, which must carry Notes back in the POST.
 *
 * @returns {{ entity: object, notes: object[] } | null}
 */
async function readOppEntityWithNotes(oppId) {
  const read = await oppRead(oppId, 'Notes');
  const d = read?.d;
  if (!d) return null;
  const entity = {};
  for (const [k, v] of Object.entries(d)) {
    if (k === '__metadata') continue;
    if (k === 'Notes') continue;                                 // handled below
    if (v && typeof v === 'object' && v.__deferred) continue;    // nav property
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = {};
      for (const [ik, iv] of Object.entries(v)) {
        if (ik === '__metadata') continue;
        if (iv && typeof iv === 'object' && iv.__deferred) continue;
        inner[ik] = iv;
      }
      entity[k] = inner;
    } else {
      entity[k] = v;
    }
  }
  const notes = (d.Notes?.results ?? []).map((n) => {
    const c = {};
    for (const [k, v] of Object.entries(n)) { if (k !== '__metadata') c[k] = v; }
    return c;
  });
  return { entity, notes };
}

/** Map a Notes array to { TDID: CONC_LINES } for diffing/read-back. */
function notesByTdid(notes) {
  const m = {};
  for (const n of notes ?? []) m[n.TDID] = n.CONC_LINES ?? '';
  return m;
}

/**
 * Set the three editable Renewal-at-Risk FREE-TEXT boxes (Notes ZO69 / ZRE5 /
 * ZO92) headlessly via a full-entity deep-insert POST. Same self-diff contract
 * as setRenewalRisk: read before → POST → read after → assert the target notes
 * LANDED and nothing unexpected moved.
 *
 * For a target TDID with no existing note row (a box never filled before), a new
 * row is created carrying the shared note metadata copied from a sibling note
 * (OBJECT_ID / TDNAME / TDOBJECT / TDSPRAS), falling back to values derived from
 * the opp's own OPPT_ID and GUID when there are no siblings (see
 * deriveNoteMetadata).
 *
 * @param {string} oppId
 * @param {{renewalRiskNote?: string, executiveSummary?: string, supportNeeded?: string}} patch
 * @returns {{ ok, status, unchanged?, silentNoOp?, verifyFailed?, expected,
 *   actual, changedNotes, unexpectedChanges, errorField, reason? }}
 *   `ok` is true ONLY when the POST succeeded, every target note now equals its
 *   expected text, AND no unexpected note/field changed (ZOLG is expected
 *   noise). A non-empty `unexpectedChanges`, `silentNoOp:true`, or
 *   `verifyFailed:true` forces ok:false. `silentNoOp` = read-back confirmed the
 *   value did not change; `verifyFailed` = read-back itself failed so
 *   persistence is UNVERIFIED (do not blindly retry). Either way: do not proceed
 *   and stop any batch.
 */
export async function setRiskNotes(oppId, patch = {}) {
  const v = validateRiskNotesWrite(patch);
  if (!v.ok) return { ok: false, status: 0, reason: v.reason };
  const edits = v.edits;                          // { TDID: 'text', ... }
  const targets = Object.keys(edits);

  const first = await readOppEntityWithNotes(oppId);
  if (!first) return { ok: false, status: 0, reason: 'could not read opportunity' };
  const before = first.entity;
  const beforeNotes = notesByTdid(first.notes);

  // Duplicate-TDID guard — scoped to the TDIDs that actually participate in the
  // self-diff. The diff (notesByTdid / find-by-TDID / read-back) assumes each
  // DIFFED TDID appears at most once. Noise TDIDs are exempt: ZOLG is a
  // backend-managed append-only log that legitimately has many rows sharing
  // (TDID, OBJECT_ID, TDSPRAS) — observed 2+ rows on a normal opp — and it is
  // excluded from the diff anyway, so its duplication is irrelevant. Only a
  // duplicate CONTENT TDID (ZO69/ZRE4/ZRE5/ZO92) could hide a shadowed-row edit
  // from the diff, so refuse only on that.
  const seenTdids = new Set();
  for (const n of first.notes) {
    if (NOTE_WRITE_NOISE_TDIDS.has(n.TDID)) continue;   // ZOLG etc. — append-only, diff-exempt
    if (seenTdids.has(n.TDID)) {
      return {
        ok: false, status: 0,
        reason: `opportunity has multiple Notes rows sharing content TDID "${n.TDID}"; the note self-diff assumes unique content TDIDs, refusing to write`,
      };
    }
    seenTdids.add(n.TDID);
  }

  // Editability gate — refuse to write unless the opp is editable. The headless
  // deep-insert POST goes through the same /Opportunities path that BYPASSES the
  // UI edit-lock (proven on Lost opp 303833283), so we gate here before any POST.
  if (before.IS_EDITABLE === false) {
    return {
      ok: false, status: 0,
      reason: `opportunity is not editable (IS_EDITABLE=false, STATUS=${before.STATUS ?? '?'}) — only In-Process opps accept renewal-risk edits; refusing to write`,
      expected: edits,
      actual: Object.fromEntries(targets.map((t) => [t, beforeNotes[t] ?? ''])),
    };
  }

  // Same-value probe: if every target note already equals the expected text,
  // this is a no-op with zero business impact. Report unchanged, fire no POST.
  const allAlreadySet = targets.every((t) => (beforeNotes[t] ?? '') === edits[t]);
  if (allAlreadySet) {
    return {
      ok: true, status: 200, unchanged: true,
      expected: edits,
      actual: Object.fromEntries(targets.map((t) => [t, beforeNotes[t] ?? ''])),
      changedNotes: [], unexpectedChanges: [], errorField: before.ERROR ?? '',
    };
  }

  // Build the deep-insert payload: mutate/create the target note rows, carry the
  // whole Notes array back as the nav property. Carrying every existing row
  // (including ZOLG) verbatim is the shape verified live (row count round-trips
  // constant → backend upserts by TDID, does not append duplicates).
  const notes = first.notes.map((n) => ({ ...n }));
  // Pick sibling metadata from a CONTENT note, never a noise/append-log row, so
  // a new row's text-object key is copied from a stable per-opp note.
  const sibling = notes.find((n) => !NOTE_WRITE_NOISE_TDIDS.has(n.TDID)) ?? notes[0];
  for (const [tdid, text] of Object.entries(edits)) {
    const row = notes.find((n) => n.TDID === tdid);
    if (row) {
      row.CONC_LINES = text;
    } else if (sibling) {
      // Create a new note row, copying the text-object key metadata from an
      // existing sibling (all notes on one opp share OBJECT_ID/TDNAME/TDOBJECT/
      // TDSPRAS — the CRM text-object key that ties them to this opp header).
      notes.push({
        TDID: tdid,
        CONC_LINES: text,
        OBJECT_ID: sibling.OBJECT_ID,
        TDNAME: sibling.TDNAME,
        TDOBJECT: sibling.TDOBJECT,
        TDSPRAS: sibling.TDSPRAS,
      });
    } else {
      // No sibling note to copy from — derive the text-object key from the opp's
      // own top-level fields (OPPT_ID → OBJECT_ID, GUID → TDNAME). The read-back-
      // verify after the POST catches any derivation error, so this is safe.
      const derived = deriveNoteMetadata(before);
      if (!derived) {
        return {
          ok: false, status: 0,
          reason: `cannot create the first note — the opp entity is missing OPPT_ID or GUID (needed to derive the text-object key)`,
          expected: edits,
          actual: Object.fromEntries(targets.map((t) => [t, beforeNotes[t] ?? ''])),
        };
      }
      notes.push({ TDID: tdid, CONC_LINES: text, ...derived });
    }
  }
  const payload = { ...before, Notes: notes };
  const res = await odataCreate('Opportunities', payload);

  // Read back and diff.
  const second = await readOppEntityWithNotes(oppId);
  const after = second ? second.entity : null;
  const afterNotes = second ? notesByTdid(second.notes) : {};

  // Physical row-count guard, over CONTENT rows only. notesByTdid keys by TDID,
  // so if the backend ever APPENDED our carried-back rows instead of upserting by
  // key, duplicate content rows would collapse in the map and be invisible to the
  // content diff below. Count the raw non-noise rows: after = before + (new target
  // rows we added). Noise TDIDs (ZOLG) are EXCLUDED — the backend auto-appends a
  // fresh ZOLG entry on every POST, so total row count legitimately grows; only
  // the content-row count must round-trip exactly. (Observed upsert-by-TDID for
  // content rows in practice, so this should not fire.)
  const contentRows = (arr) => arr.filter((n) => !NOTE_WRITE_NOISE_TDIDS.has(n.TDID)).length;
  const newRowCount = targets.filter((t) => !(t in beforeNotes)).length;
  const expectedAfterContentRows = contentRows(first.notes) + newRowCount;
  const rowCountMismatch = !!second && contentRows(second.notes) !== expectedAfterContentRows;

  // Notes whose text changed, excluding the ZOLG auto-append noise.
  const allTdids = new Set([...Object.keys(beforeNotes), ...Object.keys(afterNotes)]);
  const changedNotes = [...allTdids]
    .filter((t) => (beforeNotes[t] ?? '') !== (afterNotes[t] ?? ''))
    .filter((t) => !NOTE_WRITE_NOISE_TDIDS.has(t));

  // Top-level fields must not move (this path only edits Notes). ERROR is
  // tolerated only when it did not newly break.
  const errorWorsened = !!after && (before.ERROR ?? '') !== 'X' && (after.ERROR ?? '') === 'X';
  const topChanged = after
    ? changedTopLevelFields(before, after).filter((f) => !OPP_WRITE_NOISE_FIELDS.has(f))
    : [];
  const ALLOWED_TOP = new Set(errorWorsened ? [] : ['ERROR']);
  const unexpectedTop = topChanged.filter((f) => !ALLOWED_TOP.has(f));

  // A changed note that isn't one of our targets is unexpected (a rogue edit of
  // another content note like ZO69/ZRE4). Targets are expected to change.
  const unexpectedNotes = changedNotes.filter((t) => !targets.includes(t));
  const unexpectedChanges = [
    ...unexpectedNotes,
    ...unexpectedTop,
    ...(rowCountMismatch ? ['__note_row_count'] : []),
  ];

  // Did every target note actually land? Anti-silent-failure gate.
  const actual = Object.fromEntries(targets.map((t) => [t, second ? (afterNotes[t] ?? '') : null]));
  const allLanded = !!second && targets.every((t) => (afterNotes[t] ?? '') === edits[t]);
  // Two distinct failure shapes, NOT conflated:
  //  - read-back failed (second===null): persistence is UNVERIFIED — the write
  //    may well have landed. Do NOT tell the caller it didn't (a blind retry
  //    would re-POST). Surfaced as verifyFailed with an explicit "unknown" reason.
  //  - read-back succeeded but value unchanged: a true silent no-op.
  const verifyFailed = res.ok && !second;
  const silentNoOp = res.ok && !!second && !allLanded;

  const ok = res.ok && allLanded && unexpectedChanges.length === 0;
  const reason = verifyFailed
    ? 'POST returned 201 but the read-back failed — persistence is UNVERIFIED; inspect the opp manually before retrying (a blind retry would re-POST).'
    : silentNoOp
      ? 'HTTP 201 but target note(s) did not change on read-back — the backend accepted the POST without persisting the note (e.g. opp not in an editable state). Write did NOT land.'
      : rowCountMismatch
        ? `content note row count changed unexpectedly (expected ${expectedAfterContentRows}, got ${second ? contentRows(second.notes) : 'n/a'}) — the deep-insert may have duplicated rows; treat as not-ok`
        : undefined;
  return {
    ok,
    status: res.status,
    ...(verifyFailed ? { verifyFailed: true } : {}),
    ...(silentNoOp ? { silentNoOp: true } : {}),
    expected: edits,
    actual,
    changedNotes,
    unexpectedChanges,
    errorField: after ? after.ERROR : null,
    ...(reason ? { reason } : {}),
    body: ok ? undefined : res.body,
  };
}

// ── RenewalExecution write path (headless deep-insert via Opportunities POST) ─
//
// RenewalExecutionSet MERGE returns 204 but silently no-ops — the backend does
// NOT persist via direct MERGE. The correct write path (verified live 2026-08-25)
// is the same full-entity POST /Opportunities used for Notes: carry the
// RenewalExecution object as a navigation property in the POST body.
//
// Writable fields confirmed live (all others either derive or are ignored):
//   OBV_VALIDATED, RENEWAL_MOTION, ENGAGEMENT, OBV_AMOUNT, OBV_EOL_ADJUST,
//   OBV_EOL_ADJVAL, OBV_EOL_SKU, GTC_DATE, GTC_DEVIATIONS, CONTR_UPLF_PC,
//   CONTR_UPLF_TYP, CONTR_UPLF_TE, DEAL_UPLF_PC, DEAL_UPLF_RSN, NEG_UPLF_LANG,
//   CHURN_RECOV, CHURN_RECO_AMT, PS_CHURN_TYPE, EXP_SIGN_DATE, DOCUSIGN,
//   ROADBLOCK, REDLINE, SLIP_RISK, RSN_PA_LANG
//   NOT writable: OPPT_ID (key, sap:updatable="false")

const RENEWAL_EXEC_WRITABLE = new Set([
  'RENEWAL_MOTION', 'ENGAGEMENT', 'OBV_VALIDATED', 'OBV_AMOUNT',
  'OBV_EOL_ADJUST', 'OBV_EOL_ADJVAL', 'OBV_EOL_SKU', 'GTC_DATE',
  'GTC_DEVIATIONS', 'CONTR_UPLF_PC', 'CONTR_UPLF_TYP', 'CONTR_UPLF_TE',
  'DEAL_UPLF_PC', 'DEAL_UPLF_RSN', 'NEG_UPLF_LANG', 'CHURN_RECOV',
  'CHURN_RECO_AMT', 'PS_CHURN_TYPE', 'EXP_SIGN_DATE', 'DOCUSIGN',
  'ROADBLOCK', 'REDLINE', 'SLIP_RISK', 'RSN_PA_LANG',
]);

// Friendly-key → OData field map for setRenewalExecution callers.
const RENEWAL_EXEC_FIELD_MAP = {
  renewalMotion:    'RENEWAL_MOTION',
  engagement:       'ENGAGEMENT',
  obvValidated:     'OBV_VALIDATED',
  obvAmount:        'OBV_AMOUNT',
  obvEolAdjust:     'OBV_EOL_ADJUST',
  obvEolAdjval:     'OBV_EOL_ADJVAL',
  obvEolSku:        'OBV_EOL_SKU',
  gtcDate:          'GTC_DATE',
  gtcDeviations:    'GTC_DEVIATIONS',
  contrUpliftPc:    'CONTR_UPLF_PC',
  contrUpliftType:  'CONTR_UPLF_TYP',
  contrUpliftTerm:  'CONTR_UPLF_TE',
  dealUpliftPc:     'DEAL_UPLF_PC',
  dealUpliftReason: 'DEAL_UPLF_RSN',
  negUpliftLang:    'NEG_UPLF_LANG',
  churnRecov:       'CHURN_RECOV',
  churnRecovAmt:    'CHURN_RECO_AMT',
  psChurnType:      'PS_CHURN_TYPE',
  expSignDate:      'EXP_SIGN_DATE',
  docusign:         'DOCUSIGN',
  roadblock:        'ROADBLOCK',
  redline:          'REDLINE',
  slipRisk:         'SLIP_RISK',
  rsnPaLang:        'RSN_PA_LANG',
};

/** Read the RenewalExecution entity for an opportunity (headless). */
export async function readRenewalExecution(oppId) {
  const r = await odataGet(`RenewalExecutionSet('${oppId}')`);
  const d = r?.d ?? {};
  const { __metadata, ...clean } = d;
  return clean;
}

/**
 * Partial-update RenewalExecution fields via full-entity POST /Opportunities
 * with RenewalExecution as a deep-insert nav property (same mechanism as Notes).
 *
 * Accepts friendly keys (see RENEWAL_EXEC_FIELD_MAP) or raw OData field names.
 * GTC_DATE / EXP_SIGN_DATE accept ISO "YYYY-MM-DD" strings.
 *
 * Returns { ok, status, expected, actual, changedFields, unexpectedChanges }.
 * `ok` is true ONLY when every written field reads back with the expected value
 * AND no unexpected field moved.
 */
export async function setRenewalExecution(oppId, patch = {}) {
  // Resolve friendly keys → OData field names + validate whitelist.
  const edits = {};
  for (const [key, value] of Object.entries(patch)) {
    const field = RENEWAL_EXEC_FIELD_MAP[key] ?? (RENEWAL_EXEC_WRITABLE.has(key) ? key : null);
    if (!field) {
      return { ok: false, status: 0, reason: `unknown or non-writable field "${key}"` };
    }
    if (!RENEWAL_EXEC_WRITABLE.has(field)) {
      return { ok: false, status: 0, reason: `field "${field}" is not in the writable whitelist` };
    }
    if (value == null) {
      return { ok: false, status: 0, reason: `"${key}" must be non-null` };
    }
    // Convert ISO date strings → OData DateTime millis.
    if ((field === 'GTC_DATE' || field === 'EXP_SIGN_DATE') && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      edits[field] = `/Date(${new Date(value + 'T00:00:00Z').getTime()})/`;
    } else {
      edits[field] = value;
    }
  }
  if (Object.keys(edits).length === 0) {
    return { ok: false, status: 0, reason: 'nothing to write — patch is empty' };
  }

  const before = await readRenewalExecution(oppId);

  // Read the clean opp entity for the POST body.
  const entity = await readCleanOppEntity(oppId);
  if (!entity) return { ok: false, status: 0, reason: 'could not read opportunity' };

  // Merge edits into a clean copy of the current RenewalExecution.
  const reClean = { ...before };
  delete reClean.__metadata;
  for (const [field, value] of Object.entries(edits)) reClean[field] = value;

  const payload = { ...entity, RenewalExecution: reClean };
  const res = await odataCreate('Opportunities', payload);
  if (!res.ok) {
    return { ok: false, status: res.status, reason: `POST failed HTTP ${res.status}`, body: res.body };
  }

  const after = await readRenewalExecution(oppId);
  const targets = Object.keys(edits);
  const norm = (v) => (v == null ? '' : String(v));
  const normDate = (v) => {
    if (typeof v === 'string') { const m = v.match(/\/Date\((\d+)\)\//); if (m) return m[1]; }
    return norm(v);
  };

  const actual = {};
  const mismatched = [];
  for (const field of targets) {
    const isDate = field === 'GTC_DATE' || field === 'EXP_SIGN_DATE';
    const exp = isDate ? normDate(edits[field]) : norm(edits[field]);
    const got = isDate ? normDate(after?.[field]) : norm(after?.[field]);
    actual[field] = after?.[field] ?? null;
    if (exp !== got) mismatched.push(field);
  }

  const changedFields = [];
  if (after) {
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (norm(before[k]) !== norm(after[k])) changedFields.push(k);
    }
  }
  const unexpectedChanges = changedFields.filter((f) => !targets.includes(f));

  const ok = mismatched.length === 0 && unexpectedChanges.length === 0;
  return {
    ok,
    status: res.status,
    expected: edits,
    actual,
    changedFields,
    unexpectedChanges,
    ...(mismatched.length ? { mismatched, reason: `field(s) did not land: ${mismatched.join(', ')}` } : {}),
  };
}

// TDIDs for the Renewal Execution section text notes (distinct from Risk Qualification).
// Verified live on OPP 305942006 (2026-08-27) and OPP 305988635 (2026-09-09).
const RENEWAL_EXEC_NOTE_TDID = {
  obvValidatedNote:    'ZRE1',
  gtcDeviationsText:   'ZRE3',
  renewalClosePlan:    'ZRE4',
  internalRoadblocks:  'ZRED',
  upliftRemarks:       'ZRE6',
  perAnnumLanguage:    'ZRE8',
  redlines:            'ZREE',
};

/**
 * Set the opportunity Close Date (EXPECT_END) headlessly.
 * Checks CLOSE_DATE_EDITABLE first; returns { ok: false, wasEditable: false }
 * without touching the server if the field is locked.
 */
export async function setCloseDate(oppId, dateStr) {
  const entity = await readCleanOppEntity(oppId);
  if (!entity) return { ok: false, status: 0, reason: 'could not read opportunity' };
  const wasEditable = !!entity.CLOSE_DATE_EDITABLE;
  const [y, m, d] = dateStr.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  entity.EXPECT_END = `/Date(${ms})/`;
  entity.CHANGE_FLAGS = { ...(entity.CHANGE_FLAGS || {}), EXPECT_END: 'X' };

  const res = await odataCreate('Opportunities', entity);
  const echo = res.body?.d;
  const errorMessage = res.ok ? undefined
    : (res.body?.error?.message?.value
        ?? (typeof res.body?.error?.message === 'string' ? res.body.error.message : null)
        ?? (res.body ? JSON.stringify(res.body).slice(0, 300) : `HTTP ${res.status}`));
  return {
    ok: res.ok,
    status: res.status,
    wasEditable,
    closeDateAfter: echo?.EXPECT_END ?? null,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    body: res.ok ? undefined : res.body,
  };
}

/**
 * Write Renewal Execution section text notes (ZRE1/ZRE3/ZRE4/ZRED/ZRE6/ZRE8/ZREE)
 * headlessly via full-entity deep-insert POST — same mechanism as setRiskNotes.
 * All are additive (never overwrite). Returns { ok, status, changedNotes, unexpectedChanges }.
 */
export async function setRenewalExecutionNotes(oppId, patch = {}) {
  const edits = {};
  for (const [key, value] of Object.entries(patch)) {
    const tdid = RENEWAL_EXEC_NOTE_TDID[key];
    if (!tdid) return { ok: false, status: 0, reason: `unknown field "${key}" — only ${Object.keys(RENEWAL_EXEC_NOTE_TDID).join(', ')} are writable` };
    if (value == null || String(value).trim() === '') {
      return { ok: false, status: 0, reason: `"${key}" must be a non-empty note` };
    }
    edits[tdid] = String(value);
  }
  if (Object.keys(edits).length === 0) return { ok: false, status: 0, reason: 'empty patch' };

  const targets = Object.keys(edits);
  const first = await readOppEntityWithNotes(oppId);
  if (!first) return { ok: false, status: 0, reason: 'could not read opportunity' };

  const before = first.entity;
  const beforeNotes = notesByTdid(first.notes);

  const seenTdids = new Set();
  for (const n of first.notes) {
    if (NOTE_WRITE_NOISE_TDIDS.has(n.TDID)) continue;
    if (seenTdids.has(n.TDID)) {
      return { ok: false, status: 0, reason: `duplicate content TDID "${n.TDID}" on opp — refusing to write` };
    }
    seenTdids.add(n.TDID);
  }

  if (!before.IS_EDITABLE) return { ok: false, status: 0, reason: 'opportunity is not editable' };

  const notes = first.notes.map((n) => ({ ...n }));
  const sibling = notes.find((n) => !NOTE_WRITE_NOISE_TDIDS.has(n.TDID)) ?? notes[0];
  for (const [tdid, text] of Object.entries(edits)) {
    const row = notes.find((n) => n.TDID === tdid);
    if (row) {
      row.CONC_LINES = text;
    } else if (sibling) {
      notes.push({ TDID: tdid, CONC_LINES: text, OBJECT_ID: sibling.OBJECT_ID, TDNAME: sibling.TDNAME, TDOBJECT: sibling.TDOBJECT, TDSPRAS: sibling.TDSPRAS });
    } else {
      const derived = { OBJECT_ID: oppId, TDNAME: before.GUID?.replace(/-/g, '').toUpperCase() ?? oppId, TDOBJECT: 'CRM_ORDERH', TDSPRAS: 'EN' };
      notes.push({ TDID: tdid, CONC_LINES: text, ...derived });
    }
  }

  const payload = { ...before, Notes: notes };
  const res = await odataCreate('Opportunities', payload);

  const second = await readOppEntityWithNotes(oppId);
  const after = second ? second.entity : null;
  const afterNotes = second ? notesByTdid(second.notes) : {};

  const allTdids = new Set([...Object.keys(beforeNotes), ...Object.keys(afterNotes)]);
  const changedNotes = [...allTdids]
    .filter((t) => (beforeNotes[t] ?? '') !== (afterNotes[t] ?? ''))
    .filter((t) => !NOTE_WRITE_NOISE_TDIDS.has(t));

  const ALLOWED_TOP = new Set(['ERROR', 'CHANGED_AT', 'LAST_UPDATED_ON', 'STATUS_SINCE', 'TIME_STAMP', 'SESSION_GUID', 'DATA_CENTER']);
  const topChanged = after ? Object.keys(before).filter((f) => !ALLOWED_TOP.has(f) && String(before[f] ?? '') !== String(after[f] ?? '')) : [];
  const unexpectedNotes = changedNotes.filter((t) => !targets.includes(t));
  const unexpectedChanges = [...unexpectedNotes, ...topChanged.filter((f) => !ALLOWED_TOP.has(f))];

  const missingTargets = targets.filter((t) => (afterNotes[t] ?? '') !== edits[t]);
  const silentNoOp = res.ok && missingTargets.length > 0;
  const ok = res.ok && !silentNoOp && unexpectedChanges.length === 0;

  return {
    ok,
    status: res.status,
    silentNoOp: silentNoOp || undefined,
    expected: Object.fromEntries(targets.map((t) => [t, edits[t]])),
    actual: Object.fromEntries(targets.map((t) => [t, afterNotes[t] ?? ''])),
    changedNotes,
    unexpectedChanges,
    ...(res.ok ? {} : { body: res.body }),
  };
}

/**
 * Access gate for odataFunction / harmony_odata_function.
 *
 * ODATA_ROOT points at the live production tenant, and FunctionImports include
 * irreversible RPCs (CancelAllQuotes, DiscontinueHDMOpp, MigrateHDMToHQ...).
 * This pure function decides whether an invocation may proceed BEFORE any
 * request is built, so the policy is testable without touching the network.
 *
 * Policy:
 *   - `name` must be a bare OData identifier (blocks path/query injection).
 *   - Known read-only imports invoked with GET run unconditionally.
 *   - A write — POST method, a known-destructive name, or an UNKNOWN name
 *     (we can't prove it's safe) — requires confirmDestructive === true.
 */
const READONLY_FUNCTION_IMPORTS = new Set(
  [
    'GetContractsFromOpp',
    'GetOpportunityQuotes',
    'RefreshAccountOwner',
    'NotifyOpptOwner',
    'RedetermineParties',
  ].map((n) => n.toLowerCase()),
);

// Verb prefixes that mutate state. Matched case-insensitively against the name.
const DESTRUCTIVE_VERBS = [
  'cancel', 'discontinue', 'delete', 'remove', 'create', 'copy',
  'migrate', 'trigger', 'submit', 'approve', 'reject', 'worklist',
  'salesteamrequest', 'update', 'set', 'write',
];

const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export function classifyFunctionImport(name, method = 'GET', confirmDestructive = false) {
  if (typeof name !== 'string' || !IDENTIFIER_RE.test(name)) {
    return { allowed: false, isDestructive: false, reason: `Invalid FunctionImport name ${JSON.stringify(name)} — must match ${IDENTIFIER_RE}.` };
  }
  const lower = name.toLowerCase();
  const isKnownReadonly = READONLY_FUNCTION_IMPORTS.has(lower);
  const hasDestructiveVerb = DESTRUCTIVE_VERBS.some((v) => lower.startsWith(v));
  const isPost = String(method).toUpperCase() !== 'GET';

  // A write is anything that mutates: POST, a destructive-verb name, or an
  // unknown name (not on the read-only allowlist → treat as unsafe).
  const isDestructive = isPost || hasDestructiveVerb || !isKnownReadonly;

  if (!isDestructive) {
    return { allowed: true, isDestructive: false, reason: 'known read-only import' };
  }
  if (confirmDestructive) {
    return { allowed: true, isDestructive: true, reason: 'destructive/unknown import explicitly confirmed' };
  }
  return {
    allowed: false,
    isDestructive: true,
    reason: `${name} is destructive or not a known read-only import; pass confirmDestructive:true to run it${isKnownReadonly && isPost ? ' (POST is treated as a write)' : ''}.`,
  };
}

/**
 * Invoke an OData FunctionImport (Harmony action API). Most functions accept
 * simple GET with query params; some require POST — pass method:'POST' if the
 * FunctionImport's m:HttpMethod says so.
 *
 * Guarded by classifyFunctionImport: destructive or unknown imports require
 * confirmDestructive:true. See that function for the policy.
 *
 * Available actions include: CopyOpportunity, CreateDeal, WorkListDescisionComplete,
 * CancelAllQuotes, DiscontinueHDMOpp, SalesTeamRequest, RedetermineParties,
 * TriggerGRCActivity, MigrateHDMToHQ, etc. See metadata.xml for full list.
 */
export async function odataFunction(name, params = {}, method = 'GET', confirmDestructive = false) {
  const gate = classifyFunctionImport(name, method, confirmDestructive);
  if (!gate.allowed) {
    throw new Error(`Blocked FunctionImport: ${gate.reason}`);
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    // OData wants string values quoted: OPP_ID='306192295'. Double any embedded
    // quote so a value can't break out of the literal.
    qs.set(k, typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : String(v));
  }
  const url = `${ODATA_ROOT}/${name}?${qs}`;
  const headers = { 'Accept': 'application/json' };
  if (method !== 'GET') headers['X-CSRF-Token'] = await fetchCsrf();
  const res = await apiFetch(url, { method, headers });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { _raw: text }; }
  if (!res.ok) throw new Error(`FunctionImport ${name} HTTP ${res.status}: ${text.slice(0, 400)}`);
  return body;
}

// ============ CPQ 2.0 (headless via budgie OAuth proxy) ============
//
// CPQ 2.0 is SAP's next-gen quoting engine (separate domain: sap-ies-sales-quote2.cpq.cloud.sap).
// Unlike CPQ 1.0's Cart operations that require Chrome CDP, the ENTIRE CPQ 2.0 API surface —
// including writes like Reprice (ExecuteAction actionId=18) — is accessible headlessly through
// the budgie OAuth proxy at /oAuthcpq2/. Same sap-auth session, no browser needed.
//
// Key differences from CPQ 1.0 (callidusScript):
//   - URL prefix: /oAuthcpq2/ instead of /callidus/
//   - Script body: JSON (Content-Type: application/json) instead of form-encoded
//   - Script param keys: PascalCase {ScriptName, Param} instead of {scriptname, Param}
//   - REST API available: /api/v1/quotes/{shortId}/... for structured reads
//   - Cart rd API: /api/rd/v1/Cart/ExecuteAction — headless! (no Cart.aspx session required)
//   - Quote ID: short int (e.g. 20758), NOT the composite number (e.g. 509184000009)

const CPQ2_PREFIX = `${BUDGIE}${APP_PREFIX}/oAuthcpq2`;

/** Call a CPQ 2.0 custom script via the budgie OAuth proxy. JSON body, not form-encoded. */
export async function cpq2Script(scriptName, param) {
  const url = `${CPQ2_PREFIX}/customapi/executescriptfed`;
  const res = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ ScriptName: scriptName, Param: JSON.stringify(param) }),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { _raw: text }; }
  if (!res.ok) throw new Error(`cpq2 script ${scriptName} HTTP ${res.status}: ${text.slice(0, 400)}`);
  return parsed;
}

/** List all CPQ 2.0 quotes under an opportunity. Returns array with QuoteId (short), QuoteNumber, status, etc. */
export async function cpq2ListQuotes(oppId) {
  const r = await cpq2Script('Q_API_GetOpportunityQuotes', { OpportunityIds: String(oppId) });
  return r?.data ?? r;
}

/** GET a CPQ 2.0 REST endpoint (headless, via budgie proxy). */
async function cpq2Get(path) {
  const url = `${CPQ2_PREFIX}${path}`;
  const res = await apiFetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`cpq2 GET ${path} HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json();
}

/** Read full quote header — custom fields, involved parties, quote table names, pricing totals. */
export async function cpq2ReadQuote(shortQuoteId) {
  return cpq2Get(`/api/v1/quotes/${shortQuoteId}`);
}

/** Read all line items with selected attributes and pricing conditions. */
export async function cpq2ReadItems(shortQuoteId, expand = 'selectedAttributes,pricingConditions') {
  const path = `/api/v1/quotes/${shortQuoteId}/items${expand ? `?$expand=${expand}` : ''}`;
  return cpq2Get(path);
}

/** Read rows of a specific QuoteTable. */
export async function cpq2ReadTable(shortQuoteId, tableName) {
  return cpq2Get(`/api/v1/quotes/${shortQuoteId}/quoteTables/${encodeURIComponent(tableName)}/rows`);
}

/**
 * Execute a Cart action on a CPQ 2.0 quote — HEADLESS (no Chrome needed).
 * Known actionIds: 18 = Reprice, 19 = Save (verify before use).
 * Returns full Cart state: items with pricing, quote tables, custom fields.
 */
export async function cpq2ExecuteAction(shortQuoteId, actionId, payload = {}) {
  const url = `${CPQ2_PREFIX}/api/rd/v1/Cart/ExecuteAction?actionId=${actionId}&quoteId=${shortQuoteId}`;
  const body = {
    GroupToActivate: 1,
    DirtyCells: {},
    DirtyCustomFields: {},
    ItemsFilterQuery: [],
    ...payload,
  };
  const res = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { _raw: text }; }
  if (!res.ok) throw new Error(`cpq2 ExecuteAction(${actionId}) HTTP ${res.status}: ${text.slice(0, 400)}`);
  return parsed;
}


// ── Auth renewal ────────────────────────────────────────────────────────────────
const DCD_HOST  = 'sapit-finance-prod-eagle.launchpad.cfapps.eu10.hana.ondemand.com';
const DCD_ENTRY = 'https://sapit-finance-prod-eagle.launchpad.cfapps.eu10.hana.ondemand.com/51c308db-7700-446c-96ff-f0f82d613117.mdsdlcdcdcockpit.mdsdlcdcdcockpit/index.html';

export async function renewAuth() {
  // Ensure both providers are registered before forcing renewal.
  // createAuthClient is idempotent — safe to call even if already registered.
  createAuthClient({ domain: DCD_HOST, method: 'sap-sso', entryUrl: DCD_ENTRY });

  const auth = AuthManager.getInstance();
  const results = {};

  try { await auth.forceReauth(BUDGIE_HOST); results.harmony = 'ok'; }
  catch (e) { results.harmony = `error: ${e.message}`; }

  try { await auth.forceReauth(DCD_HOST); results.dcd = 'ok'; }
  catch (e) { results.dcd = `error: ${e.message}`; }

  const ok = results.harmony === 'ok' && results.dcd === 'ok';
  return {
    ok,
    harmony: results.harmony,
    dcd: results.dcd,
    message: ok
      ? 'SAP cookies renovados. Harmony + DCD prontos.'
      : 'Renovacao parcial — ver detalhes.',
  };
}
