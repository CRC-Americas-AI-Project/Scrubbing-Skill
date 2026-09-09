// cpq-client.mjs — CPQ-direct API client.
//
// The CPQ backend (`sap-ies-sales.cpq.cloud.sap`) uses its OWN session cookies
// (SAML_Session, ASP.NET_SessionId, __RequestVerificationToken, X-CSRF-Token)
// set at UI-login time. Headless SSO via sap-auth doesn't produce these — they
// only exist after the CPQ SAML handshake in a live browser.
//
// This module DELIBERATELY does not import sap-auth. sap-auth's process manager
// unconditionally kills any Chrome running with --remote-debugging-port (it
// assumes such Chromes are its own puppeteer instances), which would kill the
// user's CDP :9222 Chrome that we depend on. Keeping this module isolated
// prevents that side-effect.
//
// The module talks raw CDP over HTTP + WebSocket (no Playwright dependency
// either — just Node built-ins + the `ws` package that's already bundled
// somewhere in node_modules) to do two read-only things:
//   1. list cookies for the CPQ origin
//   2. run `Runtime.evaluate` on the CPQ iframe target to read window.csrfToken
//
// Then it uses Node's native fetch() to talk to CPQ directly.

const CPQ_HOST = 'sap-ies-sales.cpq.cloud.sap';
const CPQ_ORIGIN = `https://${CPQ_HOST}`;
const CDP_URL = 'http://127.0.0.1:9222';
const AUTH_TTL_MS = 60_000;

// Headed-session launcher config. The :9222 Chrome must use a dedicated
// user-data-dir so it doesn't collide with the user's normal Chrome profile.
const CDP_PORT = 9222;
const USER_DATA_DIR = '/tmp/chrome-cdp-harmony';
const HARMONY_BASE_URL =
  'https://sapit-home-prod-004.launchpad.cfapps.eu10.hana.ondemand.com/site#harmonyquote-Display';

let _authCache = null;
let _authCacheAt = 0;

// ── Raw CDP helpers ──────────────────────────────────────────────────────────

async function cdpListTargets() {
  const http = await import('node:http');
  return new Promise((resolve, reject) => {
    http.get(`${CDP_URL}/json`, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function resolveBundledWs() {
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const { existsSync } = await import('node:fs');
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', 'node_modules', 'ws'),
    resolve(here, '..', '..', 'playwright-mcp', 'node_modules', 'ws'),
    resolve(here, '..', '..', '..', '..', 'node_modules', 'ws'),
    resolve(here, '..', '..', '..', 'node_modules', 'ws'),
  ];
  for (const c of candidates) {
    const idx = resolve(c, 'index.js');
    if (existsSync(idx)) return pathToFileURL(idx).href;
  }
  throw new Error(
    'The `ws` package is required to read CPQ CSRF via CDP but was not found. ' +
    'Candidates: ' + candidates.join(', ')
  );
}

/**
 * Open a WebSocket to a CDP target's debuggerUrl, send one method call, resolve
 * with the response. Timed out after 3s.
 */
async function cdpCall(WSClass, wsUrl, method, params) {
  return new Promise((resolve) => {
    let done = false;
    const ws = new WSClass(wsUrl);
    const finish = (v) => { if (done) return; done = true; try { ws.close(); } catch {} resolve(v); };
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === 1) finish(msg.result || null);
      } catch { finish(null); }
    });
    ws.on('error', () => finish(null));
    setTimeout(() => finish(null), 3000);
  });
}

/**
 * Read cookies from the CPQ iframe target using CDP Network.getCookies.
 * CDP's browser-level getCookies returns nothing here — cookies are only
 * visible to a debugger attached to the frame that owns them (partitioned
 * cookie storage). So we ask the CPQ iframe target directly.
 */
async function cdpGetCpqCookies(WSClass, cpqTargetWsUrl) {
  const result = await cdpCall(WSClass, cpqTargetWsUrl, 'Network.getCookies', {
    urls: [`${CPQ_ORIGIN}/`],
  });
  return result?.cookies || [];
}

/** Read window.csrfToken from the given CPQ iframe target ws URL. */
async function readCsrfFromCpqTarget(WSClass, cpqTargetWsUrl) {
  const result = await cdpCall(WSClass, cpqTargetWsUrl, 'Runtime.evaluate', {
    expression: 'typeof window.csrfToken === "string" ? window.csrfToken : null',
    returnByValue: true,
  });
  const v = result?.result?.value;
  return typeof v === 'string' && v.length > 20 ? v : null;
}

// ── Public: auth + fetch ─────────────────────────────────────────────────────

/**
 * Assemble the CPQ auth context: Cookie header + real X-CSRF-Token header value.
 * Cached for 60s to avoid repeatedly hitting Chrome.
 */
export async function cpqAuthContext({ force = false } = {}) {
  const now = Date.now();
  if (!force && _authCache && now - _authCacheAt < AUTH_TTL_MS) return _authCache;

  // 1. Enumerate targets and find the CPQ Cart.aspx iframe (also implicitly
  //    checks that Chrome is running on :9222).
  let cpqTarget;
  try {
    const targets = await cdpListTargets();
    cpqTarget = targets.find(t =>
      (t.url || '').includes(CPQ_HOST) && (t.url || '').includes('Cart.aspx')
    );
  } catch (e) {
    throw new Error(
      `CPQ direct calls require a running Chrome on ${CDP_URL} that has already ` +
      'logged into Harmony. Start Chrome with `--remote-debugging-port=9222 ' +
      '--user-data-dir=/tmp/chrome-cdp-harmony` and open the Harmony URL first. ' +
      `Underlying: ${e.message}`
    );
  }
  if (!cpqTarget) {
    throw new Error(
      'CPQ Cart.aspx iframe target not found on :9222. Open the Harmony quote URL ' +
      '(https://sapit-home-prod-004.launchpad.cfapps.eu10.hana.ondemand.com/site#harmonyquote-Display&/Opportunity/<OPP>/Quotedetails/<QUOTE> for CPQ 1.0, or .../Quote2details/<QUOTE> for CPQ 2.0) ' +
      'in the CDP Chrome first, and wait until the CPQ iframe finishes loading.'
    );
  }

  const wsMod = await import(await resolveBundledWs());
  const WSClass = wsMod.WebSocket || wsMod.default;
  const wsUrl = cpqTarget.webSocketDebuggerUrl;

  // 2. Read CPQ cookies (target-scoped — CPQ cookies aren't visible at the
  //    browser level due to partitioned storage).
  const cookies = await cdpGetCpqCookies(WSClass, wsUrl);
  if (cookies.length === 0) {
    throw new Error(
      `No cookies for ${CPQ_HOST} in the connected Chrome. ` +
      'Complete Harmony UI login first (the quote page must render the CPQ iframe).'
    );
  }
  const required = ['SAML_Session', 'ASP.NET_SessionId'];
  const names = new Set(cookies.map(c => c.name));
  const missing = required.filter(r => !names.has(r));
  if (missing.length) {
    throw new Error(`CPQ cookies missing: ${missing.join(', ')}. Complete Harmony UI login first.`);
  }
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  // 3. Read the real CSRF token from the iframe's window.csrfToken
  const csrf = await readCsrfFromCpqTarget(WSClass, wsUrl);
  if (!csrf) {
    throw new Error(
      'Found CPQ cookies but no window.csrfToken in the CPQ iframe. ' +
      'The Harmony quote page must be fully loaded (CPQ iframe visible and hydrated).'
    );
  }

  const record = {
    cookieHeader, csrf,
    samlSessionSet: names.has('SAML_Session'),
    cookieCount: cookies.length,
    readAt: new Date().toISOString(),
  };
  _authCache = record;
  _authCacheAt = now;
  return record;
}

/**
 * Low-level CPQ-direct fetch. Auto-attaches Cookie + CSRF headers and mimics
 * the browser's Origin/Referer that CPQ's CORS policy requires.
 * Returns { ok, status, contentType, bodyText, bodyJson? }.
 */
export async function cpqFetch(path, { method = 'POST', body, contentType, extraHeaders } = {}) {
  const ctx = await cpqAuthContext();
  const url = path.startsWith('http') ? path : `${CPQ_ORIGIN}${path.startsWith('/') ? '' : '/'}${path}`;
  const headers = {
    'Cookie': ctx.cookieHeader,
    'Accept': 'application/json',
    'Origin': CPQ_ORIGIN,
    'Referer': `${CPQ_ORIGIN}/quotation/Cart.aspx`,
    'X-Requested-With': 'XMLHttpRequest',
    'X-CSRF-Token': ctx.csrf,
    ...(extraHeaders || {}),
  };
  if (contentType) headers['Content-Type'] = contentType;
  else if (body && typeof body === 'object') { headers['Content-Type'] = 'application/json'; }
  else if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; }

  const init = { method, headers };
  if (body) init.body = typeof body === 'string' ? body : JSON.stringify(body);

  const res = await fetch(url, init);
  const ct = res.headers.get('content-type') || '';
  const bodyText = await res.text();
  let bodyJson;
  if (ct.includes('application/json')) {
    try { bodyJson = JSON.parse(bodyText); } catch {}
  }
  return { ok: res.ok, status: res.status, contentType: ct, bodyText, bodyJson };
}

// ── High-level tools ─────────────────────────────────────────────────────────

/**
 * CPQ-direct script call.
 *   POST /CustomAPI/ExecuteScript
 *   Body: scriptName=<name>&quoteId=<shortId>&param=<url-encoded JSON>
 *
 * `shortQuoteId` is the numeric tail of the composite (e.g. 1205 for 028981001205).
 * If you pass a composite (9+ digits), it's auto-shortened.
 */
export async function cpqScript(scriptName, shortQuoteId, param) {
  const qid = /^\d{9,}$/.test(String(shortQuoteId))
    ? String(shortQuoteId).replace(/^0+/, '').slice(-4)
    : String(shortQuoteId);
  const body = new URLSearchParams({
    scriptName, quoteId: qid,
    param: JSON.stringify(param ?? {}),
  }).toString();
  return cpqFetch('/CustomAPI/ExecuteScript', {
    method: 'POST',
    contentType: 'application/x-www-form-urlencoded',
    body,
  });
}

/**
 * Change QuoteTable cells — the structured "edit a field" contract that
 * bypasses OData MERGE's whole-entity validation.
 */
export async function cartChangeCells(shortQuoteId, tabId, dirtyQuoteTables, itemsFilterQuery = []) {
  const qs = new URLSearchParams({ tabId: String(tabId), reduced: 'false', quoteId: String(shortQuoteId) });
  return cpqFetch(`/api/rd/v1/Cart/ChangeQuoteTableCells?${qs}`, {
    method: 'POST',
    body: { dirtyQuoteTables, itemsFilterQuery, quoteTableFilters: null },
  });
}

/**
 * Trigger a CPQ Cart action by numeric actionId. actionId ↔ UI operation map
 * lives in CPQ_REVERSE_ENGINEERING.md.
 */
export async function cartExecuteAction(shortQuoteId, actionId, payload = {}) {
  const qs = new URLSearchParams({ actionId: String(actionId), quoteId: String(shortQuoteId) });
  return cpqFetch(`/api/rd/v1/Cart/ExecuteAction?${qs}`, {
    method: 'POST',
    body: {
      GroupToActivate: 1,
      DirtyCells: {},
      DirtyCustomFields: {},
      ItemsFilterQuery: [],
      ...payload,
    },
  });
}

/**
 * Activate a Cart editable group. Non-default groups (anything other than
 * group 1) must be activated before their DirtyCells can be persisted in a
 * subsequent ExecuteAction(19). Passing GroupToActivate=N in the Save payload
 * alone is NOT sufficient — the UI issues this dedicated call first.
 *
 * Observed pattern (Net Price edit for CL_AnnualNetBeforeUplift_N, group 2):
 *   1. POST /Cart/SetActiveEditableGroup?editableGroup=2
 *      Body: {itemsFilterQuery: [...collapse state...], quoteTablefilters: null}
 *   2. POST /Cart/Calculate  Body: {GroupToActivate:2, DirtyCells:{...}, ...}
 *   3. POST /Cart/ExecuteAction?actionId=19
 *      Body: {GroupToActivate:2, DirtyCells:{}, ...}   ← empty; dirty state
 *      is server-side sticky between steps 2 and 3.
 */
export async function cartSetActiveEditableGroup(shortQuoteId, editableGroup, itemsFilterQuery = []) {
  const qs = new URLSearchParams({ editableGroup: String(editableGroup), quoteId: String(shortQuoteId) });
  return cpqFetch(`/api/rd/v1/Cart/SetActiveEditableGroup?${qs}`, {
    method: 'POST',
    body: { itemsFilterQuery, quoteTablefilters: null },
  });
}

/**
 * Cart/Calculate — dry-run: apply DirtyCells / DirtyCustomFields to compute
 * a preview of the cart state without persisting. Same payload shape as
 * ExecuteAction(19). Used by CPQ on every keystroke in a Cart cell.
 *
 * ⚠️ Calculate DOES have a side effect for non-default editable groups: the
 * dirty state it accepts becomes server-side sticky, so the subsequent
 * ExecuteAction(19) will Save it even with an empty DirtyCells map. See
 * cartSetActiveEditableGroup docstring for the full sequence.
 */
export async function cartCalculate(shortQuoteId, payload = {}) {
  const qs = new URLSearchParams({ quoteId: String(shortQuoteId) });
  return cpqFetch(`/api/rd/v1/Cart/Calculate?${qs}`, {
    method: 'POST',
    body: {
      GroupToActivate: 1,
      DirtyCells: {},
      DirtyCustomFields: {},
      ItemsFilterQuery: [],
      QuoteTableFilters: null,
      ...payload,
    },
  });
}

/** Add a configured product to the current quote. */
export async function configuratorAddToQuote(payload) {
  return cpqFetch('/api/rd/v1/Configurator/AddToQuote', {
    method: 'POST',
    body: payload,
  });
}

// ── Headed session launcher ────────────────────────────────────────────────
//
// Launches (or reuses) the headed Chrome on :9222 that every CPQ-direct / Cart
// tool depends on. It CANNOT log the user in — the Harmony SAML SSO flow is
// interactive (credentials + possibly MFA). This just gets a browser window
// pointed at the right URL; the user completes auth by hand.

/**
 * Build the Harmony launchpad URL, deep-linking to an opp (and optionally a
 * quote) when ids are supplied. Quote deep-link requires both ids.
 */
function buildHarmonyUrl({ oppId, quoteId } = {}) {
  if (oppId && quoteId) {
    // CPQ 2.0 quotes use composite prefix 509184; CPQ 1.0 uses 028981.
    // The launchpad route segment differs: Quote2details vs Quotedetails.
    const segment = String(quoteId).startsWith('509184') ? 'Quote2details' : 'Quotedetails';
    return `${HARMONY_BASE_URL}&/Opportunity/${oppId}/${segment}/${quoteId}`;
  }
  if (oppId) {
    return `${HARMONY_BASE_URL}&/Opportunity/${oppId}`;
  }
  return HARMONY_BASE_URL;
}

/** True if a CDP-enabled Chrome is answering on :9222. */
async function isChromeUp() {
  try {
    await cdpListTargets();
    return true;
  } catch {
    return false;
  }
}

/** Poll cdpListTargets() until it answers or the deadline passes. */
async function waitForCdp(timeoutMs = 15_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isChromeUp()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

/** Spawn the headed Chrome for the current platform, detached. */
async function spawnChrome(url) {
  const { spawn } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const flags = [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${USER_DATA_DIR}`, url];

  let cmd, cmdArgs;
  if (process.platform === 'darwin') {
    cmd = 'open';
    cmdArgs = ['-na', 'Google Chrome', '--args', ...flags];
  } else if (process.platform === 'win32') {
    const candidates = [
      `${process.env['ProgramFiles']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['LocalAppData']}\\Google\\Chrome\\Application\\chrome.exe`,
    ].filter(Boolean);
    const bin = candidates.find(p => existsSync(p));
    if (!bin) throw new Error('Chrome executable not found. Checked: ' + candidates.join(', '));
    cmd = bin;
    cmdArgs = flags;
  } else {
    // linux
    const bins = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
    // Resolve the first that exists on PATH via `which`.
    const { execSync } = await import('node:child_process');
    let bin;
    for (const b of bins) {
      try { execSync(`command -v ${b}`, { stdio: 'ignore' }); bin = b; break; } catch {}
    }
    if (!bin) throw new Error('No Chrome/Chromium binary found on PATH. Tried: ' + bins.join(', '));
    cmd = bin;
    cmdArgs = flags;
  }

  const child = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' });
  child.unref();
}

/** Open a new tab at `url` in the already-running Chrome via CDP. */
async function openTab(url) {
  const http = await import('node:http');
  const target = `${CDP_URL}/json/new?${encodeURIComponent(url)}`;
  return new Promise((resolve, reject) => {
    // Chrome's /json/new accepts the URL as a query string (older builds) or in
    // the path. PUT is required on newer builds; fall back to GET.
    const req = http.request(target, { method: 'PUT' }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', () => {
      http.get(target, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); })
        .on('error', reject);
    });
    req.end();
  });
}

/**
 * Find an existing page target whose URL EXACTLY matches `url` (hash included —
 * Harmony's route lives entirely in the `#...` fragment, so we must compare it).
 * Returns the CDP target object, or null.
 */
async function findTabByUrl(url) {
  let targets;
  try { targets = await cdpListTargets(); } catch { return null; }
  return targets.find(t => t.type === 'page' && t.url === url) || null;
}

/** Bring a target to the foreground via CDP HTTP endpoint. */
async function activateTarget(targetId) {
  const http = await import('node:http');
  return new Promise((resolve) => {
    http.get(`${CDP_URL}/json/activate/${targetId}`, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', () => resolve(null));
  });
}

/** Re-navigate an existing target to `url` (a refresh) via Page.navigate. */
async function navigateTarget(wsUrl, url) {
  const wsMod = await import(await resolveBundledWs());
  const WSClass = wsMod.WebSocket || wsMod.default;
  await cdpCall(WSClass, wsUrl, 'Page.navigate', { url });
}

/**
 * Ensure a headed :9222 Chrome is running for Harmony, optionally deep-linked
 * to an opp/quote. Returns a status object describing what happened and what
 * the user must still do (log in). Never kills or disrupts an existing session.
 *
 * De-dup: if a tab is already open at the EXACT target URL, reuse it (bring to
 * front + re-navigate) instead of piling up duplicate tabs. Only opens a new
 * tab when no matching one exists.
 */
export async function openSession({ oppId, quoteId } = {}) {
  const url = buildHarmonyUrl({ oppId, quoteId });
  const alreadyRunning = await isChromeUp();

  if (alreadyRunning) {
    const existing = await findTabByUrl(url);
    if (existing) {
      // Reuse: activate the tab and re-navigate (refresh) it.
      await activateTarget(existing.id).catch(() => {});
      let reNavigated = false;
      if (existing.webSocketDebuggerUrl) {
        try { await navigateTarget(existing.webSocketDebuggerUrl, url); reNavigated = true; } catch {}
      }
      return {
        alreadyRunning: true,
        launched: false,
        cdpReady: true,
        url,
        reusedTab: true,
        openedTab: false,
        reNavigated,
        note: 'Reused an existing tab already at this URL (brought to front' +
          (reNavigated ? ' and refreshed' : '') + '). No duplicate tab opened.',
      };
    }
    // No matching tab — open a new one.
    let openedTab = false;
    try { await openTab(url); openedTab = true; } catch {}
    return {
      alreadyRunning: true,
      launched: false,
      cdpReady: true,
      url,
      reusedTab: false,
      openedTab,
      note: openedTab
        ? 'Chrome was already running; opened this URL in a new tab. Complete SSO if prompted.'
        : 'Chrome was already running but the tab could not be opened via CDP. Open this URL manually.',
    };
  }

  await spawnChrome(url);
  const cdpReady = await waitForCdp();
  return {
    alreadyRunning: false,
    launched: true,
    cdpReady,
    url,
    reusedTab: false,
    note: cdpReady
      ? 'Launched Chrome on :9222 at the Harmony URL. Complete the SAP SSO login in that window, then CPQ tools will work. (This tool cannot log you in — SSO is interactive.)'
      : 'Launched Chrome but the :9222 debug port did not respond within 15s. It may still be starting; re-check with harmony_cpq_auth_check once you have logged in.',
  };
}
