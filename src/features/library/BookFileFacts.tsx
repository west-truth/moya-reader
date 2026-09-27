import type { Novel } from '../../domain/types';
import { bookFormatLabel, bookUnitLabel, isFixedDocumentFormat } from '../../domain/book-format';
import { formatBytes, formatCount } from '../../utils/format';
import { formatReadingDuration } from './library-screen-model';

export function BookFileFacts({ novel, className }: { novel: Novel; className: string }) {
  const fixedDocument = isFixedDocumentFormat(novel.format);
  return (
    <dl className={className}>
      <div>
        <dt>원본 파일</dt>
        <dd title={novel.sourceFileName}>{novel.sourceFileName}</dd>
      </div>
      {novel.sourceByteLength !== undefined && (
        <div>
          <dt>원본 크기</dt>
          <dd>{formatBytes(novel.sourceByteLength)}</dd>
        </div>
      )}
      <div>
        <dt>형식</dt>
        <dd>{bookFormatLabel(novel)}</dd>
      </div>
      <div>
        <dt>{bookUnitLabel(novel)}</dt>
        <dd>{formatCount(novel.totalChapters)}개</dd>
      </div>
      {!fixedDocument && (
        <>
          <div>
            <dt>문단</dt>
            <dd>{formatCount(novel.totalParagraphs)}개</dd>
          </div>
          <div>
            <dt>분량</dt>
            <dd>{formatCount(novel.totalCharacters)}자</dd>
          </div>
        </>
      )}
      <div>
        <dt>누적 독서</dt>
        <dd>{(novel.readingSeconds ?? 0) > 0 ? formatReadingDuration(novel.readingSeconds!) : '기록 없음'}</dd>
      </div>
      {!fixedDocument && (
        <div>
          <dt>인코딩</dt>
          <dd>{novel.sourceEncoding?.toUpperCase() ?? '자동'}</dd>
        </div>
      )}
    </dl>
  );
}
