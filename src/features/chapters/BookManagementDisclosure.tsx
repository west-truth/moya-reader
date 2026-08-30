import {
  BookOpen,
  Check,
  Download,
  FileOutput,
  FilePenLine,
  FileUp,
  ListTree,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Star,
} from 'lucide-react';
import type { Novel } from '../../domain/types';
import { formatCount, formatDateTime, formatProgress } from '../../utils/format';
import type { ChaptersScreenProps } from './chapters-screen-contract';

const SOURCE_FILE_ACCEPT =
  '.txt,.md,.markdown,.epub,.pdf,.zip,.cbz,.rar,.cbr,.7z,.cb7,text/plain,application/epub+zip,application/pdf,application/zip,application/vnd.comicbook+zip,application/vnd.comicbook-rar,application/x-7z-compressed';

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function analysisStatusLabel(status: Novel['analysisStatus']): string {
  if (status === 'not_analyzed') return '꺼짐';
  if (status === 'mock_ready') return 'Mock 준비됨';
  if (status === 'queued') return '대기 중';
  if (status === 'analyzing_characters') return '인물 분석 중';
  if (status === 'labeling_segments') return '라벨링 중';
  if (status === 'building_graph') return 'Graph 구축 중';
  if (status === 'validating') return '검증 중';
  if (status === 'ready') return '라벨 준비됨';
  if (status === 'needs_review') return '검토 필요';
  if (status === 'failed') return '실패';
  if (status === 'cancelled') return '취소됨';
  return status;
}

export function BookManagementDisclosure({ model, actions }: ChaptersScreenProps) {
  const { novel } = model.book;
  const { summary } = model;
  return (
    <details className="book-management-disclosure">
      <summary>
        <span>작품 관리 및 파일 정보</span>
        <small>
          북마크 {formatCount(summary.bookmarkCount)} · 메모 {formatCount(summary.noteCount)}
        </small>
      </summary>
      <div className="book-management-body">
        <dl className="book-management-facts">
          <div>
            <dt>전체 진행률</dt>
            <dd>{formatProgress(model.book.bookProgress)}</dd>
          </div>
          <div>
            <dt>현재 위치</dt>
            <dd title={summary.readLocationLabel}>{summary.readLocationLabel}</dd>
          </div>
          <div>
            <dt>북마크</dt>
            <dd>{formatCount(summary.bookmarkCount)}개</dd>
          </div>
          <div>
            <dt>하이라이트</dt>
            <dd>{formatCount(summary.highlightCount)}개</dd>
          </div>
          <div>
            <dt>메모</dt>
            <dd>{formatCount(summary.noteCount)}개</dd>
          </div>
          <div>
            <dt>총 문단</dt>
            <dd>{formatCount(novel.totalParagraphs)}개</dd>
          </div>
          <div>
            <dt>최근 읽음</dt>
            <dd>{model.book.lastReadLabel}</dd>
          </div>
          <div>
            <dt>동기화</dt>
            <dd>{summary.syncLabel}</dd>
          </div>
          <div>
            <dt>AI 애드온</dt>
            <dd>{analysisStatusLabel(novel.analysisStatus)}</dd>
          </div>
          <div>
            <dt>원본</dt>
            <dd title={novel.sourceFileName}>{novel.sourceFileName}</dd>
          </div>
          <div>
            <dt>원본 보관</dt>
            <dd>
              {novel.sourceAssetId
                ? `${novel.sourceProvenance === 'original' ? '원본' : '재구성'} · ${formatCount(novel.sourceByteLength ?? 0)}B`
                : '보관된 원본 없음'}
            </dd>
          </div>
          <div>
            <dt>인코딩</dt>
            <dd>{novel.sourceEncoding?.toLocaleUpperCase() ?? '-'}</dd>
          </div>
          <div>
            <dt>수정일</dt>
            <dd>{formatDateTime(novel.updatedAt)}</dd>
          </div>
        </dl>
        <div className="book-management-actions">
          <button type="button" onClick={actions.navigation.openMetadata}>
            <FilePenLine size={17} /> 작품 정보 편집
          </button>
          <button
            type="button"
            onClick={model.titleEditor.editing ? actions.titleEditor.cancel : actions.titleEditor.start}
            aria-controls="book-title-editor"
            aria-expanded={model.titleEditor.editing}
          >
            <Pencil size={17} /> {model.titleEditor.editing ? '제목 수정 취소' : '제목 빠른 수정'}
          </button>
          {novel.format !== 'epub' && (
            <button type="button" onClick={actions.navigation.openStructureEditor}>
              <ListTree size={17} /> 화 구조 편집
            </button>
          )}
          <button
            type="button"
            className={classNames(novel.favorite && 'is-active')}
            onClick={() => void actions.book.toggleFavorite(novel)}
            aria-pressed={novel.favorite}
          >
            <Star size={17} fill={novel.favorite ? 'currentColor' : 'none'} />
            {novel.favorite ? '즐겨찾기 해제' : '즐겨찾기'}
          </button>
          <button type="button" onClick={() => void actions.book.exportSource(novel)} disabled={!novel.sourceAssetId}>
            <Download size={17} /> 원본 다운로드
          </button>
          <label className="source-reselect-button">
            <FileUp size={17} /> 원본 다시 선택
            <input
              type="file"
              accept={SOURCE_FILE_ACCEPT}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void actions.book.reselectSource(novel, file);
              }}
            />
          </label>
          {!novel.sourceAssetId && (
            <button type="button" onClick={() => void actions.book.reconstructSource(novel)}>
              <FileOutput size={17} /> 재구성본 만들기
            </button>
          )}
          <button type="button" onClick={actions.navigation.openSettings}>
            <SlidersHorizontal size={17} /> 읽기 설정
          </button>
          <button type="button" onClick={actions.navigation.openSync}>
            <RefreshCw size={17} /> 동기화 상세
          </button>
          <button
            type="button"
            onClick={() => void actions.book.openFirstUnreadChapter()}
            disabled={!summary.firstUnreadChapter}
          >
            <BookOpen size={17} /> 첫 미독 화
          </button>
          <button
            type="button"
            onClick={() => void actions.book.markCurrentChapterRead()}
            disabled={!summary.canMarkCurrentChapterRead}
          >
            <Check size={17} /> 현재 화 읽음
          </button>
          <button
            type="button"
            onClick={() => void actions.book.markFinished()}
            disabled={!summary.canMarkBookFinished}
          >
            <Check size={17} /> 완독 처리
          </button>
          <button
            type="button"
            onClick={() => void actions.book.resetProgress()}
            disabled={!summary.canResetBookProgress}
          >
            <RotateCcw size={17} /> 읽은 위치 초기화
          </button>
          <button type="button" aria-label="작품 관리에서 회차 추가" onClick={actions.navigation.openChapterAppend}>
            <Plus size={17} /> 회차 추가
          </button>
        </div>
      </div>
    </details>
  );
}
