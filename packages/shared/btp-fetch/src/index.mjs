/**
 * BTP Destination fetch wrapper with Principal Propagation.
 *
 * Attempts to route HTTP calls through a BTP Destination with token exchange.
 * Logs detailed diagnostics to stdout (visible in CF logs) on failure.
 */

import { getDestination } from '@sap-cloud-sdk/connectivity';
import { executeHttpRequest } from '@sap-cloud-sdk/http-client';

/**
 * True when running inside a BTP CF container (VCAP_SERVICES is set).
 */
export function isBtp() {
  return !!process.env.VCAP_SERVICES;
}

/**
 * Make an authenticated HTTP request via a BTP Destination with Principal Propagation.
 *
 * @param {string} destinationName - BTP Destination name (e.g. 'HARMONY_DEST')
 * @param {string} jwt             - The caller's OAuth JWT (from Authorization header)
 * @param {string} path            - URL path + query string (e.g. '/sap/opu/odata/...')
 * @param {RequestInit} [init]     - Standard fetch options (method, headers, body)
 * @returns {Promise<Response>}    - Standard fetch Response
 */
export async function btpFetch(destinationName, jwt, path, init = {}) {
  let destination;
  try {
    destination = await getDestination({
      destinationName,
      jwt,
      useCache: false, // disable cache to get fresh error on every attempt
    });
  } catch (destError) {
    const msg = destError?.message ?? String(destError);
    process.stdout.write(
      `[btp-fetch] getDestination('${destinationName}') FAILED: ${msg}\n` +
      `[btp-fetch] JWT prefix: ${jwt?.slice(0, 40) ?? 'null'}...\n` +
      `[btp-fetch] Stack: ${destError?.stack ?? 'n/a'}\n`
    );
    throw new Error(
      `BTP Destination '${destinationName}' auth failed: ${msg}. ` +
      `This typically means the BTP subaccount lacks trust with the target SAP landscape, ` +
      `or the Destination is misconfigured. ` +
      `Check CF logs for '[btp-fetch]' entries and verify the Destination in BTP Cockpit.`
    );
  }

  if (!destination) {
    process.stdout.write(`[btp-fetch] Destination '${destinationName}' not found in BTP Cockpit.\n`);
    throw new Error(`BTP Destination '${destinationName}' not found. Create it in BTP Cockpit → Connectivity → Destinations.`);
  }

  process.stdout.write(`[btp-fetch] Destination '${destinationName}' resolved OK. Calling ${path}\n`);

  const method = (init.method ?? 'GET').toUpperCase();
  const callerHeaders = headersToObject(init.headers);

  let sdkResponse;
  try {
    sdkResponse = await executeHttpRequest(destination, {
      method,
      url: path,
      headers: callerHeaders,
      data: init.body ?? undefined,
    });
  } catch (httpError) {
    const msg = httpError?.message ?? String(httpError);
    const stack = httpError?.stack ?? '';
    const cause = httpError?.cause?.message ?? '';
    const detail = `${msg}${cause ? ` | cause: ${cause}` : ''}`;
    process.stdout.write(`[btp-fetch] executeHttpRequest FAILED for ${path}: ${detail}\n${stack}\n`);
    throw new Error(`BTP HTTP request to '${destinationName}${path}' failed: ${detail}`);
  }

  // Wrap the Axios-style SDK response in a standard fetch Response
  const status = sdkResponse.status;
  const responseHeaders = new Headers(sdkResponse.headers ?? {});
  const responseBody = typeof sdkResponse.data === 'string'
    ? sdkResponse.data
    : JSON.stringify(sdkResponse.data);

  return new Response(responseBody, { status, headers: responseHeaders });
}

/**
 * Convert various header formats to a plain object.
 */
function headersToObject(headers) {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const obj = {};
    headers.forEach((v, k) => { obj[k] = v; });
    return obj;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return headers;
}
