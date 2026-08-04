import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { registerChapterStructureRoutes } from './chapter-structure-routes.js';
import {
  applyHostedChapterStructure,
  getHostedChapterStructureEditorState,
  previewHostedChapterStructure,
  rollbackHostedChapterStructure,
} from '../../services/hosted-chapter-structure-service.js';

vi.mock('../../services/hosted-chapter-structure-service.js', () => ({
  getHostedChapterStructureEditorState: vi.fn(),
  previewHostedChapterStructure: vi.fn(),
  applyHostedChapterStructure: vi.fn(),
  rollbackHostedChapterStructure: vi.fn(),
  listHostedChapterStructureReview: vi.fn(async () => []),
}));

const config = { defaultUserId: 'user_1' } as ServerConfig;
const pool = {} as pg.Pool;

describe('chapter structure routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes editor, preview, apply and rollback contracts', async () => {
    vi.mocked(getHostedChapterStructureEditorState).mockResolvedValue({
      bookId: 'book_1',
      baseContentRevisionId: 'revision_1',
      sourceProvenance: 'original',
      chapters: [],
      reviewItemCount: 0,
    });
    vi.mocked(previewHostedChapterStructure).mockResolvedValue({
      draftId: 'draft_1',
      bookId: 'book_1',
      baseContentRevisionId: 'revision_1',
      commands: [{ kind: 'rename', chapterId: 'chapter_1', title: 'Renamed' }],
      before: [],
      after: [],
      affectedChapterIds: ['chapter_1'],
      impact: {
        preservedParagraphs: 1,
        addedParagraphs: 0,
        removedParagraphs: 0,
        readerAnnotationsAtRisk: 0,
        correctionsForReview: 0,
      },
      warnings: [],
      createdAt: '2026-07-13T00:00:00.000Z',
    });
    const receipt = {
      id: 'receipt_1',
      bookId: 'book_1',
      draftId: 'draft_1',
      previousContentRevisionId: 'revision_1',
      contentRevisionId: 'revision_2',
      commands: [{ kind: 'rename', chapterId: 'chapter_1', title: 'Renamed' }] as const,
      status: 'active' as const,
      createdAt: '2026-07-13T00:00:00.000Z',
    };
    vi.mocked(applyHostedChapterStructure).mockResolvedValue(receipt);
    vi.mocked(rollbackHostedChapterStructure).mockResolvedValue({ ...receipt, status: 'rolled_back' });
    const app = Fastify({ logger: false });
    await registerChapterStructureRoutes(app, pool, config);

    expect((await app.inject({ method: 'GET', url: '/api/books/book_1/chapter-structure' })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/books/book_1/chapter-structure/preview',
          payload: { commands: [{ kind: 'rename', chapterId: 'chapter_1', title: 'Renamed' }] },
        })
      ).json(),
    ).toMatchObject({ preview: { draftId: 'draft_1' } });
    expect(
      (await app.inject({ method: 'POST', url: '/api/chapter-structure/drafts/draft_1/apply' })).json(),
    ).toMatchObject({ receipt: { contentRevisionId: 'revision_2' } });
    expect(
      (await app.inject({ method: 'POST', url: '/api/chapter-structure/receipts/receipt_1/rollback' })).json(),
    ).toMatchObject({ receipt: { status: 'rolled_back' } });
  });

  it('rejects malformed commands before the service boundary', async () => {
    const app = Fastify({ logger: false });
    await registerChapterStructureRoutes(app, pool, config);
    const response = await app.inject({
      method: 'POST',
      url: '/api/books/book_1/chapter-structure/preview',
      payload: { commands: [{ kind: 'split', chapterId: 'chapter_1', sourceOffset: 'bad' }] },
    });
    expect(response.statusCode).toBe(400);
    expect(previewHostedChapterStructure).not.toHaveBeenCalled();
  });
});
