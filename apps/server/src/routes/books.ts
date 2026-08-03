import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { ServerConfig } from '../config.js';
import { registerAnnotationRoutes } from './books/annotation-routes.js';
import { registerBookCatalogRoutes } from './books/catalog-routes.js';
import { registerBookContentRoutes } from './books/content-routes.js';
import { registerReaderStateRoutes } from './books/reader-state-routes.js';
import { registerBookSearchRoutes } from './books/search-routes.js';
import { registerChapterStructureRoutes } from './books/chapter-structure-routes.js';
import { registerBookCoverRoutes } from './books/cover-routes.js';
import { registerLibraryManagementRoutes } from './books/library-management-routes.js';
import { registerReaderPersonalizationRoutes } from './books/personalization-routes.js';
import { registerEpubResourceRoutes } from './books/epub-resource-routes.js';
import { registerDocumentTextRoutes } from './books/document-text-routes.js';

export async function registerBookRoutes(app: FastifyInstance, pool: pg.Pool, config: ServerConfig): Promise<void> {
  await registerBookCatalogRoutes(app, pool, config);
  await registerBookContentRoutes(app, pool, config);
  await registerBookSearchRoutes(app, pool, config);
  await registerReaderStateRoutes(app, pool, config);
  await registerAnnotationRoutes(app, pool, config);
  await registerChapterStructureRoutes(app, pool, config);
  await registerBookCoverRoutes(app, pool, config);
  await registerLibraryManagementRoutes(app, pool, config);
  await registerReaderPersonalizationRoutes(app, pool, config);
  await registerEpubResourceRoutes(app, pool, config);
  await registerDocumentTextRoutes(app, pool, config);
}
