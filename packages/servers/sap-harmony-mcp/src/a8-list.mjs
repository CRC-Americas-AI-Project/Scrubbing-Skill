// a8-list.mjs — fetch + parse + cache the "CLOUD Materials Requiring Approval
// in Selling" wiki page (space MM, pageId 2452867878).
//
// That page lists SKUs with a lifecycle Status (A8-Special Approval, A4, ...).
// A8/A4 do NOT block the material — but A8 requires the stated approver's
// approval to be attached directly to the quote. This module turns the page
// into a { materialId -> {description, recommendedAction, contact,
// replacementId, status, dateSet, reason} } map used by harmony_a8_check.
//
// Auth: the page lives on wiki.one.int.sap, a different host than Harmony's
// budgie launchpad. We use a dedicated sap-auth client for that domain (same
// headless SSO the sap-wiki MCP uses), so this MCP stays self-contained.

import { createAuthClient } from 'sap-auth';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WIKI_HOST = 'wiki.one.int.sap';
const PAGE_ID = '2452867878';
const STORAGE_URL = `https://${WIKI_HOST}/wiki/rest/api/content/${PAGE_ID}?expand=body.storage,version`;

const CACHE_DIR = join(homedir(), '.cache', 'sap-harmony');
const CACHE_FILE = join(CACHE_DIR, 'a8-materials.json');
const TTL_MS = 24 * 60 * 60 * 1000; // 24h

let wikiClient; // lazy — creating the auth client can spawn the SSO browser
function getWikiClient() {
  if (!wikiClient) {
    wikiClient = createAuthClient({
      domain: WIKI_HOST,
      method: 'sap-sso',
      entryUrl: `https://${WIKI_HOST}/wiki/`,
      isAuthFailure: async (r) => r.status === 401 || r.status === 403,
    });
  }
  return wikiClient;
}

/** Strip inline tags/entities from a <td> inner HTML down to plain text. */
function cellText(inner) {
  return inner
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#xa0;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse the storage-format XML of the approval page into a material map.
 * Columns (positional): Material ID | Description | Recommended Action |
 * who to Contact | Replacement Material ID | Status | Date Status set | Reason.
 * A row is a material row only when column 0 is a 7-digit 8-prefixed id.
 */
export function parseA8Table(storageXml) {
  const map = {};
  const rows = storageXml.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) || [];
  for (const tr of rows) {
    const tds = tr.match(/<td\b[^>]*>([\s\S]*?)<\/td>/g);
    if (!tds) continue;
    const cells = tds.map((td) => cellText(td.replace(/^<td\b[^>]*>/, '').replace(/<\/td>$/, '')));
    const materialId = cells[0];
    if (!/^8\d{6}$/.test(materialId)) continue; // skip header / non-material rows
    map[materialId] = {
      materialId,
      description: cells[1] || '',
      recommendedAction: cells[2] || '',
      contact: cells[3] || '',
      replacementId: cells[4] || '',
      status: cells[5] || '',
      dateSet: cells[6] || '',
      reason: cells[7] || '',
    };
  }
  return map;
}

/** Fetch the page storage XML from the wiki (live). */
async function fetchStorageXml() {
  const res = await getWikiClient().fetch(STORAGE_URL, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`wiki content HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const xml = j?.body?.storage?.value;
  if (!xml) throw new Error('wiki response missing body.storage.value');
  return { xml, version: j?.version?.number };
}

function readCache() {
  if (!existsSync(CACHE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null; // corrupt cache → treat as miss
  }
}

function writeCache(entry) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(entry, null, 2));
}

/**
 * Return the A8 material map, using a 24h on-disk cache.
 * @param {{refresh?: boolean, now?: number}} opts refresh forces a re-fetch.
 * @returns {Promise<{map: object, meta: {fetchedAt: string, materialCount: number, cacheAgeHours: number, wikiVersion?: number, stale?: boolean}}>}
 */
export async function getA8Map({ refresh = false, now = Date.now() } = {}) {
  const cached = readCache();
  const fresh = cached && now - new Date(cached.fetchedAt).getTime() < TTL_MS;
  if (cached && fresh && !refresh) {
    return { map: cached.map, meta: cacheMeta(cached, now) };
  }
  try {
    const { xml, version } = await fetchStorageXml();
    const map = parseA8Table(xml);
    const entry = { fetchedAt: new Date(now).toISOString(), wikiVersion: version, map };
    writeCache(entry);
    return { map, meta: cacheMeta(entry, now) };
  } catch (err) {
    // Network/auth failure: fall back to a stale cache if we have one, so a
    // transient wiki outage doesn't break the check. Surface staleness.
    if (cached) {
      return { map: cached.map, meta: { ...cacheMeta(cached, now), stale: true, fetchError: String(err.message || err) } };
    }
    throw err;
  }
}

function cacheMeta(entry, now) {
  return {
    fetchedAt: entry.fetchedAt,
    materialCount: Object.keys(entry.map).length,
    cacheAgeHours: Math.round(((now - new Date(entry.fetchedAt).getTime()) / 3.6e6) * 10) / 10,
    wikiVersion: entry.wikiVersion,
  };
}

// ── The opp → flagged-SKU join ──────────────────────────────────────────────

const isA8 = (status) => /^A8\b/.test(status);
const isFlaggable = (status, type) => (type === 'all' ? /^A[0-9]/.test(status) : isA8(status));

/**
 * Check one or more opportunities for restricted (A8 by default) materials.
 *
 * @param {string|string[]} oppIds  single id or array; checked one by one.
 * @param {object} opts
 * @param {object} opts.map         material map ({id -> row}); injected in tests.
 * @param {(oppId:string)=>Promise<Array>} opts.readItems  fetch opp line items.
 * @param {'A8'|'all'} [opts.type='A8']  'all' also surfaces A4 (informational).
 * @param {object} [opts.meta]       cache meta to echo into the response.
 * @returns {Promise<{listSource?:object, results:Array, summary:object}>}
 */
export async function a8Check(oppIds, { map, readItems, type = 'A8', meta } = {}) {
  if (!map) throw new Error('a8Check requires a material map');
  if (typeof readItems !== 'function') throw new Error('a8Check requires readItems(oppId)');
  const ids = Array.isArray(oppIds) ? oppIds : [String(oppIds)];

  const results = [];
  for (const oppId of ids) {
    const items = (await readItems(String(oppId))) || [];
    const seen = new Set();
    const flagged = [];
    for (const it of items) {
      const pid = it.PRODUCT_ID;
      if (!pid || seen.has(pid)) continue;
      const row = map[pid];
      if (row && isFlaggable(row.status, type)) {
        seen.add(pid);
        flagged.push({
          productId: pid,
          description: row.description || it.PRODUCT_DESCR || '',
          status: row.status,
          recommendedAction: row.recommendedAction,
          contact: row.contact,
          replacementId: row.replacementId,
          reason: row.reason,
        });
      }
    }
    results.push({ oppId: String(oppId), itemCount: items.length, flaggedCount: flagged.length, flagged });
  }

  const summary = {
    oppsChecked: results.length,
    oppsWithA8: results.filter((r) => r.flagged.some((f) => isA8(f.status))).length,
    totalFlagged: results.reduce((n, r) => n + r.flaggedCount, 0),
  };
  return meta ? { listSource: meta, results, summary } : { results, summary };
}

