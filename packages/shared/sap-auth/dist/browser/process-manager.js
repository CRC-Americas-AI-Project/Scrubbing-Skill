/**
 * Chrome process management utilities
 * Handles process lifecycle for Puppeteer-spawned Chrome instances
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import { createLogger } from 'mcp-logger';
const execAsync = promisify(exec);
const log = createLogger('sap-auth', 'process-manager');
/**
 * Cross-platform process killer
 * Uses taskkill on Windows (with /T to kill child processes), SIGKILL on Unix
 */
export async function killProcessByPid(pid) {
    try {
        if (process.platform === 'win32') {
            await execAsync(`taskkill /PID ${pid} /T /F`);
        }
        else {
            process.kill(pid, 'SIGKILL');
        }
    }
    catch {
        // Process may have already exited
    }
}
/**
 * Find Chrome processes by name using find-process library
 */
export async function findChromeProcesses() {
    const findProcessModule = await import('find-process');
    // Handle both ESM default export patterns
    const findProcess = (findProcessModule.default?.default ?? findProcessModule.default);
    // Search for Chrome/Edge processes with different names across platforms
    // Puppeteer bundled Chrome: "Google Chrome for Testing" (primary target)
    // User's Chrome: "Google Chrome", "chrome", "chromium"
    // Windows Edge (Chromium-based): "msedge", "Microsoft Edge"
    const searchTerms = [
        'Google Chrome for Testing',
        'Google Chrome',
        'chrome',
        'chromium',
        ...(process.platform === 'win32' ? ['msedge', 'Microsoft Edge'] : []),
    ];
    // Search all terms in parallel
    const results = await Promise.all(searchTerms.map((term) => findProcess('name', term, true).catch(() => [])));
    // Flatten and deduplicate by PID
    const seen = new Set();
    return results.flat().filter((p) => {
        if (seen.has(p.pid))
            return false;
        seen.add(p.pid);
        return true;
    });
}
/**
 * Kill any remaining Puppeteer-spawned Chrome processes
 * Only kills Chrome instances with --remote-debugging-port (Puppeteer's signature)
 * Does NOT kill the user's regular Chrome browser
 */
export async function killRemainingChromeProcesses() {
    try {
        const processes = await findChromeProcesses();
        for (const proc of processes) {
            // Only kill if it has Puppeteer's signature argument
            if (proc.cmd.includes('--remote-debugging-port')) {
                log.info(`Killing Puppeteer Chrome process (PID: ${proc.pid})`);
                await killProcessByPid(proc.pid);
            }
        }
    }
    catch {
        // Silent fail - this is just a cleanup attempt
    }
}
//# sourceMappingURL=process-manager.js.map