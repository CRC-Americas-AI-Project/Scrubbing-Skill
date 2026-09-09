/**
 * HTTP utility functions for cross-platform compatibility
 */

/**
 * Cross-platform User-Agent builder
 * Returns a browser-like user agent string appropriate for the current platform
 */
export function buildUserAgent(): string {
  if (process.env.FORCE_UA) return process.env.FORCE_UA;
  switch (process.platform) {
    case 'win32':
      return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
    case 'linux':
      return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    case 'darwin':
    default:
      return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  }
}

/**
 * Cross-platform sec-ch-ua-platform builder
 * Returns the appropriate sec-ch-ua-platform header value for the current platform
 */
export function buildSecChPlatform(): string {
  if (process.env.FORCE_PLATFORM_HEADER) return process.env.FORCE_PLATFORM_HEADER;
  switch (process.platform) {
    case 'win32':
      return '"Windows"';
    case 'linux':
      return '"Linux"';
    case 'darwin':
    default:
      return '"macOS"';
  }
}
