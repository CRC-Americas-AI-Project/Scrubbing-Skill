// Engine for sap-dcd-mcp.
//
// Reads SAP's "Digital Contract Data (DCD) Cockpit" (Fiori app `mdsdlcdcdcockpit`,
// OData v2 service `ZDCD_SRV;v=0002`) fully headlessly via the shared sap-auth SSO
// cookie — no browser at request time. Reverse-engineered 2026-07-11; full notes in
// the repo's scratch/DCC_REVERSE_ENGINEERING.md.
//
// The DCD data plane is the richest signed-contract-terms source SAP internal has:
// contract headers, line items, ~130 legal clause fields, and downloadable signed
// contract PDFs — all filtered by customer ERP number.
//
// Contract quirks encoded below (each cost a probe to discover):
//   - Filter every Account_* entity by ERPNUMBER, never CASE_ID (CASE_ID → 0 rows).
//   - Free-text customer search = the GW `search=` url param, NOT $filter=substringof
//     (which returns __count but empty results).
//   - CmsDocumentsSet filters by CaseId ONLY. CaseGuid is Edm.String — passing a
//     guid'…' literal → HTTP 400.
//   - PDF bytes come only from the media entities CmsAttachment / Xreference_Attach
//     via /$value. CmsDocuments is NOT a media entity (its /$value → 400 "must be a
//     Media Link Entry") — it is just the metadata catalog. The CaseGuid in the key
//     predicate is uppercase with NO dashes.
//   - GetCaseGUID returns the guid nested at d.GetCaseGUID.CaseGuid.

import { createAuthClient } from 'sap-auth';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// ── Config ───────────────────────────────────────────────────────────────────
export const DOMAIN = 'sapit-finance-prod-eagle.launchpad.cfapps.eu10.hana.ondemand.com';

// The `51c308db-…mdsdlcdcdcockpit.mdsdlcdcdcockpit` segment is a CF managed-approuter
// instance path (`{instance-guid}.{service}.{service}`). The GUID can rotate on
// redeploy. Override with DCD_BASE if a read starts 404ing; otherwise the pinned
// default (observed 2026-07-11) is used.
const APP_ROOT_DEFAULT =
  `https://${DOMAIN}/51c308db-7700-446c-96ff-f0f82d613117.mdsdlcdcdcockpit.mdsdlcdcdcockpit`;
const APP_ROOT = (process.env.DCD_BASE || APP_ROOT_DEFAULT).replace(/\/+$/, '');
export const SERVICE_BASE = `${APP_ROOT}/sap/opu/odata/sap/ZDCD_SRV;v=0002`;

// Request timeouts (ms): JSON reads are quick; a PDF /$value can be multi-MB, so
// it gets a larger bound. Override via DCD_TIMEOUT_MS / DCD_DOWNLOAD_TIMEOUT_MS.
const JSON_TIMEOUT_MS = Number(process.env.DCD_TIMEOUT_MS) || 30_000;
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DCD_DOWNLOAD_TIMEOUT_MS) || 120_000;

// ── Auth (shared sap-auth) ────────────────────────────────────────────────────
// Same mechanism as sap-harmony-mcp / sap-one360-mcp / sap-material-map-mcp. The
// gateway returns 200 + a SAML-fragment HTML body when the session is stale — detect
// it so fetch() force-refreshes. CRITICAL: gate the HTML sniff on content-type so a
// binary PDF (application/pdf) from /$value is never buffered/misjudged as a login body.
function isSamlLoginBody(text) {
  if (!text || typeof text !== 'string') return false;
  if (!(text.startsWith('<html') || text.startsWith('<!DOCTYPE'))) return false;
  return /fragmentAfterLogin|SAMLRequest|SAMLResponse|nonce=/i.test(text.slice(0, 800));
}

const authClient = createAuthClient({
  domain: DOMAIN,
  method: 'sap-sso',
  entryUrl: `${APP_ROOT}/index.html`,
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

// ── Low-level HTTP ─────────────────────────────────────────────────────────────
async function jget(pathAndQs) {
  const url = pathAndQs.startsWith('http') ? pathAndQs : `${SERVICE_BASE}/${pathAndQs}`;
  let res;
  try {
    res = await authClient.fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
  } catch (e) {
    if (e && e.name === 'TimeoutError') {
      throw new Error(`GET ${url} timed out after ${JSON_TIMEOUT_MS}ms (gateway unresponsive?).`);
    }
    throw e;
  }
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        `GET ${url} HTTP 404. The service base URL may have rotated (CF redeploy). ` +
        `Re-probe the app's manifest.json and set DCD_BASE. Body: ${text.slice(0, 200)}`,
      );
    }
    throw new Error(`GET ${url} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  try { return JSON.parse(text); }
  catch { throw new Error(`GET ${url} non-JSON response: ${text.slice(0, 200)}`); }
}

// Fetch raw bytes (for PDF /$value media downloads). No JSON parse, no .text().
// Validates the response is real binary content, not a 200 HTML/SAML error page
// (which the gateway can return with status 200), so a stale session or GW error
// is never written to disk as if it were a signed contract.
async function bget(pathAndQs) {
  const url = pathAndQs.startsWith('http') ? pathAndQs : `${SERVICE_BASE}/${pathAndQs}`;
  let res;
  try {
    res = await authClient.fetch(url, {
      headers: { Accept: '*/*' },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (e) {
    if (e && e.name === 'TimeoutError') {
      throw new Error(`GET ${url} timed out after ${DOWNLOAD_TIMEOUT_MS}ms (download stalled?).`);
    }
    throw e;
  }
  if (!res.ok) {
    // Read the (small) error body for context; a failed media read is XML/JSON, not binary.
    let body = '';
    try { body = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    throw new Error(`GET ${url} HTTP ${res.status}: ${body}`);
  }
  const contentType = res.headers.get('content-type') || '';
  // The body read can itself abort if the timeout fires mid-stream (the most likely
  // slow-path failure for a multi-MB PDF). Wrap it so the operator gets the actionable
  // timeout message rather than a bare AbortError.
  let buf;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error(`GET ${url} aborted after ${DOWNLOAD_TIMEOUT_MS}ms (download stream stalled?).`);
    }
    throw e;
  }
  // Guard: a 200 that is actually an HTML/SAML login or error page must not be
  // written out as a contract. Media responses are binary; text/html is never valid here.
  if (contentType.includes('text/html')) {
    const head = buf.subarray(0, 64).toString('latin1').trimStart().toLowerCase();
    throw new Error(
      `GET ${url} returned text/html (${buf.length} bytes) instead of binary content — ` +
      `likely a stale session or gateway error page, not a document. Head: ${head.slice(0, 60)}`,
    );
  }
  // The content-type guard alone is evadable: a stale-session/error page can come
  // back as application/xml, octet-stream, or with no content-type at all. Sniff the
  // actual bytes so we never persist a login/error page as a signed contract.
  //  - Reject a suspiciously tiny body (a real contract PDF is never a few hundred bytes).
  //  - Reject a body whose head is markup (HTML/XML/SAML) regardless of content-type.
  const SMALL_BODY_FLOOR = 512;
  const head = buf.subarray(0, 64).toString('latin1').trimStart().toLowerCase();
  if (head.startsWith('<html') || head.startsWith('<!doctype') || head.startsWith('<?xml') ||
      head.includes('samlrequest') || head.includes('samlresponse') || head.includes('fragmentafterlogin')) {
    throw new Error(
      `GET ${url} returned a markup/SAML body (${buf.length} bytes, content-type "${contentType}") ` +
      `instead of binary content — likely a stale session or gateway error page, not a document. ` +
      `Head: ${head.slice(0, 60)}`,
    );
  }
  if (buf.length < SMALL_BODY_FLOOR) {
    throw new Error(
      `GET ${url} returned only ${buf.length} bytes (content-type "${contentType}") — too small to be a ` +
      `signed contract; likely an error/empty response, not a document.`,
    );
  }
  return { buf, contentType };
}

// ── Normalizers (pure — unit-tested) ────────────────────────────────────────────
// OData v2 date: "/Date(1774828800000)/" (epoch ms) → "YYYY-MM-DD" (UTC), else null.
// Anchored: only a value that is *entirely* a SAP date literal is decoded, so a
// free-text field that merely contains "/Date(n)/" is left intact.
export function parseSapDate(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(/^\/Date\((-?\d+)\)\/$/);
  if (!m) return null;
  const ms = Number(m[1]);
  if (!Number.isFinite(ms)) return null;
  // An out-of-range epoch (|ms| > 8.64e15) makes new Date(ms) invalid, and
  // .toISOString() would throw RangeError. clean() maps this over every field
  // of every row, so a single bad literal must not abort the whole read.
  const dt = new Date(ms);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
}

// DCD stores SALES_DOC_ID as the CRM order number left-padded with zeroes to 10 chars.
// A Harmony PREV_CONTR_ID like "63247134" must be padded to "0063247134" to match.
export function padSalesDoc(id) {
  const s = String(id).replace(/\s+/g, '');
  return s.length >= 10 ? s : s.padStart(10, '0');
}

// CaseGuid in a CmsAttachment key predicate is uppercase with NO dashes (Edm.String).
// GetCaseGUID returns "5d7f5a58-3831-1fd0-b6b2-30685512e149" → "5D7F5A58...E149".
export function normalizeCaseGuid(g) {
  return String(g || '').replace(/-/g, '').toUpperCase();
}

// Escape a value for an OData v2 string literal: single quotes are doubled.
// URL-encoding the whole filter does NOT do this (encodeURIComponent leaves "'"
// untouched), so a raw quote in erp/caseId would otherwise close the literal and
// alter the filter. Always wrap interpolated values with this.
export function odataLiteral(v) {
  return String(v).replace(/'/g, "''");
}

// Build the on-disk filename for a downloaded document, safe against path
// traversal. BOTH the server-supplied Filename and Fileext are sanitized (an
// unsanitized Fileext like "../../x" would otherwise escape the target dir once
// concatenated), then the whole result is stripped of any path separator so the
// name is always a single path segment.
export function buildSafeFileName(filename, documentId, fileext) {
  const strip = (s) => String(s == null ? '' : s).replace(/[/\\:]+/g, '_');
  const ext = strip(fileext || 'pdf').toLowerCase().replace(/^\.+/, '') || 'pdf';
  const base = strip(filename || documentId || 'document');
  const name = base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
  // Final guard: collapse any residual separator and reject "." / ".." segments.
  return name.replace(/[/\\]+/g, '_').replace(/^\.+$/, '_');
}

// OData v2 collection/entity → array of rows.
function rows(payload) {
  const d = payload && payload.d;
  if (!d) return [];
  if (Array.isArray(d.results)) return d.results;
  return [d];
}

// Strip the __metadata blob and decode any /Date()/ fields in place.
function clean(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === '__metadata') continue;
    const dt = parseSapDate(v);
    out[k] = dt !== null ? dt : v;
  }
  return out;
}

// ── High-level aggregators (the tools) ──────────────────────────────────────────
export async function whoami() {
  // $metadata is the cheapest authenticated read; proves cookies are accepted.
  const url = `${SERVICE_BASE}/$metadata`;
  let res;
  try {
    res = await authClient.fetch(url, {
      headers: { Accept: 'application/xml' },
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
  } catch (e) {
    if (e && e.name === 'TimeoutError') {
      throw new Error(`whoami: GET ${url} timed out after ${JSON_TIMEOUT_MS}ms (gateway unresponsive?).`);
    }
    throw e;
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`whoami: GET ${url} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return { ok: true, service: 'ZDCD_SRV;v=0002', base: SERVICE_BASE, domain: DOMAIN };
}

// Free-text customer search → ERPNUMBER. MUST use the GW `search=` url param.
// GW quirk: this entity's `search` returns FEWER rows as $top grows ($top=8→13,
// $top=20→1, $top=25→0) — the backend treats a large $top as a different code path
// that yields nothing. Keep $top small; 10 reliably returns the top matches.
export async function search(term) {
  if (!term) throw new Error('search requires a term');
  const qs = `Account_SearchSet?search=${encodeURIComponent(term)}` +
    `&$top=10&$select=ERPNUMBER,BUSINESSPARTNERNAME,COUNTRYNAME,NUMBER_OF_ACTIVE_CASES&$format=json`;
  const payload = await jget(qs);
  return { term, results: rows(payload).map(clean) };
}

// All contracts for a customer: headers (Overview) + line items (Products).
export async function customerContracts(erp) {
  if (!erp) throw new Error('customerContracts requires an ERP number');
  const flt = encodeURIComponent(`ERPNUMBER eq '${odataLiteral(erp)}'`);
  const overviewQs =
    `Account_OverviewSet?$filter=${flt}&$select=CASE_ID,OPPORTUNITY_ID,QUOTE_ID,SALES_DOC_ID,` +
    `DEAL_DESCRIPTION,AACV,TCV,CURRENCY,CONTRACT_START_DATE,CONTRACT_END_DATE,SIGNATURE_DATE,` +
    `DEAL_TYPE,RENEWAL_TYPE&$format=json`;
  const productsQs =
    `Account_ProductsSet?$filter=${flt}&$select=CASE_ID,LPR_ID,LPR_DESCRIPTION,NET_VALUE,LIST_PRICE,` +
    `CURRENCY,START_DATE,END_DATE,METRICS,UNITS_QUANTITY,UOM_DESCRIPTION,QUOTE_ID,STAT_ORDERNO&$format=json`;
  const [ov, pr] = await Promise.all([jget(overviewQs), jget(productsQs)]);
  return { erp, contracts: rows(ov).map(clean), lineItems: rows(pr).map(clean) };
}

// ~130 legal clause fields for a customer's contracts; optionally narrow to one caseId.
export async function contractClauses(erp, caseId) {
  if (!erp) throw new Error('contractClauses requires an ERP number');
  const flt = encodeURIComponent(`ERPNUMBER eq '${odataLiteral(erp)}'`);
  const payload = await jget(`Account_ContractualClauseSet?$filter=${flt}&$format=json`);
  let list = rows(payload).map(clean);
  if (caseId) list = list.filter((r) => String(r.CASE_ID) === String(caseId));
  return { erp, caseId: caseId || null, clauses: list };
}

// Document catalog for a case (metadata only — NOT the binary). Filter by CaseId only.
export async function contractDocuments(caseId) {
  if (!caseId) throw new Error('contractDocuments requires a caseId');
  const flt = encodeURIComponent(`CaseId eq '${odataLiteral(caseId)}'`);
  const qs = `CmsDocumentsSet?$filter=${flt}` +
    `&$select=DocumentId,Description,Filename,Fileext,Mimetype,CategoryDesc,Status,CaseGuid&$format=json`;
  const payload = await jget(qs);
  return { caseId, documents: rows(payload).map(clean) };
}

// Resolve the case GUID via the function import (nested at d.GetCaseGUID.CaseGuid).
async function getCaseGuid(caseId) {
  const payload = await jget(`GetCaseGUID?CaseID='${encodeURIComponent(odataLiteral(caseId))}'&$format=json`);
  const g = payload && payload.d && payload.d.GetCaseGUID;
  const guid = g && (g.CaseGuid || g.CaseGUID);
  if (!guid) throw new Error(`GetCaseGUID('${caseId}') returned no CaseGuid`);
  return guid;
}

// Download signed-contract PDF(s) for a case to disk.
//   caseId       — DCD 10-digit case id.
//   documentId   — optional; if omitted, downloads only "Contract Documents".
//   outDir       — optional target dir (default: ./dcd-contracts-<caseId>).
// Returns { caseId, dir, downloaded:[{documentId,name,path,bytes,mimetype}],
//           skipped:[{documentId,name,categoryDesc,reason}], failed:[...] }.
// Fails closed: when documentId is omitted and NO doc is categorized as a contract,
// it downloads nothing and reports every doc under `skipped` (rather than silently
// dumping certificates/other attachments as if they were the signed contract).
export async function downloadContract(caseId, documentId, outDir) {
  if (!caseId) throw new Error('downloadContract requires a caseId');
  const guid = normalizeCaseGuid(await getCaseGuid(caseId));

  // Catalog the docs so we know filenames + which to grab.
  const cat = await contractDocuments(caseId);
  const allDocs = cat.documents;
  const skipped = [];
  let docs;
  if (documentId) {
    docs = allDocs.filter((d) => d.DocumentId === documentId);
    if (!docs.length) throw new Error(`documentId '${documentId}' not found on case ${caseId}`);
  } else {
    // Default: only the actual contract paperwork, never the DocuSign certificate etc.
    // Word-boundary match (not bare substring) so a category like "Non-Contract
    // Attachment" does NOT qualify — a substring /contract/i would wrongly download it.
    // The `(?<!non[- ])` guard rejects the hyphen/space-joined "Non-Contract" form too.
    const isContractCategory = (c) => /(?<!non[- ])\bcontract\b/i.test(c || '');
    docs = allDocs.filter((d) => isContractCategory(d.CategoryDesc));
    for (const d of allDocs) {
      if (!docs.includes(d)) {
        skipped.push({
          documentId: d.DocumentId,
          name: d.Filename || d.DocumentId,
          categoryDesc: d.CategoryDesc || '',
          reason: 'not categorized as a Contract Document',
        });
      }
    }
    // Fail closed: no contract-category doc → download nothing, report why.
    if (!docs.length) {
      return {
        caseId,
        dir: null,
        downloaded: [],
        skipped,
        failed: [],
        note:
          allDocs.length
            ? `No document on case ${caseId} is categorized as a Contract Document; ` +
              `nothing downloaded. Pass an explicit documentId to fetch one of the ` +
              `${allDocs.length} other document(s) (see skipped[]).`
            : `Case ${caseId} has no documents.`,
      };
    }
  }

  const dir = outDir || `dcd-contracts-${caseId}`;
  await mkdir(dir, { recursive: true });

  const results = [];
  const failed = [];
  const usedNames = new Set();
  for (const d of docs) {
    // Safe, traversal-proof filename (sanitizes BOTH Filename and Fileext).
    let fileName = buildSafeFileName(d.Filename, d.DocumentId, d.Fileext);
    // Disambiguate collisions so a shared filename never silently overwrites.
    if (usedNames.has(fileName)) {
      const dot = fileName.lastIndexOf('.');
      const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
      const ext = dot > 0 ? fileName.slice(dot) : '';
      fileName = `${stem}-${buildSafeFileName(d.DocumentId, d.DocumentId, '')}${ext}`;
    }
    usedNames.add(fileName);
    // Both dynamic values are OData string literals: escape quotes (odataLiteral)
    // then url-encode — encodeURIComponent alone leaves "'" intact and would let a
    // quote-bearing id break the key predicate. guid is hex-normalized already.
    const key =
      `DocumentId='${encodeURIComponent(odataLiteral(d.DocumentId))}',CaseGuid='${guid}',CaseId='${encodeURIComponent(odataLiteral(caseId))}'`;
    try {
      const { buf, contentType } = await bget(`CmsAttachmentSet(${key})/$value`);
      const path = join(dir, fileName);
      await writeFile(path, buf);
      results.push({
        documentId: d.DocumentId,
        name: fileName,
        path,
        bytes: buf.length,
        mimetype: contentType || d.Mimetype || '',
      });
    } catch (e) {
      // One document's failure must not abort the batch or hide what succeeded.
      failed.push({ documentId: d.DocumentId, name: fileName, error: e.message });
    }
  }
  return { caseId, dir, downloaded: results, skipped, failed };
}
