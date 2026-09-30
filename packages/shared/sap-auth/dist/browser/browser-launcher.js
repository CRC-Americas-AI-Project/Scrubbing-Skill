/**
 * Browser launcher utilities
 * Handles Puppeteer browser setup, configuration, and lifecycle
 */
import puppeteer from 'puppeteer';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { computeSystemExecutablePath, Browser as PuppeteerBrowser, ChromeReleaseChannel, } from '@puppeteer/browsers';
import { createLogger } from 'mcp-logger';
import { killRemainingChromeProcesses } from './process-manager.js';
const log = createLogger('sap-auth', 'browser-launcher');
/**
 * Platform-specific browser flags
 */
const MAC_FLAGS = [
    '--use-mock-keychain=true',
    '--password-store=basic',
    '--disable-keychain-reauthorization',
    '--disable-mac-overlays',
];
const WINDOWS_FLAGS = ['--disable-gpu', '--window-size=1200,800'];
const LINUX_FLAGS = ['--disable-gpu', '--window-size=1200,800'];
/**
 * Common Chrome launch arguments
 */
function getCommonChromeArgs() {
    return [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--no-first-run',
        '--disable-default-apps',
        '--use-system-certificate-store',
        '--auth-server-whitelist=*.sap.com,*.one.int.sap,*.wdf.sap.corp,*.hana.ondemand.com,*.ondemand.com',
        '--auth-negotiate-delegate-whitelist=*.sap.com,*.one.int.sap,*.wdf.sap.corp,*.hana.ondemand.com,*.ondemand.com',
        '--auth-schemes=basic,digest,ntlm,negotiate',
        '--window-size=1200,800',
    ];
}
/**
 * Get platform-specific browser flags
 */
function getPlatformFlags() {
    switch (process.platform) {
        case 'darwin':
            return MAC_FLAGS;
        case 'win32':
            return WINDOWS_FLAGS;
        default:
            return LINUX_FLAGS;
    }
}
// ── Browser discovery ──────────────────────────────────────────────────────────
function resolveChromePath() {
    try {
        return computeSystemExecutablePath({
            browser: PuppeteerBrowser.CHROME,
            channel: ChromeReleaseChannel.STABLE,
        });
    }
    catch {
        return undefined;
    }
}
function getEdgeCandidates() {
    if (process.platform === 'darwin') {
        return ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
    }
    if (process.platform === 'win32') {
        const prefixes = new Set();
        for (const name of ['PROGRAMFILES', 'ProgramW6432', 'ProgramFiles(x86)', 'LOCALAPPDATA']) {
            const val = process.env[name];
            if (val)
                prefixes.add(val);
        }
        prefixes.add('C:\\Program Files');
        prefixes.add('C:\\Program Files (x86)');
        return [...prefixes].map((p) => `${p}\\Microsoft\\Edge\\Application\\msedge.exe`);
    }
    return ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'];
}
function resolveEdgePath() {
    return getEdgeCandidates().find((p) => existsSync(p));
}
function resolveViaPath() {
    if (process.platform === 'win32')
        return undefined;
    const commands = [
        'google-chrome-stable',
        'google-chrome',
        'microsoft-edge',
        'microsoft-edge-stable',
        'chromium-browser',
        'chromium',
    ];
    for (const cmd of commands) {
        try {
            const resolved = execSync(`command -v ${cmd}`, {
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: 3000,
            }).trim();
            if (resolved && existsSync(resolved))
                return resolved;
        }
        catch {
            // not found
        }
    }
    return undefined;
}
/**
 * Resolve browser executable path.
 *
 * Cascade: BROWSER_PATH env → Edge (Windows) / Chrome (other) → Chrome (Windows) / Edge (other) → PATH lookup.
 * On Windows, Edge is preferred because it uses the system certificate store and Kerberos/NTLM
 * credentials shared with the OS, which is required for SAP SSO.
 */
export function resolveBrowserPath() {
    const envPath = process.env.BROWSER_PATH;
    if (envPath) {
        if (existsSync(envPath))
            return envPath;
        log.warn(`BROWSER_PATH="${envPath}" does not exist, falling back to auto-detection`);
    }
    if (process.platform === 'win32') {
        const edgePath = resolveEdgePath();
        if (edgePath)
            return edgePath;
        const chromePath = resolveChromePath();
        if (chromePath)
            return chromePath;
    }
    else {
        const chromePath = resolveChromePath();
        if (chromePath)
            return chromePath;
        const edgePath = resolveEdgePath();
        if (edgePath)
            return edgePath;
        const pathResult = resolveViaPath();
        if (pathResult)
            return pathResult;
    }
    log.warn('No system browser found. SSO requires Chrome or Edge. ' +
        'Set BROWSER_PATH to the full path of your browser executable.');
    return undefined;
}
// ── Launch / connect ───────────────────────────────────────────────────────────
function buildLaunchOptions(headless, inPrivate, userDataDir) {
    const platformFlags = getPlatformFlags();
    return {
        headless: headless ? 'new' : false,
        devtools: false,
        executablePath: resolveBrowserPath(),
        protocolTimeout: 120000,
        ...(userDataDir ? { userDataDir } : {}),
        args: [
            ...getCommonChromeArgs(),
            ...platformFlags,
            ...(headless
                ? ['--disable-dev-shm-usage', '--disable-gpu', '--disable-popup-blocking']
                : []),
            ...(inPrivate
                ? [
                    '--incognito',
                    '--disable-background-networking',
                    '--disable-background-timer-throttling',
                    '--disable-renderer-backgrounding',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-client-side-phishing-detection',
                    '--disable-default-apps',
                    '--disable-extensions',
                    '--disable-sync',
                    '--disable-translate',
                    '--hide-scrollbars',
                    '--metrics-recording-only',
                    '--mute-audio',
                    '--no-first-run',
                    '--safebrowsing-disable-auto-update',
                    '--disable-ipc-flooding-protection',
                ]
                : []),
        ],
    };
}
function getFirstOrNewPage(browser) {
    return browser.pages().then((pages) => (pages.length > 0 ? pages[0] : browser.newPage()));
}
async function connectToRemoteBrowser(endpoint) {
    log.info(`Connecting to remote browser at ${endpoint}...`);
    // ws:// → WebSocket endpoint, http:// → browser URL (CDP JSON endpoint)
    const isWebSocket = endpoint.startsWith('ws://') || endpoint.startsWith('wss://');
    const browser = await puppeteer.connect(isWebSocket ? { browserWSEndpoint: endpoint } : { browserURL: endpoint });
    const page = await getFirstOrNewPage(browser);
    log.info('Remote browser connected');
    return { browser, page, mode: 'visible', isRemote: true };
}
/**
 * Launch a Puppeteer browser instance
 */
export async function launchBrowser(headless, inPrivate, forceVisible, userDataDir) {
    const browserEndpoint = process.env.BROWSER_WS_ENDPOINT;
    if (browserEndpoint) {
        return connectToRemoteBrowser(browserEndpoint);
    }
    if (headless && forceVisible) {
        log.info('SAP_AUTH_FORCE_VISIBLE or SAP_AUTH_SKIP_HEADLESS is set - skipping headless mode');
        headless = false;
    }
    const desiredMode = headless ? 'headless' : 'visible';
    await killRemainingChromeProcesses();
    const launchOptions = buildLaunchOptions(headless, inPrivate, userDataDir);
    log.info(`Launching ${desiredMode} browser...`);
    const browser = await puppeteer.launch(launchOptions);
    const page = await getFirstOrNewPage(browser);
    log.info(`${desiredMode} browser launched successfully`);
    return { browser, page, mode: desiredMode, isRemote: false };
}
/**
 * Configure default page settings
 */
export async function configurePageDefaults(page, userAgent, inPrivate) {
    if (inPrivate) {
        log.info('Private mode: Clearing all browser data and starting fresh...');
        await page.evaluateOnNewDocument(() => {
            localStorage.clear();
            sessionStorage.clear();
        });
    }
    await page.setUserAgent(userAgent);
    await page.setViewport({ width: 1920, height: 1080 });
}
//# sourceMappingURL=browser-launcher.js.map