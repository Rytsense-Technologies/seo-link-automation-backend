/** Fastify application factory (app/main.py). */

import Fastify from 'fastify';
import { getSettings } from './config/config.js';
import { AppError, DatabaseError, errorBody, errorResponseSchema } from './utils/errors.js';
import { BodyDecodeError, PyJSONDecodeError, pyJsonLoadsBytes } from './utils/pyjson.js';
import { RawBody, RequestValidationError, routeValidationHook } from './utils/request-validation.js';
import { requireApiKey } from './plugins/auth.js';
import { registerCors } from './plugins/cors.js';
import { registerSwagger } from './plugins/swagger.js';
import { defaultDeps } from './plugins/database.js';
import { pageSchemas } from './schemas/pages.js';
import { crawlerSchemas } from './schemas/crawler.js';
import { interlinkSchemas } from './schemas/interlink.js';
import healthRoutes from './routes/health.js';
import sitesRoutes from './routes/sites.js';
import pagesRoutes from './routes/pages.js';
import crawlRoutes from './routes/crawl.js';
import interlinkRoutes from './routes/interlink.js';

const MAX_BODY_BYTES = 100 * 1024 * 1024;
const MEDIA_TYPE = /^\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*(?:;.*)?$/s;

class JsonBodyError extends Error {
  constructor(decodeError) {
    super(decodeError.msg);
    this.pos = decodeError.pos;
  }
}

/**
 * FastAPI (strict_content_type=True, its default): only application/json or application/*+json
 * bodies are parsed as JSON; a missing content-type is not. Media type parsed like email.message
 * (parameters ignored; anything without exactly one "/" counts as text/plain).
 */
function isJsonContentType(header) {
  if (!header) return false;
  const mediaType = header.split(';')[0].trim().toLowerCase();
  if (mediaType.split('/').length !== 2) return false;
  const [type, subtype] = mediaType.split('/');
  return type === 'application' && (subtype === 'json' || subtype.endsWith('+json'));
}

function routeRegex(url) {
  const source = url
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${source}$`);
}

/**
 * @param options.settings settings object (defaults to env/.env)
 * @param options.deps     dependency overrides (like FastAPI dependency_overrides)
 * @param options.logger   Fastify logger option
 */
export async function buildApp({ settings = null, deps = {}, logger = false } = {}) {
  const getAppSettings = () => settings ?? getSettings();
  const app = Fastify({
    logger,
    exposeHeadRoutes: false,
    // Uvicorn/Starlette impose no body limit (bulk page upserts can be large); Fastify's default is
    // 1 MiB. Keep a generous bound instead of none.
    bodyLimit: MAX_BODY_BYTES,
  });
  app.decorate('settings', getAppSettings());
  const merged = {};
  Object.assign(merged, defaultDeps(getAppSettings, () => merged), deps);
  app.decorate('deps', merged);

  // Request bodies as FastAPI reads them: an empty body is "no body"; with an application/json or
  // application/*+json content-type the bytes go through Python's json.loads (invalid JSON -> 422
  // json_invalid with Python's message/position, undecodable bytes -> 400); any other or missing
  // content-type leaves the raw bytes, which then fail model validation.
  // Python's email.message reads a malformed media type as text/plain (-> raw body); Fastify would
  // answer 415 before any parser runs, so normalise such headers first.
  app.addHook('onRequest', async (request) => {
    const header = request.headers['content-type'];
    if (header && !MEDIA_TYPE.test(header)) request.headers['content-type'] = 'text/plain';
  });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (request, body, done) => {
    if (body.length === 0) {
      done(null, undefined);
      return;
    }
    if (!isJsonContentType(request.headers['content-type'])) {
      done(null, new RawBody(body));
      return;
    }
    try {
      done(null, pyJsonLoadsBytes(body));
    } catch (err) {
      if (err instanceof PyJSONDecodeError) done(new JsonBodyError(err), undefined);
      else if (err instanceof BodyDecodeError) done(Object.assign(new Error('There was an error parsing the body'), { statusCode: 400 }), undefined);
      else done(err, undefined);
    }
  });

  // Requests are validated with Pydantic semantics (utils/request-validation.js), not Ajv; the JSON
  // schemas still document the API and serialise responses.
  const schemaRegistry = new Map([...pageSchemas, ...crawlerSchemas, ...interlinkSchemas].map((schema) => [schema.$id, schema]));
  app.setValidatorCompiler(() => () => true);

  const routes = [];
  app.addHook('onRoute', (opts) => {
    const methods = Array.isArray(opts.method) ? opts.method : [opts.method];
    for (const m of methods) routes.push({ method: m, regex: routeRegex(opts.url) });
    const validate = routeValidationHook(opts, schemaRegistry);
    if (validate) opts.preValidation = [...[opts.preValidation ?? []].flat(), validate];
  });

  app.addSchema(errorResponseSchema);
  for (const schema of [...pageSchemas, ...crawlerSchemas, ...interlinkSchemas]) app.addSchema(schema);

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof RequestValidationError) {
      return reply.code(422).send(errorBody('VALIDATION_ERROR', 'Request validation failed', { errors: err.errors }));
    }
    if (err instanceof JsonBodyError) {
      const errors = [{ type: 'json_invalid', loc: ['body', err.pos], msg: 'JSON decode error', input: {}, ctx: { error: err.message } }];
      return reply.code(422).send(errorBody('VALIDATION_ERROR', 'Request validation failed', { errors }));
    }
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send(errorBody(err.code, err.message, err.details));
    }
    if (err instanceof DatabaseError) {
      request.log.error({ err }, 'Database error');
      return reply.code(503).send(errorBody('DATABASE_ERROR', 'A database error occurred'));
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send(errorBody('HTTP_ERROR', err.message));
    }
    request.log.error({ err }, 'Unhandled error');
    return reply.code(500).type('text/plain; charset=utf-8').send('Internal Server Error');
  });

  // Starlette semantics: 405 for a known path with another method; 307 redirect_slashes; else 404.
  const notFound = (request, reply) => {
    const [path, query] = request.url.split(/\?(.*)/s);
    const allowed = routes.filter((r) => r.regex.test(path)).map((r) => r.method);
    if (allowed.length) {
      // The reference's HTTPException handler drops Starlette's Allow header; so do we.
      return reply.code(405).send(errorBody('HTTP_ERROR', 'Method Not Allowed'));
    }
    if (path !== '/') {
      const toggled = path.endsWith('/') ? path.slice(0, -1) : `${path}/`;
      if (routes.some((r) => r.regex.test(toggled))) {
        // Like Starlette, the Location is absolute (scheme + Host header).
        const target = `${request.protocol}://${request.headers.host ?? 'localhost'}${toggled}`;
        return reply.code(307).header('location', query ? `${target}?${query}` : target).send();
      }
    }
    return reply.code(404).send(errorBody('HTTP_ERROR', 'Not Found'));
  };
  app.setNotFoundHandler(notFound);
  // Starlette's JSONResponse sends "application/json" without a charset parameter.
  app.addHook('onSend', async (request, reply, payload) => {
    if (reply.getHeader('content-type') === 'application/json; charset=utf-8') reply.header('content-type', 'application/json');
    return payload;
  });
  // Starlette path parameters never match an empty segment ("/api/pages/" is not /api/pages/{page_id}),
  // whereas find-my-way matches ":page_id" with "". Treat such requests as unmatched routes.
  app.addHook('onRequest', async (request, reply) => {
    if (request.params && Object.values(request.params).some((v) => v === '')) return notFound(request, reply);
    return undefined;
  });

  await registerCors(app, getAppSettings());
  await registerSwagger(app, getAppSettings());

  await app.register(healthRoutes);
  await app.register(
    async (api) => {
      api.addHook('preValidation', requireApiKey(getAppSettings));
      await api.register(sitesRoutes);
      await api.register(pagesRoutes);
      await api.register(interlinkRoutes);
      await api.register(crawlRoutes);
    },
    { prefix: getAppSettings().api_prefix },
  );
  return app;
}
