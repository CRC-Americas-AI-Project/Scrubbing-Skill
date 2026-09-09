// Shared CDP/Playwright browser helpers for the SAP Harmony servers.
//
// Extracted from mcp-server.mjs so both the business server (sap-harmony-mcp,
// which needs connectCdpBrowser + dismissKnownDialogs for harmony_open_session's
// popup sweep) and the devtools server (sap-harmony-devtools-mcp, which needs all
// of these for probe/sweep/verify) share one source of truth.
//
// This file stays physically inside sap-harmony-mcp/src/ so getPlaywright's
// relative fallback into the sibling playwright-mcp bundle keeps resolving.
// Node resolves import.meta.url to the realpath even when this module is loaded
// through the workspace symlink (node_modules/sap-harmony-mcp -> ../packages/...),
// so the `../../playwright-mcp/...` math is correct from either importer.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { existsSync } from 'node:fs';

// ── Optional Playwright (only the devtools probe/sweep + open_session need it) ─
// Lazy-loaded, and we reach into the sibling playwright-mcp's node_modules so
// this package doesn't have to declare its own copy of Playwright.
export const CDP_URL = 'http://127.0.0.1:9222';
let _playwright = null;
export async function getPlaywright() {
  if (_playwright) return _playwright;
  // 1. Try normal resolution (works if playwright is in this package's node_modules).
  try { _playwright = await import('playwright'); return _playwright; } catch {}
  // 2. Fall back to the sibling playwright-mcp bundle — resolve relative to this file.
  const here = dirname(fileURLToPath(import.meta.url));                  // .../sap-harmony-mcp/src
  const sibling = pathResolve(here, '..', '..', 'playwright-mcp', 'node_modules', 'playwright');
  const entry = pathResolve(sibling, 'index.mjs');
  if (existsSync(entry)) {
    try { _playwright = await import(pathToFileURL(entry).href); return _playwright; }
    catch (e) { throw new Error(`Playwright found at ${entry} but failed to import: ${e.message}`); }
  }
  throw new Error(
    'Playwright not found. The harmony devtools (and open_session popup sweep) need it. ' +
    'Either `npm install playwright` in packages/servers/sap-harmony-mcp, ' +
    `or ensure the sibling playwright-mcp is installed. Looked at: ${entry}`
  );
}

export async function connectCdpBrowser() {
  const { chromium } = await getPlaywright();
  try {
    return await chromium.connectOverCDP(CDP_URL);
  } catch (e) {
    throw new Error(
      `Chrome CDP not reachable at ${CDP_URL}. ` +
      'This tool needs a Chrome started with --remote-debugging-port=9222. ' +
      `Underlying error: ${e.message}`
    );
  }
}

export function pickPrimaryPage(context) {
  const pages = context.pages();
  if (pages.length === 0) throw new Error('No page in the connected Chrome');
  return pages.find((p) => /harmonyquote|cfapps\.eu10|budgie/i.test(p.url())) || pages[0];
}

// Best-effort dismisser for the blocker popups the user hits daily:
//  1. WalkMe / UI5 announcement popups (e.g. "Scheduled Maintenance - BWP")
//     — rendered as <ui5-button> Web Components INSIDE a shadow root, with the
//     label in aria-label and empty text content. CSS `:text-is()` cannot reach
//     these (shadow-encapsulated + no text node). Verified 2026-07-11.
//  2. CPQ "Warning: quote already open in another tab/window" — a UI5 modal
//     that blocks every iframe click until dismissed.
//
// Strategy: Playwright's getByRole('button', {name, exact:true}) — it pierces
// shadow DOM and matches the ACCESSIBLE NAME (so it catches aria-label-only
// buttons the CSS approach missed), while `exact:true` keeps us from ever
// clicking "Yes, delete all" / "Discard changes". Destructive verbs are not in
// the label set. Runs across EVERY page in the context (the maintenance popup
// appears on all open Deal tabs) plus each page's frames (the CPQ warning lives
// in the budgie iframe).
export const DISMISS_LABELS = ['Yes', 'OK', 'Ok', 'Continue', 'Close', 'Accept', 'Got it', 'Confirm'];
export async function dismissKnownDialogs(context, { maxTries = 3, log = () => {} } = {}) {
  const dismissed = { count: 0 };
  const clicked = [];

  // Roots to search: every page + every page's frames.
  const roots = () => {
    const out = [];
    for (const page of context.pages()) {
      out.push(page);
      for (const f of page.frames()) out.push(f);
    }
    return out;
  };

  for (let attempt = 0; attempt < maxTries; attempt++) {
    let hitThisRound = false;
    for (const root of roots()) {
      for (const label of DISMISS_LABELS) {
        try {
          const btn = root.getByRole('button', { name: label, exact: true }).first();
          if (!(await btn.isVisible({ timeout: 250 }).catch(() => false))) continue;
          await btn.click({ timeout: 1500 }).catch(() => {});
          await new Promise((r) => setTimeout(r, 700));
          // Only count it if the button actually went away — a click that
          // doesn't dismiss would otherwise re-match and inflate the count.
          const stillThere = await btn.isVisible({ timeout: 250 }).catch(() => false);
          if (stillThere) {
            log(`clicked "${label}" but it persisted — leaving it (attempt ${attempt + 1})`);
            continue;
          }
          dismissed.count += 1;
          clicked.push(label);
          hitThisRound = true;
          log(`dismissed "${label}" popup (attempt ${attempt + 1})`);
        } catch {
          /* frame/page detached mid-check — ignore */
        }
      }
    }
    if (!hitThisRound) break;
  }
  return { dismissed: dismissed.count, clicked };
}
