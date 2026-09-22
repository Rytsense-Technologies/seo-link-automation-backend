/** OpenAPI + Swagger UI at /docs (JSON at /docs/json and, like FastAPI, /openapi.json). */

import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

export async function registerSwagger(app, settings) {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: settings.app_name,
        version: '0.1.0',
        description:
          'SEO link automation backend. The **interlink** endpoints generate, review and safely apply ' +
          'contextual internal-link suggestions. Suggestion status values: `PENDING`, `APPROVED`, ' +
          '`REJECTED`, `APPLIED`.',
      },
      components: {
        securitySchemes: { APIKeyHeader: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
      },
    },
    refResolver: {
      // Use the schema $id (e.g. "SuggestionDetail") as the component name.
      buildLocalReference: (json, baseUri, fragment, i) => json.$id || `def-${i}`,
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { deepLinking: true } });
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  // FastAPI also serves ReDoc by default.
  app.get('/redoc', { schema: { hide: true } }, async (request, reply) => reply.type('text/html; charset=utf-8').send(redocHtml(settings.app_name)));
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function redocHtml(title) {
  return `<!DOCTYPE html>
<html>
<head>
<title>${escapeHtml(title)} - ReDoc</title>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body { margin: 0; padding: 0; }</style>
</head>
<body>
<noscript>ReDoc requires Javascript to function. Please enable it to browse the documentation.</noscript>
<redoc spec-url="/openapi.json"></redoc>
<script src="https://cdn.jsdelivr.net/npm/redoc@2/bundles/redoc.standalone.js"></script>
</body>
</html>`;
}
