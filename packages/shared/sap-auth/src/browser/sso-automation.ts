/**
 * SSO automation utilities
 * Handles automated Microsoft SSO authentication flow
 */

import { Page } from 'puppeteer';
import { extractErrorMessage, delay } from 'mcp-utils';
import { createLogger } from 'mcp-logger';
import { isLoginUrl, checkForAuthenticatorNumber, handleAutomaticPrompts, isSsoDomain, tryClickFirst } from './auth-flows.js';
import { saveDebugSnapshot } from './debug-snapshot.js';

const log = createLogger('sap-auth', 'sso');

// ============================================================================
// Constants
// ============================================================================
const ELEMENT_SEARCH_TIMEOUT_MS = 10000;
const EMAIL_INPUT_TIMEOUT_MS = 15000;
const SUBMIT_CLICK_TIMEOUT_MS = 10000;
const POST_SUBMIT_DELAY_MS = 3000;
const REDIRECT_CONFIRMATION_DELAY_MS = 3000;
const ACCOUNT_RENDER_POLL_TIMEOUT_MS = 15000;
const ACCOUNT_RENDER_POLL_INTERVAL_MS = 1000;
const PAGE_CONTENT_TIMEOUT_MS = 5000;
const REDIRECT_POLL_INTERVAL_MS = 2000;
const REDIRECT_POLL_MAX_MS = 15000;
const AUTHENTICATOR_POLL_INTERVAL_MS = 3000;
const AUTHENTICATOR_POLL_MAX_MS = 90000;
const AUTHENTICATOR_PROGRESS_LOG_INTERVAL_MS = 15000;

/** Selectors for enterprise SSO trigger links on login pages. */
const ENTERPRISE_LOGIN_SELECTORS = [
  'a[href*="force_external=true"]', // GitHub Enterprise License
  'a[href*="/saml/"]',              // SAML SSO trigger
];

/**
 * Authentication attempt result
 */
export interface AuthAttemptResult {
  success: boolean;
  needsUserInteraction: boolean;
}

/**
 * Attempt headless authentication (email clicking, etc.)
 * Detects when user interaction is needed, including certificate selection dialogs
 */
export async function attemptHeadlessAuth(
  page: Page,
  domain: string,
  userEmail: string | undefined,
  forceManualFallback: boolean,
): Promise<AuthAttemptResult> {
  // Check if we should force manual fallback for testing
  if (forceManualFallback) {
    log.info('FORCE_MANUAL_FALLBACK enabled - skipping automation');
    return { success: false, needsUserInteraction: true };
  }

  try {
    // First, try to get the current URL with a timeout to detect cert selection hangs
    let currentUrl: string;
    try {
      currentUrl = page.url();
    } catch (urlError) {
      // If we can't even get the URL, something is blocking (possibly cert dialog)
      log.warn('Cannot access page URL - possible certificate selection dialog');
      return { success: false, needsUserInteraction: true };
    }

    // 1. Already on target? Done.
    if (currentUrl.includes(domain) && !isLoginUrl(currentUrl)) {
      return { success: true, needsUserInteraction: false };
    }

    // 1b. On a login page for the target domain? Try enterprise SSO links.
    if (currentUrl.includes(domain) && isLoginUrl(currentUrl)) {
      const clicked = await tryClickFirst(page, ENTERPRISE_LOGIN_SELECTORS);
      if (clicked) {
        await waitForRedirectFromLogin(page, domain);
        const postUrl = page.url();
        if (postUrl.includes(domain) && !isLoginUrl(postUrl)) {
          log.info('Enterprise login completed successfully');
          return { success: true, needsUserInteraction: false };
        }
        // May have redirected to SSO — update URL and fall through
        currentUrl = postUrl;
      }
    }

    // 2. Not on a known SSO domain? Can't automate.
    if (!isSsoDomain(currentUrl)) {
      log.info('Not on a known SSO page');
      return { success: false, needsUserInteraction: true };
    }

    // 3. On non-Microsoft SSO (e.g. accounts.sap.com SAML) — wait for redirect chain.
    if (!currentUrl.includes('microsoftonline.com')) {
      log.info('On SSO domain — waiting for redirect...');
      await waitForRedirectFromSso(page);

      const postUrl = page.url();
      if (postUrl.includes(domain) && !isLoginUrl(postUrl)) {
        log.info('SSO redirect completed successfully');
        return { success: true, needsUserInteraction: false };
      }

      // Redirect may chain to microsoftonline.com — fall through to MS automation
      if (postUrl.includes('microsoftonline.com')) {
        currentUrl = postUrl;
      } else if (postUrl.includes('accounts.sap.com')) {
        // SAP IDP showed a login form — fall through to email/password automation below
        log.info('SAP IDP login form detected — attempting form fill');
        currentUrl = postUrl;
        // Don't return here — fall through to the email input automation at step 4
      } else {
        log.info('SSO redirect did not reach target — needs user interaction');
        return { success: false, needsUserInteraction: true };
      }
    }

    // 4. On microsoftonline.com or SAP IDP login form — proceed with automation

    // Look for email input field with timeout
    // Supports both Microsoft SSO (input[type="email"]) and SAP IDP (#j_username type="text")
    let emailInput;
    try {
      emailInput = await Promise.race([
        page.$('input[type="email"], #j_username'),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error('Element search timeout')), ELEMENT_SEARCH_TIMEOUT_MS),
        ),
      ]);
    } catch (timeoutError) {
      log.warn('Timeout searching for email input - possible certificate selection dialog');
      return { success: false, needsUserInteraction: true };
    }

    if (emailInput) {
      if (!userEmail) {
        log.warn('No SAP_AUTH_ACCOUNT set, need visible browser for email input');
        return { success: false, needsUserInteraction: true };
      }

      log.info(`Filling email input with: ${userEmail}`);

      // Fill email with timeout protection
      try {
        await Promise.race([
          (async () => {
            await (emailInput as any).click();
            await (emailInput as any).evaluate((el: HTMLInputElement) => (el.value = ''));
            await (emailInput as any).type(userEmail);
          })(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('Email input timeout')), EMAIL_INPUT_TIMEOUT_MS),
          ),
        ]);
      } catch (inputError) {
        log.warn('Timeout during email input - possible certificate dialog blocking');
        return { success: false, needsUserInteraction: true };
      }

      // Click submit with timeout protection
      try {
        const submitButton =
          (await page.$('input[type="submit"]')) ||
          (await page.$('button[type="submit"]')) ||
          (await page.$('#idSIButton9')) ||
          (await page.$('#logOnFormSubmit'));  // SAP IDP "Continue" button

        if (submitButton) {
          log.info('Clicking submit button...');
          await Promise.race([
            submitButton.click(),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('Submit click timeout')), SUBMIT_CLICK_TIMEOUT_MS),
            ),
          ]);
          await delay(POST_SUBMIT_DELAY_MS);
          // Snapshot após o Continue para diagnóstico
          await saveDebugSnapshot(page, 'after-continue');
          log.info(`URL after Continue: ${page.url()}`);

          // Detect SAP IDP password field (conditional_logon page after email submit)
          const passwordInput = await page.$('#j_password, input[type="password"]').catch(() => null);
          if (passwordInput) {
            const password = process.env.SAP_AUTH_PASSWORD;
            if (!password) {
              log.warn('SAP IDP requires password but SAP_AUTH_PASSWORD env var is not set');
            } else {
              log.info('SAP IDP password field detected — filling password');
              await (passwordInput as any).click();
              await (passwordInput as any).evaluate((el: HTMLInputElement) => (el.value = ''));
              await (passwordInput as any).type(password);
              const pwSubmit =
                (await page.$('#logOnFormSubmit')) ||
                (await page.$('button[type="submit"]')) ||
                (await page.$('input[type="submit"]'));
              if (pwSubmit) {
                log.info('Clicking password submit button...');
                await (pwSubmit as any).click();
                await delay(POST_SUBMIT_DELAY_MS);
                log.info(`URL after password submit: ${page.url()}`);

                // Detect 2FA choice page (RADIUS / WEB / TOTP)
                const radiusButton = await page.$('#tfaChoiceRsaButton').catch(() => null);
                const webButton = await page.$('[name="tfaChoiceWeb"], #tfaChoiceWebButton, [id*="web" i][type="submit"], button[name*="web" i]').catch(() => null)
                  ?? await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
                    return btns.find(b => b.textContent?.toLowerCase().includes('web')) ? true : null;
                  }).catch(() => null);

                if (webButton && webButton !== true) {
                  // Prefer WEB 2FA — uses Microsoft Authenticator push (automated via waitForAuthenticatorApproval)
                  log.info('SAP IDP 2FA choice detected — clicking WEB button (Authenticator push)');
                  await (webButton as any).click();
                  await delay(POST_SUBMIT_DELAY_MS);
                  log.info(`URL after WEB choice: ${page.url()}`);
                  await saveDebugSnapshot(page, 'after-web-choice');
                } else if (webButton === true) {
                  // Found via text search — click by text
                  log.info('SAP IDP 2FA choice detected — clicking WEB button by text');
                  await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
                    const btn = btns.find(b => b.textContent?.toLowerCase().includes('web')) as HTMLElement;
                    if (btn) btn.click();
                  });
                  await delay(POST_SUBMIT_DELAY_MS);
                  log.info(`URL after WEB choice: ${page.url()}`);
                  await saveDebugSnapshot(page, 'after-web-choice');
                } else if (radiusButton) {
                  log.info('SAP IDP 2FA choice detected — clicking RADIUS button');
                  await (radiusButton as any).click();
                  await delay(POST_SUBMIT_DELAY_MS);
                  log.info(`URL after RADIUS choice: ${page.url()}`);
                  await saveDebugSnapshot(page, 'after-radius-choice');
                }
              }
            }
          }
        }
      } catch (submitError) {
        log.warn('Timeout during submit - possible certificate dialog blocking');
        return { success: false, needsUserInteraction: true };
      }
    }

    // Look for account selection with timeout protection
    const accountClicked = await tryAccountSelection(page, userEmail);

    // Check for MFA/authenticator number
    const authenticatorNumber = await checkForAuthenticatorNumber(page);
    if (authenticatorNumber) {
      log.info(`\n========================================`);
      log.info(`  MS Authenticator: approve number ${authenticatorNumber} on your device`);
      log.info(`========================================\n`);

      const approvalResult = await waitForAuthenticatorApproval(page, domain);
      if (approvalResult.success) {
        // Approval detected — handle any post-auth prompts and continue
        await handleAutomaticPrompts(page);
        return { success: true, needsUserInteraction: false };
      }
      if (approvalResult.needsUserInteraction) {
        return { success: false, needsUserInteraction: true };
      }
    }

    // Handle automatic prompts ("Stay signed in?", etc.)
    await handleAutomaticPrompts(page);

    // Poll for redirect instead of flat sleep (Improvement 4)
    await waitForRedirectFromSso(page);

    let newUrl: string;
    try {
      newUrl = page.url();
    } catch {
      log.warn('Cannot access page URL after auth attempt - possible certificate dialog');
      return { success: false, needsUserInteraction: true };
    }

    const isOnTarget = newUrl.includes(domain) && !isLoginUrl(newUrl);

    if (isOnTarget) {
      // Wait to confirm (SSO sometimes has double redirects)
      await delay(REDIRECT_CONFIRMATION_DELAY_MS);
      const confirmedUrl = page.url();
      const stillOnTarget = confirmedUrl.includes(domain) && !isLoginUrl(confirmedUrl);

      if (stillOnTarget) {
        log.info('SSO completed successfully');
        return { success: true, needsUserInteraction: false };
      }

      // Double-redirect detected: we reached target but got bounced back to SSO.
      // Try clicking the account again on the current page before giving up.
      log.info('Double-redirect detected — attempting re-click on second SSO page...');
      const secondAttempt = await tryAccountSelection(page, userEmail);
      if (secondAttempt) {
        // Re-check URL after second attempt
        const urlAfterRetry = page.url();
        if (urlAfterRetry.includes(domain) && !isLoginUrl(urlAfterRetry)) {
          await delay(REDIRECT_CONFIRMATION_DELAY_MS);
          const confirmedRetryUrl = page.url();
          if (confirmedRetryUrl.includes(domain) && !isLoginUrl(confirmedRetryUrl)) {
            log.info('SSO completed successfully after double-redirect re-click');
            return { success: true, needsUserInteraction: false };
          }
        }
      }
      log.warn('Double-redirect re-click did not resolve — needs user interaction');
      return { success: false, needsUserInteraction: true };
    }

    // Still on login page - check for MFA or other requirements
    const needsInteraction = await checkNeedsUserInteraction(page);

    if (needsInteraction) {
      log.warn('Additional authentication steps required');
      await saveDebugSnapshot(page, 'sso-needs-interaction');
      return { success: false, needsUserInteraction: true };
    }

    await saveDebugSnapshot(page, 'sso-auth-incomplete');
    return { success: false, needsUserInteraction: true };
  } catch (error) {
    const errorMessage = extractErrorMessage(error);
    log.error(`Headless auth failed: ${errorMessage}`);

    // Check for common certificate-related error patterns
    const certRelatedPatterns = [
      'timeout',
      'navigation',
      'net::ERR_',
      'SSL',
      'certificate',
      'TLS',
      'handshake',
      'connection refused',
      'ERR_CERT_',
      'ERR_SSL_',
    ];

    const isCertRelated = certRelatedPatterns.some((pattern) =>
      errorMessage.toLowerCase().includes(pattern.toLowerCase()),
    );

    if (isCertRelated) {
      log.warn('Error may be related to certificate selection or SSL handshake');
    }

    await saveDebugSnapshot(page, 'sso-auth-error');
    return { success: false, needsUserInteraction: true };
  }
}

/**
 * Try to select an account from the account picker.
 *
 * Microsoft's SSO page uses Knockout.js which may still be rendering account
 * tiles after `networkidle2` fires.  We poll for up to 15 seconds for either
 * an account tile or an email input field to appear.
 *
 * Returns true if an account was clicked successfully, false otherwise.
 */
async function tryAccountSelection(page: Page, userEmail: string | undefined): Promise<boolean> {
  log.info('Waiting for account tiles or email input to render...');

  let accountElement: any = null;
  let usedSelector = '';

  const renderPollStart = Date.now();

  while (Date.now() - renderPollStart < ACCOUNT_RENDER_POLL_TIMEOUT_MS) {
    // Check for email input field (means we should stop looking for tiles)
    const emailInput = await page.$('input[type="email"], #j_username');
    if (emailInput) {
      log.info(`SSO page render wait: ${Math.round((Date.now() - renderPollStart) / 1000)}s — email input found`);
      return false;
    }

    // Check for account tiles — specific email first, then general
    if (userEmail) {
      const specificSelectors = [
        `div[data-test-id*="${userEmail}"]`,
        `div[title*="${userEmail}"]`,
        `button[data-test-id*="${userEmail}"]`,
      ];
      for (const selector of specificSelectors) {
        try {
          const elements = await page.$$(selector);
          for (const element of elements) {
            const text = await element.evaluate((el: Element) => el.textContent || '');
            if (text.includes(userEmail)) {
              accountElement = element;
              usedSelector = selector;
              break;
            }
          }
          if (accountElement) break;
        } catch {
          // Continue
        }
      }
    }

    if (!accountElement) {
      const generalSelectors = [
        '.table-row',
        '[data-test-id*="@"]',
        'div[title*="@"]',
        'button[data-test-id*="@"]',
        '.ms-List-cell',
        '.ms-Persona-primaryText',
      ];
      for (const selector of generalSelectors) {
        try {
          const elements = await page.$$(selector);
          for (const element of elements) {
            const text = await element.evaluate((el: Element) => el.textContent || '');
            if (text.includes('@') && (text.includes('sap.com') || text.includes('.com'))) {
              accountElement = element;
              usedSelector = selector;
              break;
            }
          }
          if (accountElement) break;
        } catch {
          // Continue
        }
      }
    }

    if (accountElement) break;
    await delay(ACCOUNT_RENDER_POLL_INTERVAL_MS);
  }

  log.info(`SSO page render wait: ${Math.round((Date.now() - renderPollStart) / 1000)}s`);

  if (!accountElement) {
    log.warn('No account tile found for auto-selection');
    await saveDebugSnapshot(page, 'sso-no-account-tile');
    return false;
  }

  // Click the account tile
  log.info(`Clicking account (selector: ${usedSelector})...`);
  try {
    await page.evaluate((el: Element) => el.scrollIntoView(), accountElement);
    await delay(1000);
    await accountElement.click();
    log.info('Account clicked successfully');
  } catch {
    log.warn('Failed to click account tile');
    return false;
  }

  // Poll for redirect instead of flat sleep
  await waitForRedirectFromSso(page);
  return true;
}

/**
 * Poll every 2 seconds for up to 15 seconds waiting for the URL to leave
 * the SSO domains (microsoftonline.com and accounts.sap.com).
 */
async function waitForRedirectFromSso(page: Page): Promise<void> {
  const pollStart = Date.now();
  while (Date.now() - pollStart < REDIRECT_POLL_MAX_MS) {
    await delay(REDIRECT_POLL_INTERVAL_MS);
    if (!isSsoDomain(page.url())) {
      log.info(`Redirect completed in ${Math.round((Date.now() - pollStart) / 1000)}s`);
      return;
    }
  }
  log.warn(`Redirect poll timed out after ${Math.round(REDIRECT_POLL_MAX_MS / 1000)}s`);
}

/**
 * Poll for up to 15 seconds waiting for a login page to redirect
 * to either the target domain (authenticated) or an SSO domain (chained auth).
 */
async function waitForRedirectFromLogin(page: Page, domain: string): Promise<void> {
  const pollStart = Date.now();
  while (Date.now() - pollStart < REDIRECT_POLL_MAX_MS) {
    await delay(REDIRECT_POLL_INTERVAL_MS);
    const url = page.url();
    if ((url.includes(domain) && !isLoginUrl(url)) || isSsoDomain(url)) {
      log.info(`Login redirect completed in ${Math.round((Date.now() - pollStart) / 1000)}s`);
      return;
    }
  }
  log.warn(`Login redirect poll timed out after ${Math.round(REDIRECT_POLL_MAX_MS / 1000)}s`);
}

/**
 * Poll for up to 60 seconds waiting for the user to approve the
 * Microsoft Authenticator number-matching prompt.
 *
 * Checks three conditions on each poll:
 *  1. URL changed away from SSO (redirect happened -> approval successful)
 *  2. The `#idRemoteNGC_DisplaySign` element disappeared (approval completed)
 *  3. Page shows an error message (user denied or server timeout)
 *
 * Returns success:true if approval was detected, or
 * needsUserInteraction:true if the 60s window expires.
 */
async function waitForAuthenticatorApproval(
  page: Page,
  domain: string,
): Promise<AuthAttemptResult> {
  const startUrl = page.url();
  const pollStart = Date.now();
  let lastProgressLog = 0;

  while (Date.now() - pollStart < AUTHENTICATOR_POLL_MAX_MS) {
    await delay(AUTHENTICATOR_POLL_INTERVAL_MS);
    const elapsed = Date.now() - pollStart;

    // Log progress every 15 seconds
    if (elapsed - lastProgressLog >= AUTHENTICATOR_PROGRESS_LOG_INTERVAL_MS) {
      lastProgressLog = elapsed;
      log.info(
        `Still waiting for Authenticator approval... ${Math.round(elapsed / 1000)}s/${Math.round(AUTHENTICATOR_POLL_MAX_MS / 1000)}s`,
      );
    }

    // 1. Check if the URL changed (redirect = approval successful)
    let currentUrl: string;
    try {
      currentUrl = page.url();
    } catch {
      // Page became inaccessible — likely navigating after approval
      log.info('Authenticator: page navigating — assuming approval succeeded');
      return { success: true, needsUserInteraction: false };
    }

    if (currentUrl !== startUrl) {
      const leftSso = !isSsoDomain(currentUrl);
      if (leftSso) {
        log.info(
          `Authenticator approved — redirected away from SSO in ${Math.round(elapsed / 1000)}s`,
        );
        return { success: true, needsUserInteraction: false };
      }
      // URL changed but still on SSO — could be an intermediate redirect, keep polling.
    }

    // 2. Check if the number-matching element disappeared
    try {
      const numberElement = await page.$('#idRemoteNGC_DisplaySign');
      if (!numberElement) {
        log.info(
          `Authenticator approved — number prompt disappeared after ${Math.round(elapsed / 1000)}s`,
        );
        // Brief pause for the page to settle after approval
        await delay(2000);
        return { success: true, needsUserInteraction: false };
      }
    } catch {
      // Element query failed — page may be navigating
      log.info('Authenticator: element query failed — assuming approval succeeded');
      return { success: true, needsUserInteraction: false };
    }

    // 3. Check for error state (user denied or server timeout)
    try {
      const errorVisible = await page.evaluate(() => {
        const errorEl =
          document.querySelector('#idDiv_SAOTCAS_ErrorMsg') ||
          document.querySelector('.alert-error') ||
          document.querySelector('[data-testid="error"]');
        if (errorEl) {
          const style = window.getComputedStyle(errorEl);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            return errorEl.textContent?.trim() || 'Unknown error';
          }
        }
        return null;
      });

      if (errorVisible) {
        log.error(`Authenticator error detected: ${errorVisible}`);
        return { success: false, needsUserInteraction: true };
      }
    } catch {
      // Ignore evaluation errors — page may be transitioning
    }
  }

  log.warn(
    `Authenticator approval timed out after ${Math.round(AUTHENTICATOR_POLL_MAX_MS / 1000)}s — falling back to visible browser`,
  );
  return { success: false, needsUserInteraction: true };
}

/**
 * Check if page content indicates user interaction is needed
 */
async function checkNeedsUserInteraction(page: Page): Promise<boolean> {
  let pageContent: string;
  try {
    pageContent = await Promise.race([
      page.evaluate(() => document.body.textContent || ''),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), PAGE_CONTENT_TIMEOUT_MS)),
    ]);
  } catch {
    pageContent = '';
  }

  // Check for real MFA / certificate prompts.
  // Use specific patterns — overly broad matches like "code" or "verify"
  // trigger false positives because those words appear in normal SSO pages
  // (e.g. JavaScript code, HTML class names, cookie notices).
  return (
    pageContent.includes('Enter code') ||
    pageContent.includes('enter the code') ||
    pageContent.includes('Approve sign in') ||
    pageContent.includes('approve sign-in') ||
    pageContent.includes('Verify your identity') ||
    pageContent.includes('verify your identity') ||
    pageContent.includes('Choose a certificate') ||
    pageContent.includes('Pick a certificate') ||
    pageContent.includes('Use your Authenticator') ||
    pageContent.includes('Microsoft Authenticator') ||
    pageContent.includes('Enter your password') ||
    pageContent.includes('enter your password') ||
    (pageContent.length < 300 && !pageContent.includes('Signing in'))
  );
}
