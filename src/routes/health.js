/** Health endpoints (app/main.py). Not behind the API key. */

export default async function healthRoutes(app) {
  app.get(
    '/health',
    {
      schema: {
        tags: ['health'],
        summary: 'Health',
        response: { 200: { type: 'object', properties: { status: { type: 'string' } }, additionalProperties: { type: 'string' } } },
      },
    },
    async () => ({ status: 'ok' }),
  );

  app.get(
    '/health/db',
    {
      schema: {
        tags: ['health'],
        summary: 'Health Db',
        response: {
          200: {
            type: 'object',
            properties: { status: { type: 'string' }, database: { type: 'string' } },
            additionalProperties: { type: 'string' },
          },
        },
      },
    },
    async () => {
      await app.deps.pingDatabase();
      return { status: 'ok', database: 'ok' };
    },
  );
}
