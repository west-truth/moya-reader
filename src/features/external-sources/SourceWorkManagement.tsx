import { useEffect, useState } from 'react';
import { Download, FilePenLine, RotateCcw, Trash2 } from 'lucide-react';
import type { Novel } from '../../domain/types';
import type { LibraryScreenProps } from '../library/library-screen-contract';
import { BookFileFacts } from '../library/BookFileFacts';
import { formatReadingDuration } from '../library/library-screen-model';
import { sourceWorkReadingSeconds } from './source-work-reading-time';
import type { ExternalSourceController } from './useExternalSourceController';

export function SourceWorkManagement({
  novel,
  controller,
  library,
}: {
  novel?: Novel;
  controller: ExternalSourceController;
  library: LibraryScreenProps;
}) {
  const [time, setTime] = useState<{ id: string; revision: number; seconds?: number }>();
  const id = controller.workReadingSessionId;
  const revision = controller.readingHistoryRevision ?? 0;
  useEffect(() => {
    if (!id) return;
    let active = true;
    void sourceWorkReadingSeconds(id).then(
      (seconds) => {
        if (active) setTime({ id, revision, seconds });
      },
      () => {
        if (active) setTime({ id, revision });
      },
    );
    return () => {
      active = false;
    };
  }, [id, revision]);
  const seconds = time?.id === id && time?.revision === revision ? time.seconds : undefined;
  return (
    <details className="book-management-disclosure">
      <summary>
        <span>작품 관리 및 파일 정보</span>
      </summary>
      <div className="book-management-body">
        {novel ? (
          <BookFileFacts novel={novel} className="book-management-facts" />
        ) : (
          <dl className="book-management-facts">
            <div>
              <dt>원본 파일</dt>
              <dd>스트리밍 · 저장된 파일 없음</dd>
            </div>
            <div>
              <dt>전체 회차</dt>
              <dd>{controller.activeSubscription?.availableReleaseCount ?? '정보 없음'}</dd>
            </div>
          </dl>
        )}
        {id && (!novel || (seconds ?? 0) > 0) && (
          <dl className="book-management-facts">
            <div>
              <dt>{novel ? '스트리밍 독서 · 이 기기' : '누적 독서 · 이 기기'}</dt>
              <dd>
                {seconds === undefined
                  ? time?.id === id
                    ? '확인하지 못함'
                    : '확인 중…'
                  : seconds > 0
                    ? formatReadingDuration(seconds)
                    : '기록 없음'}
              </dd>
            </div>
          </dl>
        )}
        <div className="book-management-actions">
          {novel && (
            <>
              <button type="button" onClick={() => library.actions.books.editMetadata(novel)}>
                <FilePenLine size={17} /> 작품 정보 편집
              </button>
              <button
                type="button"
                disabled={!novel.sourceAssetId}
                onClick={() => void library.actions.books.downloadSource(novel)}
              >
                <Download size={17} /> 원본 다운로드
              </button>
            </>
          )}
          <button
            type="button"
            disabled={
              controller.busy || controller.importBusy || controller.blockingBusy || !controller.resetCurrentWorkHistory
            }
            onClick={() => void controller.resetCurrentWorkHistory?.()}
          >
            <RotateCcw size={17} /> 읽은 기록 초기화
          </button>
          {(novel || controller.activeSubscription) && (
            <button
              type="button"
              className="danger"
              disabled={controller.busy || controller.loading}
              onClick={async () => {
                if (novel) {
                  await library.actions.books.remove(novel);
                  controller.close();
                } else if (controller.activeSubscription)
                  void controller.removeLibraryWork(controller.activeSubscription);
              }}
            >
              <Trash2 size={17} /> 휴지통으로 이동
            </button>
          )}
        </div>
      </div>
    </details>
  );
}
