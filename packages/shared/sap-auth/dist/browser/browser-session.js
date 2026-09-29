/**
 * Browser session management
 * Handles browser lifecycle, process cleanup, and state management
 */
import { createLogger } from 'mcp-logger';
import { killProcessByPid } from './process-manager.js';
import { launchBrowser as doLaunchBrowser, configurePageDefaults, } from './browser-launcher.js';
import { buildUserAgent } from '../utils/http.js';
const log = createLogger('sap-auth', 'browser-session');
/**
 * Build session config from environment
 */
export function buildSessionConfig() {
    return {
        userEmail: process.env.SAP_AUTH_ACCOUNT,
        inPrivate: process.env.IN_PRIVATE === 'true',
        visibleMode: process.env.VISIBLE_MODE === 'true',
        forceVisible: process.env.SAP_AUTH_FORCE_VISIBLE === 'true' ||
            process.env.SAP_AUTH_SKIP_HEADLESS === 'true',
        forceManualFallback: process.env.FORCE_MANUAL_FALLBACK === 'true',
        silentFailure: process.env.SILENT_FAILURE === 'true',
        userDataDir: process.env.BROWSER_USER_DATA_DIR,
    };
}
/**
 * Create initial session state
 */
export function createSessionState() {
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
export async function safeBrowserClose(state) {
    if (!state.browser)
        return state;
    let browserProcess = null;
    try {
        log.info('Safely closing existing browser instance...');
        browserProcess = state.browser.process();
        if (state.isRemote) {
            state.browser.disconnect();
            log.info('Disconnected from remote browser (kept running)');
        }
        else {
            const pages = await state.browser.pages();
            for (const page of pages) {
                try {
                    await page.close();
                }
                catch {
                    // Ignore
                }
            }
            await state.browser.close();
            log.info('Browser instance closed successfully');
        }
    }
    catch (error) {
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
export async function launchBrowserSession(state, headless, config) {
    const userAgent = buildUserAgent();
    const desiredMode = headless && !config.forceVisible ? 'headless' : 'visible';
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
export function shouldFallbackToVisible(errorMessage) {
    return (errorMessage.includes('timeout') ||
        errorMessage.includes('Timeout') ||
        errorMessage.includes('net::ERR_') ||
        errorMessage.includes('SSL') ||
        errorMessage.includes('certificate'));
}
/**
 * Navigate to URL with timeout handling
 */
export async function navigateWithTimeout(page, url, timeout = 45000) {
    await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout,
    });
}
//# sourceMappingURL=browser-session.js.map