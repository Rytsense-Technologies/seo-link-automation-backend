/**
 * FastAPI-style request validation driven by the routes' JSON schemas (which also feed Swagger).
 *
 * Each schema is compiled into Pydantic-lax validators (./pydantic.js). Like FastAPI, all request
 * parts are validated and their errors reported together, in the order path -> query -> body, each
 * error located as ["path"|"query"|"body", ...field path]. Ajv is not used for requests.
 */

import { UUID_PATTERN, dateTimeIn } from '../schemas/common.js';
import {
  nullable,
  validateBool,
  validateDatetime,
  validateEnum,
  validateHttpUrl,
  validateInt,
  validateList,
  validateModel,
  validateStr,
  validateUuid,
} from './pydantic.js';

/** A request body that FastAPI does not parse as JSON (non-JSON content-type): kept as bytes. */
export class RawBody {
  constructor(bytes) {
    this.bytes = bytes;
  }

  /** FastAPI's jsonable_encoder renders bytes in error `input` as `bytes.decode()`. */
  toJSON() {
    return this.bytes.toString('utf8');
  }
}

const typesOf = (schema) => (Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []);

/** Compile one JSON schema (the subset this API uses) into a validator. */
export function compileSchema(schema, registry) {
  if (schema.$ref) {
    const target = registry.get(schema.$ref.replace(/#$/, ''));
    if (!target) throw new Error(`Unknown schema reference ${schema.$ref}`);
    return compileSchema(target, registry);
  }
  if (schema.anyOf) {
    const branches = schema.anyOf.filter((s) => !(s.type === 'null'));
    if (branches.length !== 1 || schema.anyOf.length !== 2) throw new Error('Only `anyOf: [X, {type: null}]` is supported');
    return nullable(compileSchema(branches[0], registry));
  }
  const types = typesOf(schema);
  const isNullable = types.includes('null');
  const type = types.find((t) => t !== 'null');
  const validate = compileType(type, schema, registry);
  return isNullable ? nullable(validate) : validate;
}

function compileType(type, schema, registry) {
  switch (type) {
    case 'integer':
      return (v) => validateInt(v, { ge: schema.minimum ?? null, le: schema.maximum ?? null });
    case 'boolean':
      return validateBool;
    case 'string':
      if (schema.enum) return (v) => validateEnum(v, schema.enum);
      if (schema.pattern === UUID_PATTERN) return validateUuid;
      if (schema.format === 'uri') return (v) => validateHttpUrl(v, { maxLength: schema.maxLength ?? 2083 });
      if (schema.pattern === dateTimeIn.pattern) return validateDatetime;
      return (v) => validateStr(v, { minLength: schema.minLength ?? null, maxLength: schema.maxLength ?? null });
    case 'array': {
      const item = compileSchema(schema.items, registry);
      return (v) => validateList(v, item, { minItems: schema.minItems ?? null, maxItems: schema.maxItems ?? null });
    }
    case 'object': {
      const fields = compileFields(schema, registry);
      return (v) => validateModel(v, fields);
    }
    default:
      throw new Error(`Unsupported schema type ${type}`);
  }
}

function compileFields(schema, registry) {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, property]) => ({
    name,
    validate: compileSchema(property, registry),
    required: required.has(name),
    default: property.default ?? (property.$ref ? registry.get(property.$ref.replace(/#$/, ''))?.default : undefined) ?? null,
  }));
}

/** Path/query parameters: each validated on its own (missing -> default, repeated -> last value). */
function compileParameters(schema, registry, location) {
  if (!schema) return null;
  const fields = compileFields(schema, registry);
  return (raw) => {
    const value = {};
    const errors = [];
    for (const field of fields) {
      let input = raw?.[field.name];
      if (Array.isArray(input)) input = input.at(-1);
      if (input === undefined) {
        if (field.required) errors.push({ type: 'missing', loc: [location, field.name], msg: 'Field required', input: null });
        else value[field.name] = structuredClone(field.default);
        continue;
      }
      const result = field.validate(input);
      if (result.ok) value[field.name] = result.value;
      else errors.push(...result.errors.map((e) => ({ ...e, loc: [location, field.name, ...e.loc] })));
    }
    return { value, errors };
  };
}

/**
 * A single request body (FastAPI's non-embedded body parameter).
 * @param bodyDefault 'required' | 'none' (Optional[...] = None) | 'factory' (default_factory=Model)
 */
function compileBody(schema, registry, bodyDefault) {
  if (!schema) return null;
  const validate = compileSchema(schema, registry);
  return (raw) => {
    // FastAPI treats a missing body and a JSON `null` body alike.
    if (raw === undefined || raw === null) {
      if (bodyDefault === 'none') return { value: null, errors: [] };
      if (bodyDefault === 'factory') raw = {};
      else return { value: undefined, errors: [{ type: 'missing', loc: ['body'], msg: 'Field required', input: null }] };
    }
    // Raw bytes never validate as a model; FastAPI echoes them (decoded) as the input.
    const result = raw instanceof RawBody ? validate(raw.toJSON()) : validate(raw);
    if (result.ok) return { value: result.value, errors: [] };
    return { value: undefined, errors: result.errors.map((e) => ({ ...e, loc: ['body', ...e.loc] })) };
  };
}

export class RequestValidationError extends Error {
  constructor(errors) {
    super('Request validation failed');
    this.errors = errors;
  }
}

/**
 * Build a preValidation hook for a route, or null when the route declares no request schema.
 * `config.body` on the route selects FastAPI's body default (see compileBody).
 */
export function routeValidationHook(routeOptions, registry) {
  const schema = routeOptions.schema ?? {};
  const params = compileParameters(schema.params, registry, 'path');
  const query = compileParameters(schema.querystring, registry, 'query');
  const body = compileBody(schema.body, registry, routeOptions.config?.body ?? 'required');
  if (!params && !query && !body) return null;
  return async function validateRequest(request) {
    const errors = [];
    const results = {};
    if (params) {
      results.params = params(request.params);
      errors.push(...results.params.errors);
    }
    if (query) {
      results.query = query(request.query);
      errors.push(...results.query.errors);
    }
    if (body) {
      results.body = body(request.body);
      errors.push(...results.body.errors);
    }
    if (errors.length) throw new RequestValidationError(errors);
    if (params) request.params = results.params.value;
    if (query) request.query = results.query.value;
    if (body) request.body = results.body.value;
  };
}
