// Parity with Pydantic v2 lax validation (the rules FastAPI applies to request fields).
// test/fixtures/pydantic-lax.json was recorded from the Python reference's own pydantic
// (scratch probe: one model per field type, every input validated, results dumped as JSON).
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  nullable,
  validateBool,
  validateDatetime,
  validateEnum,
  validateHttpUrl,
  validateInt,
  validateList,
  validateStr,
  validateUuid,
} from '../../src/utils/pydantic.js';

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'APPLIED'];
const VALIDATORS = {
  int: (v) => validateInt(v),
  int_range: (v) => validateInt(v, { ge: 1, le: 100 }),
  opt_int: nullable((v) => validateInt(v)),
  bool: validateBool,
  str: (v) => validateStr(v),
  str_len: (v) => validateStr(v, { minLength: 1, maxLength: 5 }),
  opt_str: nullable((v) => validateStr(v, { maxLength: 5 })),
  list_str: (v) => validateList(v, (x) => validateStr(x), { maxItems: 3 }),
  opt_list_str: nullable((v) => validateList(v, (x) => validateStr(x))),
  uuid: validateUuid,
  url: (v) => validateHttpUrl(v),
  opt_url: nullable((v) => validateHttpUrl(v)),
  opt_datetime: nullable(validateDatetime),
  enum: nullable((v) => validateEnum(v, STATUSES)),
};

// JSON.parse cannot tell 5 from 5.0: keep the source text to skip float literals with an
// integral value (Python sees a float there, a JSON API client in JS sees an int).
const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/pydantic-lax.json', import.meta.url), 'utf8'), (key, value, context) =>
  typeof value === 'number' && context?.source && /[.eE]/.test(context.source) && Number.isInteger(value) ? { $integralFloat: value } : value,
);
const isSkipped = (v) => v !== null && typeof v === 'object' && ('$bigint' in v || '$integralFloat' in v);

describe('Pydantic lax-mode parity', () => {
  it('fixture was recorded from pydantic 2.x', () => {
    expect(fixture.pydantic).toMatch(/^2\./);
    expect(fixture.cases.length).toBeGreaterThan(2500);
  });

  const cases = fixture.cases.filter((c) => !isSkipped(c.input) && !isSkipped(c.ok));
  it.each(cases.map((c) => [c.type, JSON.stringify(c.input).slice(0, 80), c]))('%s %s', (type, _label, c) => {
    const result = VALIDATORS[type](c.input);
    if (c.ok !== undefined) {
      expect(result).toEqual({ ok: true, value: c.ok });
    } else {
      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(c.errors);
    }
  });
});
