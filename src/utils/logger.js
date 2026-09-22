/** Module-level logger for services (Fastify uses its own pino instance for requests). */

import pino from 'pino';

const level = (process.env.LOG_LEVEL || 'info').toLowerCase();

export const logger = pino({
  level: process.env.NODE_ENV === 'test' || process.env.VITEST ? 'silent' : level === 'warning' ? 'warn' : level,
});
