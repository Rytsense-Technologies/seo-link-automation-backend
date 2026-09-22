// Parity with CPython `json.loads(bytes)` (Starlette request.json()).
// test/fixtures/python-json.json was recorded from the Python reference's interpreter.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PyJSONDecodeError, pyJsonLoadsBytes } from '../../src/utils/pyjson.js';

const pyJsonLoads = (text) => pyJsonLoadsBytes(Buffer.from(text, 'utf8')); // the probe encoded each sample as UTF-8

const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/python-json.json', import.meta.url), 'utf8'));
const FLOATS = { nan: NaN, inf: Infinity, '-inf': -Infinity };
const revive = (v) => {
  if (Array.isArray(v)) return v.map(revive);
  if (v !== null && typeof v === 'object') {
    if ('$float' in v) return FLOATS[v.$float];
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]));
  }
  return v;
};

describe('Python json.loads parity', () => {
  it('fixture was recorded from CPython 3', () => {
    expect(fixture.python).toMatch(/^3\./);
  });

  it.each(fixture.cases.map((c) => [JSON.stringify(c.input), c]))('%s', (_label, c) => {
    if (c.ok !== undefined) {
      if (c.ok !== null && typeof c.ok === 'object' && '$bigint' in c.ok) {
        expect(pyJsonLoads(c.input)).toBe(Number(c.ok.$bigint));
      } else if (c.ok === 0) {
        // Python's int has no -0; JS's -0 serialises as 0 and validateInt normalises it.
        expect(pyJsonLoads(c.input) === 0).toBe(true);
      } else {
        expect(pyJsonLoads(c.input)).toEqual(revive(c.ok));
      }
      return;
    }
    let error;
    try {
      pyJsonLoads(c.input);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(PyJSONDecodeError);
    expect({ msg: error.msg, pos: error.pos }).toEqual({ msg: c.error, pos: c.pos });
  });
});
