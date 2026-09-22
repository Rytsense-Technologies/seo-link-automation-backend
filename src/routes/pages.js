/** /api/pages routes (app/pages/router.py). */

import { ERROR_RESPONSES, normaliseUuid, uuid } from '../schemas/common.js';

export default async function pagesRoutes(app) {
  app.get(
    '/pages',
    {
      schema: {
        tags: ['pages'],
        summary: 'List Pages',
        querystring: {
          type: 'object',
          properties: {
            site_id: { ...uuid, type: ['string', 'null'] },
            page: { type: 'integer', minimum: 1, default: 1 },
            page_size: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
        response: { 200: { $ref: 'PageList#' }, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { site_id: siteId = null, page, page_size: pageSize } = request.query;
      const [items, total] = await app.deps
        .pageService()
        .listPages({ siteId: siteId ? normaliseUuid(siteId) : null, page, pageSize });
      return { items, total, page, page_size: pageSize };
    },
  );

  app.get(
    '/pages/:page_id',
    {
      schema: {
        tags: ['pages'],
        summary: 'Get Page',
        params: { type: 'object', properties: { page_id: uuid }, required: ['page_id'] },
        response: { 200: { $ref: 'PageDetail#' }, ...ERROR_RESPONSES },
      },
    },
    async (request) => app.deps.pageService().getPage(normaliseUuid(request.params.page_id)),
  );
}
