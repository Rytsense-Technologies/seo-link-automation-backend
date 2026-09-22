/** Optional API-key authentication for the /api routes (app/core/security.py). */

import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../utils/errors.js';
import { pyStrip } from '../utils/pytext.js';

/** Constant-time string comparison (like `secrets.compare_digest`). */
export function constantTimeEqual(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  if (x.length !== y.length) {
    timingSafeEqual(y, y); // keep timing independent of where the mismatch is
    return false;
  }
  return timingSafeEqual(x, y);
}

/**
 * preValidation hook: runs after the body is parsed and before validation, so a missing key
 * wins over validation errors exactly like the FastAPI dependency. Disabled when API_KEY is
 * empty/unset. The key is never logged.
 */
export function requireApiKey(getSettings) {
  return async (request) => {
    const expected = getSettings().api_key;
    if (expected === null || expected === undefined || !pyStrip(expected)) return;
    const provided = request.headers['x-api-key'];
    if (provided === undefined || !constantTimeEqual(provided, expected)) {
      throw new AppError('Invalid or missing API key', { code: 'UNAUTHORIZED', statusCode: 401 });
    }
  };
}
