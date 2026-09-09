/**
 * Browser session management
 * Handles browser lifecycle, process cleanup, and state management
 */

import { Browser, Page } from 'puppeteer';
import { createLogger } from 'mcp-logger';
import { killProcessByPid } from './process-manager.js';
import {
  launchBrowser as doLaunchBrowser,
  configurePageDefaults,
  type BrowserMode,
} from './browser-launcher.js';
import { buildUserAgent } from '../utils/http.js';

const log = createLogger('sap-auth', 'browser-session');

/**
 * Browser session configuration
 */
export interface BrowserSessionConfig {
  userEmail?: string;
  inPrivate: boolean;
  visibleMode: boolean;
  forceVisible: boolean;
  forceManualFallback: boolean;
  silentFailure: boolean;
  userDataDir?: string;
}

/**
 * Build session config from environment
 */
export function buildSessionConfig(): BrowserSessionConfig {
  return {
    userEmail: process.env.SAP_AUTH_ACCOUNT,
    inPrivate: process.env.IN_PRIVATE === 'true',
    visibleMode: process.env.VISIBLE_MODE === 'true',
    forceVisible:
      process.env.SAP_AUTH_FORCE_VISIBLE === 'true' ||
      process.env.SAP_AUTH_SKIP_HEADLESS === 'true',
    forceManualFallback: process.env.FORCE_MANUAL_FALLBACK === 'true',
    silentFailure: process.env.SILENT_FAILURE === 'true',
    userDataDir: process.env.BROWSER_USER_DATA_DIR,
  };
}

/**
 * Browser session state
 */
export interface BrowserSessionState {
  browser: Browser | null;
  page: Page | null;
  currentMode: BrowserMode | null;
  isRemote: boolean;
  isInitialized: boolean;
}

/**
 * Create initial session state
 */
export function createSessionState(): BrowserSessionState {
  return {
    browser: null,
    page: null,
    currentMode: null,
    isRemote: false,
    isInitialized: false,
  };
}

/**
 * Safe browser close method - prevents hanging Chrome instances
 */
export async function safeBrowserClose(state: BrowserSessionState): Promise<BrowserSessionState> {
  if (!state.browser) return state;

  let browserProcess: any = null;

  try {
    log.info('Safely closing existing browser instance...');
    browserProcess = state.browser.process();

    if (state.isRemote) {
      state.browser.disconnect();
      log.info('Disconnected from remote browser (kept running)');
    } else {
      const pages = await state.browser.pages();
      for (const page of pages) {
        try {
          await page.close();
        } catch {
          // Ignore
        }
      }

      await state.browser.close();
      log.info('Browser instance closed successfully');
    }
  } catch (error) {
    log.warn('Warning: Error during safe browser close:', error);
  }

  if (!state.isRemote && browserProcess && !browserProcess.killed) {
    const pid = browserProcess.pid;
    log.info(`Force killing browser process (PID: ${pid}) to ensure cleanup...`);
    await killProcessByPid(pid);
    log.info('Browser process terminated');
  }

  return createSessionState();
}

/**
 * Launch browser with proper mode handling
 */
export async function launchBrowserSession(
  state: BrowserSessionState,
  headless: boolean,
  config: BrowserSessionConfig,
): Promise<BrowserSessionState> {
  const userAgent = buildUserAgent();
  const desiredMode: BrowserMode = headless && !config.forceVisible ? 'headless' : 'visible';

  if (state.browser && state.currentMode === desiredMode) {
    log.info(`Browser already running in ${desiredMode} mode, reusing instance`);
    return state;
  }

  if (state.browser && state.currentMode !== desiredMode) {
    log.info(`Switching from ${state.currentMode} to ${desiredMode} mode`);
    state = await safeBrowserClose(state);
  }

  const result = await doLaunchBrowser(headless, config.inPrivate, config.forceVisible, config.userDataDir);

  await configurePageDefaults(result.page, userAgent, config.inPrivate);

  return {
    browser: result.browser,
    page: result.page,
    currentMode: result.mode,
    isRemote: result.isRemote,
    isInitialized: true,
  };
}

/**
 * Check if navigation error should trigger fallback to visible mode
 */
export function shouldFallbackToVisible(errorMessage: string): boolean {
  return (
    errorMessage.includes('timeout') ||
    errorMessage.includes('Timeout') ||
    errorMessage.includes('net::ERR_') ||
    errorMessage.includes('SSL') ||
    errorMessage.includes('certificate')
  );
}

/**
 * Navigate to URL with timeout handling
 */
export async function navigateWithTimeout(
  page: Page,
  url: string,
  timeout: number = 45000,
): Promise<void> {
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout,
  });
}
