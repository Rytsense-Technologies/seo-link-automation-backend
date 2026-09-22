/**
 * Application error types and the JSON error envelope used by every endpoint
 * (app/core/exceptions.py):
 *
 *   {"error": {"code": "SUGGESTION_NOT_FOUND", "message": "...", "details": {...}}}
 */

export class AppError extends Error {
  static statusCode = 400;
  static code = 'BAD_REQUEST';

  constructor(message, { code = null, details = null, statusCode = null } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.message = message;
    this.code = code ?? this.constructor.code;
    this.statusCode = statusCode ?? this.constructor.statusCode;
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  static statusCode = 404;
  static code = 'NOT_FOUND';
}

export class ConflictError extends AppError {
  static statusCode = 409;
  static code = 'CONFLICT';
}

export class UnprocessableError extends AppError {
  static statusCode = 422;
  static code = 'UNPROCESSABLE';
}

export class ServiceUnavailableError extends AppError {
  static statusCode = 503;
  static code = 'SERVICE_UNAVAILABLE';
}

export class UpstreamError extends AppError {
  static statusCode = 502;
  static code = 'UPSTREAM_ERROR';
}

/** Raised for any database failure (the SQLAlchemyError equivalent). */
export class DatabaseError extends Error {
  constructor(cause) {
    super(cause?.message ?? 'Database error');
    this.cause = cause;
    this.sqlState = typeof cause?.code === 'string' && /^[0-9A-Z]{5}$/.test(cause.code) ? cause.code : null;
    this.constraint = cause?.constraint ?? null;
    // SQLAlchemy-style class name (used in crawl error messages like the Python reference).
    this.name = sqlalchemyErrorName(this.sqlState);
  }
}

function sqlalchemyErrorName(sqlState) {
  if (sqlState === null) return 'OperationalError';
  const cls = sqlState.slice(0, 2);
  if (cls === '23') return 'IntegrityError';
  if (cls === '22') return 'DataError';
  if (cls === '42') return 'ProgrammingError';
  if (cls === '08' || cls === '57' || cls === '53' || cls === '28') return 'OperationalError';
  return 'InternalError';
}

export function errorBody(code, message, details = null) {
  return { error: { code, message, details } };
}

/** OpenAPI component for the envelope, referenced by route `response` maps. */
export const errorResponseSchema = {
  $id: 'ErrorResponse',
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: { type: ['object', 'null'], additionalProperties: true },
      },
      required: ['code', 'message'],
    },
  },
  required: ['error'],
};

const ref = (description) => ({ description, $ref: 'ErrorResponse#' });

/** Same documented error responses as Python's ERROR_RESPONSES. */
export const ERROR_RESPONSES = {
  404: ref('Resource not found'),
  409: ref('State conflict'),
  422: ref('Validation error'),
  503: ref('Database or dependency unavailable'),
};

export const errorRef = ref;
