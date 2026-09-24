/**
 * Vercel serverless entry point.
 *
 * Vercel treats files under `api/` as functions and requires a default export that is a request
 * handler (or an http.Server). `src/app.js` exports the `buildApp` factory instead, so pointing
 * Vercel at it fails with "Invalid export found ... The default export must be a function or
 * server"; this module provides the handler and keeps `src/app.js` unchanged.
 *
 * The Fastify instance is built once per warm container and reused: `app.ready()` registers the
 * routes on the underlying http.Server, and each request is handed to it with `emit('request')`.
 * `app.listen()` is never called here - that stays in `src/server.js` for local development.
 */

import { buildApp } from '../src/app.js';
import { getSettings } from '../src/config/config.js';

let appPromise = null;

/** The Fastify instance for this container (built on the first request, then reused). */
export function getApp() {
  if (appPromise === null) {
    appPromise = (async () => {
      const level = getSettings().log_level.toLowerCase();
      const app = await buildApp({ logger: { level: level === 'warning' ? 'warn' : level } });
      await app.ready();
      return app;
    })().catch((error) => {
      // Let the next invocation try again rather than caching a failed build.
      appPromise = null;
      throw error;
    });
  }
  return appPromise;
}

export default async function handler(request, response) {
  let app;
  try {
    app = await getApp();
  } catch (error) {
    // Startup problems (an invalid setting, a file the deployment did not ship) surface here.
    // The reason goes to the platform log only - the response stays generic - and the stack is
    // included because this is the one failure a deployment cannot diagnose from the outside.
    if (error instanceof Error) {
      console.error(`Server initialisation failed: ${error.name}: ${error.message}`);
      if (error.stack) console.error(error.stack);
    } else {
      console.error(`Server initialisation failed: ${String(error)}`);
    }
    response.statusCode = 500;
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        error: { code: 'SERVER_INITIALISATION_FAILED', message: 'The server could not start', details: null },
      }),
    );
    return;
  }
  app.server.emit('request', request, response);
}
