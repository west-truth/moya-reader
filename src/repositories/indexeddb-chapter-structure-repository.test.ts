import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LabeledSegment } from '../domain/types';
import { parseNovelFile } from '../domain/parser';
import { getCorrections, getSegments, saveCorrection, saveSegments } from '../storage/analysis-artifact-store';
import { exportBookSource } from '../storage/book-asset-store';
import { getChapters, getNovel, saveImportedNovel } from '../storage/db';
import { resetReaderDbForTests } from '../storage/reader-database';
import { IndexedDbChapterStructureRepository } from './indexeddb-chapter-structure-repository';

async function seedBook() {
  const text = '1화 시작\n\n첫 문단입니다.\n\n둘째 문단입니다.\n\n2화 다음\n\n셋째 문단입니다.\n\n넷째 문단입니다.';
  const bytes = new TextEncoder().encode(text);
  const parsed = await parseNovelFile('structure.txt', bytes.buffer, 'utf-8');
  const source = new Blob([bytes], { type: 'text/plain' });
  await saveImportedNovel(parsed, {
    sourceAsset: {
      blob: source,
      fileName: 'structure.txt',
      contentType: 'text/plain',
      contentHash: parsed.novel.rawTextHash,
      encoding: 'utf-8',
      provenance: 'original',
    },
  });
  return parsed;
}

describe('IndexedDbChapterStructureRepository', () => {
  beforeEach(async () => resetReaderDbForTests());

  it('previews, applies and rolls back a split while remapping durable AI artifacts', async () => {
    const parsed = await seedBook();
    const repository = new IndexedDbChapterStructureRepository();
    const state = await repository.getEditorState(parsed.novel.id);
    const first = state.chapters[0];
    const candidate = first.splitCandidates[0];
    const movedParagraph = parsed.paragraphs.find((paragraph) => paragraph.id === candidate.paragraphId)!;
    const segment: LabeledSegment = {
      id: 'segment_1',
      novelId: parsed.novel.id,
      chapterId: first.id,
      paragraphId: movedParagraph.id,
      segmentIndex: 0,
      startOffset: 0,
      endOffset: movedParagraph.text.length,
      segmentTextHash: movedParagraph.textHash,
      type: 'narration',
      speakerId: 'narrator',
      candidateSpeakers: [],
      listenerIds: [],
      emotion: 'neutral',
      confidence: 1,
      isUserCorrected: true,
    };
    await saveSegments(first.id, [segment]);
    await saveCorrection({
      id: 'correction_1',
      novelId: parsed.novel.id,
      chapterId: first.id,
      paragraphId: movedParagraph.id,
      segmentId: segment.id,
      correctionType: 'speaker',
      afterJson: '{"speakerId":"narrator"}',
      applyScope: 'segment',
      createdAt: '2026-07-13T00:00:00.000Z',
    });

    const preview = await repository.preview(parsed.novel.id, [
      { kind: 'split', chapterId: first.id, sourceOffset: candidate.sourceOffset, title: '새 경계' },
    ]);
    expect(preview.after).toHaveLength(3);
    expect(preview.impact).toMatchObject({ preservedParagraphs: 4, removedParagraphs: 0 });

    const receipt = await repository.apply(preview.draftId);
    const chapters = await getChapters(parsed.novel.id);
    const movedChapter = chapters.find((chapter) => chapter.title === '새 경계')!;
    expect(chapters).toHaveLength(3);
    expect((await getSegments(movedChapter.id))[0]).toMatchObject({ id: segment.id, chapterId: movedChapter.id });
    expect((await getCorrections(parsed.novel.id))[0]).toMatchObject({
      id: 'correction_1',
      chapterId: movedChapter.id,
    });
    expect((await exportBookSource(parsed.novel.id))?.metadata).toMatchObject({
      provenance: 'original',
      contentRevisionId: receipt.contentRevisionId,
    });

    const rolledBack = await repository.rollback(receipt.id);
    expect(rolledBack.status).toBe('rolled_back');
    expect(await getChapters(parsed.novel.id)).toHaveLength(2);
    expect((await getCorrections(parsed.novel.id))[0].chapterId).toBe(first.id);
  });

  it('quarantines an unmapped correction for review after range reparse', async () => {
    const parsed = await seedBook();
    const repository = new IndexedDbChapterStructureRepository();
    const originalParagraph = parsed.paragraphs[0];
    await saveCorrection({
      id: 'correction_reparse',
      novelId: parsed.novel.id,
      chapterId: originalParagraph.chapterId,
      paragraphId: originalParagraph.id,
      correctionType: 'note',
      afterJson: '{"note":"keep"}',
      applyScope: 'segment',
      createdAt: '2026-07-13T00:00:00.000Z',
    });

    const preview = await repository.preview(parsed.novel.id, [
      { kind: 'reparse_range', startOffset: 0, splitMode: 'single' },
    ]);
    expect(preview.impact.correctionsForReview).toBe(1);
    await repository.apply(preview.draftId);

    expect(await getCorrections(parsed.novel.id)).toEqual([]);
    expect(await repository.listReviewItems(parsed.novel.id)).toEqual([
      expect.objectContaining({
        kind: 'correction_unmapped',
        correction: expect.objectContaining({ id: 'correction_reparse' }),
      }),
    ]);
    expect((await getNovel(parsed.novel.id))?.analysisStatus).toBe('needs_review');
  });

  it('rejects a stale draft after another structure revision becomes active', async () => {
    const parsed = await seedBook();
    const repository = new IndexedDbChapterStructureRepository();
    const first = (await repository.getEditorState(parsed.novel.id)).chapters[0];
    const stale = await repository.preview(parsed.novel.id, [{ kind: 'rename', chapterId: first.id, title: 'stale' }]);
    const winning = await repository.preview(parsed.novel.id, [
      { kind: 'rename', chapterId: first.id, title: 'winner' },
    ]);
    await repository.apply(winning.draftId);

    await expect(repository.apply(stale.draftId)).rejects.toThrow('revision이 변경');
  });
});
