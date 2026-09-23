/**
 * Application configuration loaded from environment variables / `.env` (app/core/config.py).
 *
 * Mirrors pydantic-settings: env names are case-insensitive, real environment variables win
 * over `.env`, list settings are JSON, booleans accept true/false/1/0/yes/no/on/off, invalid
 * values fail at startup, and an empty string is kept as an empty string (not "unset").
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';

const PROVIDERS = ['gemini', 'groq', 'openai', 'none'];
const ENVIRONMENTS = ['development', 'test', 'staging', 'production'];

const DEFAULT_UTILITY_PATH_PATTERNS = [
  String.raw`^/(login|logout|signin|sign-in|signup|sign-up|register|account|my-account)(/|$)`,
  String.raw`^/(cart|checkout|basket)(/|$)`,
  String.raw`^/(privacy|privacy-policy|terms|terms-of-service|terms-and-conditions|cookie-policy|cookies|disclaimer)(/|$)`,
  String.raw`^/(search|tag|tags|author|feed|rss|wp-admin|wp-login\.php|wp-json|admin|api)(/|$)`,
  String.raw`^/(404|500|thank-you|thanks)(/|$)`,
  String.raw`\.(pdf|jpe?g|png|gif|svg|webp|zip|xml|txt|json|css|js)$`,
];

// name -> [type, default, constraints]
const FIELDS = {
  app_name: ['str', 'SEO Link Automation API'],
  environment: ['enum', 'development', { values: ENVIRONMENTS }],
  log_level: ['str', 'INFO'],
  api_prefix: ['str', '/api'],
  api_key: ['secret', null],
  cors_origins: ['list', []],

  // Placeholder only; the real value comes from DATABASE_URL in .env / the environment.
  database_url: ['str', 'postgresql+psycopg://postgres:*****@localhost:5432/link_automation'],
  database_pool_size: ['int', 5],
  database_echo: ['bool', false],

  ai_provider: ['enum', 'none', { values: PROVIDERS }],
  ai_api_key: ['secret', null],
  ai_model: ['optstr', null],
  ai_base_url: ['optstr', null],
  ai_timeout_seconds: ['float', 60.0],
  ai_temperature: ['float', 0.2],

  interlink_min_relevance_score: ['int', 70, { ge: 0, le: 100 }],
  interlink_candidate_pool_size: ['int', 15, { ge: 1, le: 50 }],
  interlink_max_suggestions_per_page: ['int', 5, { ge: 1, le: 50 }],
  interlink_rejection_cooldown_days: ['int', 30, { ge: 0 }],
  interlink_max_anchor_reuse: ['int', 3, { ge: 1 }],
  interlink_source_content_max_chars: ['int', 6000, { ge: 500 }],
  interlink_target_excerpt_chars: ['int', 300, { ge: 0 }],
  interlink_require_region_match: ['bool', true],
  // Minimum 0-1 deterministic relevance score (use_ai=false or the ai_fallback path).
  interlink_deterministic_min_score: ['float', 0.35, { ge: 0, le: 1 }],
  interlink_utility_page_types: ['list', ['utility', 'system', 'legal', 'auth', 'search', 'archive']],
  interlink_utility_path_patterns: ['list', DEFAULT_UTILITY_PATH_PATTERNS],

  crawler_user_agent: ['str', 'SEOLinkAutomationBot/0.1'],
  crawler_timeout_seconds: ['float', 15.0, { gt: 0 }],
  crawler_max_retries: ['int', 2, { ge: 0, le: 5 }],
  crawler_max_redirects: ['int', 5, { ge: 0, le: 10 }],
  crawler_max_response_bytes: ['int', 5_000_000, { ge: 10_000 }],
  crawler_request_delay_seconds: ['float', 0.5, { ge: 0 }],
  crawler_max_crawl_delay_seconds: ['float', 10.0, { ge: 0 }],
  crawler_max_pages_limit: ['int', 1000, { ge: 1 }],
  crawler_max_sitemaps: ['int', 50, { ge: 1 }],
  crawler_allowed_ports: ['intlist', [80, 443]],
};

export class ConfigError extends Error {}

const TRUE = new Set(['1', 'true', 't', 'yes', 'y', 'on']);
const FALSE = new Set(['0', 'false', 'f', 'no', 'n', 'off']);

function coerce(name, type, raw, rules = {}) {
  const fail = (msg) => {
    throw new ConfigError(`Invalid setting ${name.toUpperCase()}=${JSON.stringify(raw)}: ${msg}`);
  };
  let value;
  switch (type) {
    case 'str':
    case 'optstr':
    case 'secret':
      value = raw;
      break;
    case 'enum':
      value = raw;
      if (!rules.values.includes(value)) fail(`must be one of ${rules.values.join(', ')}`);
      break;
    case 'bool': {
      const v = raw.trim().toLowerCase();
      if (TRUE.has(v)) value = true;
      else if (FALSE.has(v)) value = false;
      else fail('must be a boolean');
      break;
    }
    case 'int':
      if (!/^\s*[+-]?\d+\s*$/.test(raw)) fail('must be an integer');
      value = Number.parseInt(raw, 10);
      break;
    case 'float':
      value = Number(raw.trim());
      if (raw.trim() === '' || Number.isNaN(value)) fail('must be a number');
      break;
    case 'list':
    case 'intlist': {
      try {
        value = JSON.parse(raw);
      } catch {
        fail('must be a JSON list');
      }
      if (!Array.isArray(value)) fail('must be a JSON list');
      const itemType = type === 'list' ? 'string' : 'number';
      if (!value.every((v) => typeof v === itemType && (itemType === 'string' || Number.isInteger(v)))) {
        fail(`must be a JSON list of ${type === 'list' ? 'strings' : 'integers'}`);
      }
      break;
    }
    default:
      fail(`unknown type ${type}`);
  }
  if (typeof value === 'number') {
    if (rules.ge !== undefined && !(value >= rules.ge)) fail(`must be >= ${rules.ge}`);
    if (rules.gt !== undefined && !(value > rules.gt)) fail(`must be > ${rules.gt}`);
    if (rules.le !== undefined && !(value <= rules.le)) fail(`must be <= ${rules.le}`);
  }
  return value;
}

function readDotenv(file) {
  try {
    return parseDotenv(fs.readFileSync(file));
  } catch {
    return {};
  }
}

/**
 * Build settings from `env` (defaults to process.env) and a `.env` file (defaults to ./.env).
 * Pass `envFile: null` to ignore the file (like `Settings(_env_file=None)`).
 */
export function loadSettings({ env = process.env, envFile = path.resolve('.env'), overrides = {} } = {}) {
  const fileValues = envFile ? readDotenv(envFile) : {};
  const lookup = (name) => {
    for (const source of [env, fileValues]) {
      for (const [k, v] of Object.entries(source)) {
        if (k.toLowerCase() === name && v !== undefined) return v;
      }
    }
    return undefined;
  };
  const settings = {};
  for (const [name, [type, def, rules]] of Object.entries(FIELDS)) {
    if (Object.hasOwn(overrides, name)) {
      settings[name] = overrides[name];
      continue;
    }
    const raw = lookup(name);
    settings[name] = raw === undefined ? structuredClone(def) : coerce(name, type, raw, rules);
  }
  return Object.freeze(settings);
}

let cached = null;

/** Process-wide settings (like the lru_cached `get_settings`). */
export function getSettings() {
  if (cached === null) cached = loadSettings();
  return cached;
}

export function resetSettingsCache() {
  cached = null;
}

/** SQLAlchemy URLs ("postgresql+psycopg://") -> libpq/pg URLs ("postgresql://"). */
export function toPgConnectionString(databaseUrl) {
  return databaseUrl.replace(/^postgres(?:ql)?\+[a-z0-9]+:\/\//i, 'postgresql://');
}

export const SETTING_NAMES = Object.keys(FIELDS);
