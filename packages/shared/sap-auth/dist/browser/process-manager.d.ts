/**
 * Chrome process management utilities
 * Handles process lifecycle for Puppeteer-spawned Chrome instances
 */
/**
 * Chrome process information
 */
export interface ChromeProcess {
    pid: number;
    name: string;
    cmd: string;
}
/**
 * Cross-platform process killer
 * Uses taskkill on Windows (with /T to kill child processes), SIGKILL on Unix
 */
export declare function killProcessByPid(pid: number): Promise<void>;
/**
 * Find Chrome processes by name using find-process library
 */
export declare function findChromeProcesses(): Promise<ChromeProcess[]>;
/**
 * Kill any remaining Puppeteer-spawned Chrome processes
 * Only kills Chrome instances with --remote-debugging-port (Puppeteer's signature)
 * Does NOT kill the user's regular Chrome browser
 */
export declare function killRemainingChromeProcesses(): Promise<void>;
//# sourceMappingURL=process-manager.d.ts.map