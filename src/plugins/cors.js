/** CORS, only when CORS_ORIGINS is configured (FastAPI CORSMiddleware equivalent). */

import cors from '@fastify/cors';

export async function registerCors(app, settings) {
  if (!settings.cors_origins.length) return;
  await app.register(cors, {
    origin: settings.cors_origins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    credentials: false,
  });
}
