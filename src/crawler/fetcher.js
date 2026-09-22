/** HTTP fetching for the crawler: manual redirects, size limits, retries (app/crawler/fetcher.py). */

import { urljoin } from '../utils/pyurl.js';
import { pyStrip } from '../utils/pytext.js';
import { SSRFError, isSsrfBlock, ssrfMessage, validateUrl } from './ssrf.js';
import { logger } from '../utils/logger.js';

export const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const DEFAULT_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5';

export class FetchError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'FetchError';
    this.status = status;
  }
}

/** A network-level failure (httpx.TransportError equivalent): retried, then reported. */
class TransportError extends Error {
  constructor(name, message, cause) {
    super(message);
    this.name = name;
    this.cause = cause;
  }
}

export class FetchResult {
  constructor(requestedUrl, finalUrl, status, headers, body, redirects = [], blockedRedirect = null) {
    this.requestedUrl = requestedUrl;
    this.finalUrl = finalUrl;
    this.status = status;
    this.headers = headers; // Headers (case-insensitive get)
    this.body = body; // Buffer
    // [url, status, location] for every redirect hop that was followed or stopped at.
    this.redirects = redirects;
    // Set when a redirect pointed somewhere we must not follow (other host, robots, SSRF).
    this.blockedRedirect = blockedRedirect;
  }

  get contentType() {
    return pyStrip(String(this.headers.get('content-type') ?? '').split(';')[0]).toLowerCase();
  }

  get isHtml() {
    return this.contentType === 'text/html' || this.contentType === 'application/xhtml+xml';
  }

  text() {
    let charset = null;
    for (const part of String(this.headers.get('content-type') ?? '').split(';').slice(1)) {
      const [key, , value] = partition(pyStrip(part), '=');
      if (key.toLowerCase() === 'charset') charset = value.replace(/^["' ]+|["' ]+$/g, '');
    }
    try {
      return new TextDecoder(charset || 'utf-8', { fatal: false }).decode(this.body);
    } catch {
      return new TextDecoder('utf-8', { fatal: false }).decode(this.body);
    }
  }
}

function partition(value, sep) {
  const i = value.indexOf(sep);
  return i < 0 ? [value, '', ''] : [value.slice(0, i), sep, value.slice(i + 1)];
}

export function fetcherConfig({
  userAgent,
  maxRetries = 2,
  maxRedirects = 5,
  maxResponseBytes = 5_000_000,
  allowedPorts = [80, 443],
  maxRetryAfterSeconds = 10.0,
}) {
  return { userAgent, maxRetries, maxRedirects, maxResponseBytes, allowedPorts, maxRetryAfterSeconds };
}

const sleepReal = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * @param fetchImpl `(url, init) => Promise<Response>`; production uses undici fetch with the
 *   SSRF-guarded dispatcher, tests inject a mock website.
 */
export class Fetcher {
  constructor(fetchImpl, config, { sleep = sleepReal } = {}) {
    this.fetchImpl = fetchImpl;
    this.config = config;
    this.sleep = sleep;
  }

  /** GET `url`, following redirects only to URLs accepted by `mayFollow`. */
  async fetch(url, { mayFollow = () => true, accept = DEFAULT_ACCEPT } = {}) {
    const redirects = [];
    let current = url;
    for (let i = 0; i < this.config.maxRedirects + 1; i += 1) {
      try {
        validateUrl(current, { allowedPorts: this.config.allowedPorts });
      } catch (err) {
        if (err instanceof SSRFError) throw new FetchError(`Blocked by SSRF protection: ${err.message}`);
        throw err;
      }
      const { status, headers, body } = await this.getWithRetries(current, accept);
      const location = headers.get('location');
      if (REDIRECT_STATUSES.has(status) && location) {
        const target = urljoin(current, location);
        redirects.push([current, status, target]);
        let isBlocked = false;
        try {
          validateUrl(target, { allowedPorts: this.config.allowedPorts });
        } catch (err) {
          if (!(err instanceof SSRFError)) throw err;
          isBlocked = true;
        }
        if (isBlocked || !mayFollow(target)) {
          return new FetchResult(url, current, status, headers, body, redirects, target);
        }
        current = target;
        continue;
      }
      return new FetchResult(url, current, status, headers, body, redirects);
    }
    throw new FetchError(`Too many redirects (>${this.config.maxRedirects})`);
  }

  async getWithRetries(url, accept) {
    let attempt = 0;
    for (;;) {
      let retryHeaders = null;
      try {
        const result = await this.getOnce(url, accept);
        if (!RETRY_STATUSES.has(result.status) || attempt >= this.config.maxRetries) return result;
        retryHeaders = result.headers;
        logger.info(`Retrying ${url} after HTTP ${result.status}`);
      } catch (err) {
        if (!(err instanceof TransportError)) throw err;
        if (isSsrfBlock(err)) throw new FetchError(`Blocked by SSRF protection: ${ssrfMessage(err)}`);
        if (attempt >= this.config.maxRetries) throw new FetchError(`${err.name}: ${err.message}`);
        logger.info(`Retrying ${url} after ${err.name}`);
      }
      attempt += 1;
      await this.sleep(this.backoff(attempt, retryHeaders));
    }
  }

  backoff(attempt, headers) {
    const retryAfter = headers ? headers.get('retry-after') : null;
    if (retryAfter && /^\d+$/.test(pyStrip(retryAfter))) {
      return Math.min(Number(pyStrip(retryAfter)), this.config.maxRetryAfterSeconds);
    }
    return Math.min(2.0 ** (attempt - 1), this.config.maxRetryAfterSeconds);
  }

  async getOnce(url, accept) {
    const limit = this.config.maxResponseBytes;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': this.config.userAgent, Accept: accept },
      });
    } catch (err) {
      throw toTransportError(err);
    }
    const status = response.status;
    const declared = response.headers.get('content-length');
    if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
      await cancelBody(response);
      throw new FetchError(`Response too large (${declared} bytes > ${limit})`, { status });
    }
    if (REDIRECT_STATUSES.has(status)) {
      await cancelBody(response);
      return { status, headers: response.headers, body: Buffer.alloc(0) };
    }
    const chunks = [];
    let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) {
            await reader.cancel().catch(() => {});
            throw new FetchError(`Response too large (> ${limit} bytes)`, { status });
          }
          chunks.push(Buffer.from(value));
        }
      } catch (err) {
        if (err instanceof FetchError) throw err;
        throw toTransportError(err);
      }
    }
    return { status, headers: response.headers, body: Buffer.concat(chunks) };
  }
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    /* ignore */
  }
}

/** Map fetch/undici failures to named transport errors (like httpx exception class names). */
function toTransportError(err) {
  if (err instanceof TransportError || err instanceof FetchError) return err;
  const root = err?.cause ?? err;
  const code = root?.code ?? '';
  let name = 'ConnectError';
  if (err?.name === 'TimeoutError' || /TIMEOUT/i.test(code)) name = 'TimeoutException';
  else if (/ECONNRESET|UND_ERR_SOCKET|EPIPE/.test(code)) name = 'ReadError';
  const message = root?.message || err?.message || String(err);
  return new TransportError(name, message, err);
}
