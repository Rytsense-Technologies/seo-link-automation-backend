/** Schemas for sites and pages (app/pages/schemas.py). */

import { dateTime, dateTimeIn, httpUrl, nullableDateTime, uuidOut } from './common.js';

const nullableString = (maxLength) => ({ type: ['string', 'null'], ...(maxLength ? { maxLength } : {}) });

export const SiteCreate = {
  $id: 'SiteCreate',
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 255 },
    base_url: httpUrl,
    default_language: { ...nullableString(16), default: null, examples: ['en'] },
    default_region: { ...nullableString(16), default: null, examples: ['us'] },
  },
  required: ['name', 'base_url'],
};

export const SiteRead = {
  $id: 'SiteRead',
  type: 'object',
  properties: {
    id: uuidOut,
    name: { type: 'string' },
    base_url: { type: 'string' },
    default_language: { type: ['string', 'null'] },
    default_region: { type: ['string', 'null'] },
    created_at: dateTime,
    updated_at: dateTime,
  },
  required: ['id', 'name', 'base_url', 'default_language', 'default_region', 'created_at', 'updated_at'],
};

export const PageUpsert = {
  $id: 'PageUpsert',
  type: 'object',
  description: 'A page record as produced by a crawler or content import.',
  properties: {
    url: { type: 'string', minLength: 1, maxLength: 2048, description: 'Absolute or site-relative URL' },
    title: { ...nullableString(), default: null },
    h1: { ...nullableString(), default: null },
    meta_description: { ...nullableString(), default: null },
    content_html: { ...nullableString(), default: null },
    canonical_url: { ...nullableString(2048), default: null },
    http_status: { type: ['integer', 'null'], minimum: 100, maximum: 599, default: 200 },
    redirect_url: { ...nullableString(2048), default: null },
    is_indexable: { type: 'boolean', default: true },
    has_noindex: { type: 'boolean', default: false },
    language: { ...nullableString(16), default: null },
    region: { ...nullableString(16), default: null },
    page_type: { ...nullableString(64), default: null, examples: ['service', 'blog'] },
    keywords: { type: 'array', items: { type: 'string' }, maxItems: 100, default: [] },
    outgoing_links: {
      type: ['array', 'null'],
      items: { type: 'string' },
      default: null,
      description: 'Internal links; derived from content_html when omitted',
    },
    last_crawled_at: { ...dateTimeIn, default: null },
  },
  required: ['url'],
};

export const PageBulkUpsert = {
  $id: 'PageBulkUpsert',
  type: 'object',
  properties: { pages: { type: 'array', items: { $ref: 'PageUpsert#' }, minItems: 1, maxItems: 1000 } },
  required: ['pages'],
};

export const PageBulkUpsertResult = {
  $id: 'PageBulkUpsertResult',
  type: 'object',
  properties: { upserted: { type: 'integer' }, page_ids: { type: 'array', items: uuidOut } },
  required: ['upserted', 'page_ids'],
};

export const PageSummary = {
  $id: 'PageSummary',
  type: 'object',
  properties: {
    id: uuidOut,
    url: { type: 'string' },
    title: { type: ['string', 'null'] },
    h1: { type: ['string', 'null'] },
  },
  required: ['id', 'url', 'title', 'h1'],
};

const pageReadProperties = {
  id: uuidOut,
  url: { type: 'string' },
  title: { type: ['string', 'null'] },
  h1: { type: ['string', 'null'] },
  site_id: uuidOut,
  meta_description: { type: ['string', 'null'] },
  canonical_url: { type: ['string', 'null'] },
  http_status: { type: ['integer', 'null'] },
  redirect_url: { type: ['string', 'null'] },
  is_indexable: { type: 'boolean' },
  has_noindex: { type: 'boolean' },
  language: { type: ['string', 'null'] },
  region: { type: ['string', 'null'] },
  page_type: { type: ['string', 'null'] },
  keywords: { type: 'array', items: { type: 'string' } },
  outgoing_links: { type: 'array', items: { type: 'string' } },
  content_version: { type: 'integer' },
  last_crawled_at: nullableDateTime,
  created_at: dateTime,
  updated_at: dateTime,
};

export const PageRead = {
  $id: 'PageRead',
  type: 'object',
  properties: pageReadProperties,
  required: Object.keys(pageReadProperties),
};

export const PageDetail = {
  $id: 'PageDetail',
  type: 'object',
  properties: { ...pageReadProperties, content_html: { type: ['string', 'null'] } },
  required: [...Object.keys(pageReadProperties), 'content_html'],
};

export const PageList = {
  $id: 'PageList',
  type: 'object',
  properties: {
    items: { type: 'array', items: { $ref: 'PageRead#' } },
    total: { type: 'integer' },
    page: { type: 'integer' },
    page_size: { type: 'integer' },
  },
  required: ['items', 'total', 'page', 'page_size'],
};

export const pageSchemas = [SiteCreate, SiteRead, PageUpsert, PageBulkUpsert, PageBulkUpsertResult, PageSummary, PageRead, PageDetail, PageList];
