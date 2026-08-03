import type { Chapter, Character, Paragraph, UserCorrection } from '../../domain/types';
import type { CharacterRelation } from '../../providers/ai';
import type { AnalysisArtifactRepository, BulkBookSource } from '../../repositories/reader-repository';
import { throwIfReaderSearchAborted } from '../../repositories/reader-query-contract';

const ANALYSIS_PAGE_BATCH_SIZE = 4;

type AnalysisRepository = BulkBookSource &
  Pick<AnalysisArtifactRepository, 'listCharacters' | 'listCharacterRelations' | 'listCorrections'> & {
    openContentRevision?: (novelId: string) => Promise<BulkBookSource>;
  };

export async function openAnalysisParagraphSource(
  source: BulkBookSource & { openContentRevision?: (novelId: string) => Promise<BulkBookSource> },
  novelId: string,
): Promise<BulkBookSource> {
  return typeof source.openContentRevision === 'function' ? source.openContentRevision(novelId) : source;
}

export async function loadPinnedAnalysisParagraphs(
  source: BulkBookSource & { openContentRevision?: (novelId: string) => Promise<BulkBookSource> },
  novelId: string,
  chapterId: string,
  signal: AbortSignal,
): Promise<Paragraph[]> {
  return loadAnalysisParagraphs(await openAnalysisParagraphSource(source, novelId), chapterId, signal);
}

export async function loadChapterAnalysisContext(
  repository: AnalysisRepository,
  novelId: string,
  chapterId: string,
  signal: AbortSignal,
): Promise<{
  paragraphs: Paragraph[];
  knownCharacters: Character[];
  characterRelations: CharacterRelation[];
  userCorrections: UserCorrection[];
}> {
  const paragraphSource = await openAnalysisParagraphSource(repository, novelId);
  const [paragraphs, knownCharacters, characterRelations, userCorrections] = await Promise.all([
    loadAnalysisParagraphs(paragraphSource, chapterId, signal),
    repository.listCharacters(novelId),
    repository.listCharacterRelations(novelId),
    repository.listCorrections(novelId, chapterId),
  ]);
  return { paragraphs, knownCharacters, characterRelations, userCorrections };
}

export async function loadBundleAnalysisContext(
  repository: AnalysisRepository,
  novelId: string,
  chapters: readonly Chapter[],
  signal: AbortSignal,
): Promise<{
  existingCharacters: Character[];
  existingRelations: CharacterRelation[];
  userCorrections: UserCorrection[];
  chapterSources: { chapter: Chapter; paragraphs: Paragraph[] }[];
}> {
  const paragraphSource = await openAnalysisParagraphSource(repository, novelId);
  const [existingCharacters, existingRelations, userCorrections] = await Promise.all([
    repository.listCharacters(novelId),
    repository.listCharacterRelations(novelId),
    repository.listCorrections(novelId),
  ]);
  const chapterSources: { chapter: Chapter; paragraphs: Paragraph[] }[] = [];
  for (const chapter of chapters) {
    chapterSources.push({ chapter, paragraphs: await loadAnalysisParagraphs(paragraphSource, chapter.id, signal) });
  }
  return { existingCharacters, existingRelations, userCorrections, chapterSources };
}

export async function loadAnalysisParagraphs(
  source: BulkBookSource,
  chapterId: string,
  signal: AbortSignal,
): Promise<Paragraph[]> {
  const paragraphs: Paragraph[] = [];
  for await (const page of source.iterateParagraphPages({
    chapterId,
    signal,
    batchSize: ANALYSIS_PAGE_BATCH_SIZE,
  })) {
    throwIfReaderSearchAborted(signal);
    paragraphs.push(...page.paragraphs);
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
  }
  throwIfReaderSearchAborted(signal);
  return paragraphs.sort((left, right) => left.index - right.index || left.id.localeCompare(right.id));
}
