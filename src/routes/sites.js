/** /api/sites routes (app/pages/router.py). */

import { ERROR_RESPONSES, normaliseUuid, uuid } from '../schemas/common.js';

export default async function sitesRoutes(app) {
  app.post(
    '/sites',
    {
      schema: {
        tags: ['pages'],
        summary: 'Create Site',
        description: 'Register a website whose pages form the internal-link inventory.',
        body: { $ref: 'SiteCreate#' },
        response: { 201: { $ref: 'SiteRead#' }, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const site = await app.deps.pageService().createSite(request.body);
      return reply.code(201).send(site);
    },
  );

  app.get(
    '/sites',
    {
      schema: {
        tags: ['pages'],
        summary: 'List Sites',
        response: { 200: { type: 'array', items: { $ref: 'SiteRead#' } }, ...ERROR_RESPONSES },
      },
    },
    async () => app.deps.pageService().listSites(),
  );

  app.put(
    '/sites/:site_id/pages',
    {
      schema: {
        tags: ['pages'],
        summary: 'Upsert Pages',
        description: 'Insert or update pages (keyed by normalised URL) from a crawl or content import.',
        params: { type: 'object', properties: { site_id: uuid }, required: ['site_id'] },
        body: { $ref: 'PageBulkUpsert#' },
        response: { 200: { $ref: 'PageBulkUpsertResult#' }, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const ids = await app.deps.pageService().upsertPages(normaliseUuid(request.params.site_id), request.body.pages);
      return { upserted: ids.length, page_ids: ids };
    },
  );
}
