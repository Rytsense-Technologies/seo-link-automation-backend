/** Shared JSON-schema fragments (Pydantic field equivalents). */

// Pydantic's UUID accepts hyphenated and 32-hex forms; handlers normalise to lowercase hyphenated.
export const UUID_PATTERN = '^(?:[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12})$';
export const uuid = { type: 'string', pattern: UUID_PATTERN };
export const uuidOut = { type: 'string', format: 'uuid' };
export const nullableUuid = { type: ['string', 'null'], pattern: UUID_PATTERN };

// Pydantic HttpUrl: absolute http(s) URL with a host.
export const httpUrl = { type: 'string', format: 'uri', pattern: '^[Hh][Tt][Tt][Pp][Ss]?://[^/?#\\s]+', maxLength: 2083 };

// ISO-8601 datetime as Pydantic accepts it (T or space separator, optional timezone).
export const dateTimeIn = {
  type: ['string', 'null'],
  pattern: '^\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,6})?)?)?(?:Z|z|[+-]\\d{2}(?::?\\d{2})?)?$',
};
export const dateTime = { type: 'string', format: 'date-time' };
export const nullableDateTime = { type: ['string', 'null'], format: 'date-time' };

export function normaliseUuid(value) {
  if (value === null || value === undefined) return value;
  const hex = value.replaceAll('-', '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const errorResponses = (codes) =>
  Object.fromEntries(
    Object.entries(codes).map(([code, description]) => [code, { description, $ref: 'ErrorResponse#' }]),
  );

/** Python ERROR_RESPONSES (404/409/422/503) documented on every API route. */
export const ERROR_RESPONSES = errorResponses({
  404: 'Resource not found',
  409: 'State conflict',
  422: 'Validation error',
  503: 'Database or dependency unavailable',
});
