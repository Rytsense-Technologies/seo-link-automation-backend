/**
 * Content persistence boundary (app/content/store.py).
 *
 * Applying an internal link writes page content through a content store. The default store
 * persists to the `pages` table. A CMS-backed store (e.g. Sanity / Portable Text) can be added by
 * implementing the same interface ({ loadContent, saveContent }) and wiring it in
 * `src/interlink/dependencies.js`.
 */

import { runQuery } from '../db/pool.js';
import { ConflictError } from '../utils/errors.js';
import { sameHost } from '../utils/urls.js';
import { pySortedUnique } from '../utils/pytext.js';
import { extractLinks } from './html.js';

export function internalLinksFor(pageUrl, content) {
  return pySortedUnique(extractLinks(content, pageUrl).filter((link) => sameHost(link, pageUrl)));
}

export class DatabaseContentStore {
  /** @param executor pg client (inside the apply transaction) */
  constructor(executor) {
    this.executor = executor;
  }

  loadContent(page) {
    return page.content_html;
  }

  /** Must raise ConflictError if the content changed concurrently. */
  async saveContent(page, newContent, { expectedVersion }) {
    const outgoing = internalLinksFor(page.url, newContent);
    const result = await runQuery(
      this.executor,
      `UPDATE pages
          SET content_html = $1, content_version = content_version + 1, outgoing_links = $2,
              updated_at = now()
        WHERE id = $3 AND content_version = $4`,
      [newContent, outgoing, page.id, expectedVersion],
    );
    if (result.rowCount !== 1) {
      throw new ConflictError('Source page content changed while the link was being applied; retry.', {
        code: 'CONTENT_VERSION_CONFLICT',
      });
    }
    page.content_html = newContent;
    page.content_version = expectedVersion + 1;
    page.outgoing_links = outgoing;
  }
}
