import type { Novel } from '../../domain/types';
import { hashBlobInChunks } from '../../services/import/chunked-file-reader';
import type { ImportController } from '../../services/import/import-service';
import {
  type ImportBatchCallbacks,
  type ImportBatchOutcome,
  type RunImportBatchInput,
  ImportRunCancellation,
} from './import-controller';
import { buildLocalSeriesImportFile, type LocalSeriesImportPlan } from './local-series-import';

/** Commit one release before building the next: neither upload size nor live CBZs
 * grow with the selection. A failed/cancelled release never rolls back earlier ones. */
export async function runLocalSeriesImport(
  input: Omit<RunImportBatchInput, 'files'> & {
    plan: LocalSeriesImportPlan;
    signal: AbortSignal;
    replan(novel: Novel): Promise<LocalSeriesImportPlan>;
    onCommitted(novel: Novel, releaseId: string): void;
  },
  cancellation: ImportRunCancellation,
  callbacks: ImportBatchCallbacks,
): Promise<ImportBatchOutcome> {
  cancellation.start();
  const additions = input.plan.releases.filter((release) => release.disposition === 'add');
  const outcome: ImportBatchOutcome = { completed: 0, failed: 0, skipped: input.skipped, aborted: false };
  for (const [index, release] of additions.entries()) {
    let controller: ImportController | undefined;
    const report = () =>
      callbacks.onBatchChange({
        total: additions.length,
        current: index + 1,
        completed: outcome.completed,
        failed: outcome.failed,
        skipped: outcome.skipped,
        currentFileName: release.originalName,
      });
    report();
    try {
      input.signal.throwIfAborted();
      if (cancellation.isRequested) throw new DOMException('Cancelled', 'AbortError');
      const target = outcome.lastImportedNovel ?? input.plan.targetNovel;
      const plan = target ? await input.replan((await input.getNovel(target.id)) ?? target) : input.plan;
      // Another completed attempt/device may already have supplied this release.
      if (plan.releases.find((entry) => entry.id === release.id)?.disposition !== 'add') {
        outcome.skipped += 1;
        continue;
      }
      callbacks.onProgress({
        jobId: 'local-series-build',
        status: 'writing',
        subphase: 'staging_chapters',
        bytesRead: 0,
        totalBytes: release.file.size,
        chaptersDetected: 1,
        paragraphsWritten: 0,
        message: `${index + 1}/${additions.length}화 준비 중`,
      });
      callbacks.onFileStarted?.(release.file);
      const file = await buildLocalSeriesImportFile(plan, input.signal, input.archivePassword, release.id);
      if (!file) throw new Error('추가할 회차를 확인하지 못했습니다.');
      const expectedSourceContentHash = plan.incrementalAppend
        ? await hashBlobInChunks(file, { shouldCancel: () => input.signal.aborted || cancellation.isRequested })
        : undefined;
      input.signal.throwIfAborted();
      controller = input.importService.importFile(
        {
          file,
          encoding: input.encoding,
          chapterSplitMode: input.chapterSplitMode,
          clientBookId: plan.targetNovel?.id,
          importMode: plan.incrementalAppend ? 'append_image_series' : undefined,
          baseActiveContentRevisionId: plan.incrementalAppend ? plan.targetNovel?.activeContentRevisionId : undefined,
          expectedSourceContentHash,
        },
        (progress) => {
          callbacks.onProgress(progress);
          callbacks.onFileProgress?.(release.file, progress);
        },
      );
      cancellation.bind(controller);
      const result = await controller.promise;
      outcome.lastImportedNovel = (await input.getNovel(result.novel.id).catch(() => undefined)) ?? result.novel;
      outcome.completed += 1;
      input.onCommitted(outcome.lastImportedNovel, release.id);
      await callbacks.onFileCommitted?.(release.file, outcome.lastImportedNovel);
    } catch (error) {
      if (
        input.signal.aborted ||
        cancellation.isRequested ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        outcome.aborted = true;
        callbacks.onCancelled(release.file);
      } else {
        outcome.failed += 1;
        callbacks.onFileFailed(release.file, error);
      }
      break;
    } finally {
      if (controller) cancellation.release(controller);
      report();
    }
  }
  return outcome;
}
