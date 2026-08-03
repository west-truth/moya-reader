import { Download, List, RefreshCw, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Chapter, Novel, ReadingSessionEvent } from '../../domain/types';
import { formatCount, formatDateTime, formatProgress } from '../../utils/format';
import type { ReaderPersonalizationRepository } from '../../repositories/reader-personalization-repository';
import type { BookWorkspaceProjection } from './book-workspace-projection';
import { readingSessionsCsv, summarizeReadingSessions } from './reading-statistics';

function chapterSubtitle(chapter: Chapter): string {
  return `${chapter.index}화 · ${formatCount(chapter.characterCount)}자 · ${chapter.paragraphCount}문단`;
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours > 0) return `${hours}시간 ${minutes}분`;
  if (minutes > 0) return `${minutes}분 ${remainingSeconds}초`;
  return `${remainingSeconds}초`;
}

export interface BookWorkspaceInfoPanelProps {
  readonly novel: Novel;
  readonly chapter: Chapter;
  readonly projection: BookWorkspaceProjection;
  readonly annotationCount: number;
  readonly syncLabel: string;
  readonly returnToChapters: () => void;
  readonly openSettings: () => void;
  readonly openSync: () => void;
}

export function BookWorkspaceInfoPanel({
  novel,
  chapter,
  projection,
  annotationCount,
  syncLabel,
  returnToChapters,
  openSettings,
  openSync,
}: BookWorkspaceInfoPanelProps) {
  return (
    <div className="panel-body">
      <h3>책 정보</h3>
      <div className="book-info-panel">
        <div>
          <span>제목</span>
          <strong title={novel.title}>{novel.title}</strong>
        </div>
        <div>
          <span>현재 화</span>
          <strong title={chapter.title}>{chapterSubtitle(chapter)}</strong>
        </div>
        <div>
          <span>현재 문단</span>
          <strong>{projection.readerParagraphProgressLabel}</strong>
        </div>
        <div>
          <span>전체 진행률</span>
          <strong>{formatProgress(novel.lastReadProgress)}</strong>
        </div>
        <div>
          <span>저장 위치</span>
          <strong title={projection.readLocationLabel}>{projection.readLocationLabel}</strong>
        </div>
        <div>
          <span>화 수</span>
          <strong>{formatCount(novel.totalChapters)}화</strong>
        </div>
        <div>
          <span>문단</span>
          <strong>{formatCount(novel.totalParagraphs)}개</strong>
        </div>
        <div>
          <span>글자</span>
          <strong>{formatCount(novel.totalCharacters)}자</strong>
        </div>
        <div>
          <span>주석</span>
          <strong>{formatCount(annotationCount)}개</strong>
        </div>
        <div>
          <span>동기화</span>
          <strong>{syncLabel}</strong>
        </div>
        <div>
          <span>원본</span>
          <strong title={novel.sourceFileName}>{novel.sourceFileName}</strong>
        </div>
        <div>
          <span>인코딩</span>
          <strong>{novel.sourceEncoding?.toUpperCase() ?? '-'}</strong>
        </div>
      </div>
      <div className="panel-action-grid">
        <button className="ghost-btn" onClick={returnToChapters}>
          <List size={17} /> 화 목록
        </button>
        <button className="ghost-btn" onClick={openSettings}>
          <SlidersHorizontal size={17} /> 설정
        </button>
        <button className="ghost-btn" onClick={openSync}>
          <RefreshCw size={17} /> 동기화
        </button>
      </div>
    </div>
  );
}

export interface BookWorkspaceStatsPanelProps {
  readonly novel: Novel;
  readonly projection: BookWorkspaceProjection;
  readonly sessionSeconds: number;
  readonly progress: number;
  readonly personalizationRepository?: ReaderPersonalizationRepository;
}

function downloadStatistics(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function BookWorkspaceStatsPanel({
  novel,
  projection,
  sessionSeconds,
  progress,
  personalizationRepository,
}: BookWorkspaceStatsPanelProps) {
  const stats = projection.readingStats;
  const [scope, setScope] = useState<'book' | 'all'>('book');
  const [events, setEvents] = useState<ReadingSessionEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const loadEvents = useCallback(async () => {
    if (!personalizationRepository) return;
    setLoading(true);
    try {
      setEvents(
        await personalizationRepository.listReadingSessions(scope === 'book' ? { bookId: novel.id } : undefined),
      );
    } finally {
      setLoading(false);
    }
  }, [novel.id, personalizationRepository, scope]);
  useEffect(() => void loadEvents(), [loadEvents]);
  const recorded = useMemo(() => summarizeReadingSessions(events), [events]);
  const chartMax = Math.max(1, ...recorded.daily.map((day) => day.readingSeconds + day.listeningSeconds));

  return (
    <div className="panel-body">
      <h3>읽기 통계</h3>
      {personalizationRepository && (
        <div className="segmented full" aria-label="통계 범위">
          <button type="button" className={scope === 'book' ? 'active' : ''} onClick={() => setScope('book')}>
            이 책
          </button>
          <button type="button" className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>
            전체 책
          </button>
        </div>
      )}
      <div className="stats-grid">
        <div className="stat-card">
          <span>세션</span>
          <strong>{formatDuration(sessionSeconds)}</strong>
        </div>
        <div className="stat-card">
          <span>누적</span>
          <strong>{formatDuration(stats.totalReadingSeconds)}</strong>
        </div>
        <div className="stat-card">
          <span>현재 화</span>
          <strong>{formatProgress(progress)}</strong>
        </div>
        <div className="stat-card">
          <span>전체 글자</span>
          <strong>{formatCount(stats.chapterCharacters)}</strong>
        </div>
        <div className="stat-card">
          <span>읽은 글자</span>
          <strong>{formatCount(stats.readCharacters)}</strong>
        </div>
        <div className="stat-card">
          <span>남은 글자</span>
          <strong>{formatCount(stats.remainingCharacters)}</strong>
        </div>
        <div className="stat-card">
          <span>읽기 속도</span>
          <strong>{formatCount(stats.charactersPerMinute)}자/분</strong>
        </div>
        <div className="stat-card">
          <span>예상 남은 시간</span>
          <strong>
            {stats.estimatedRemainingSeconds === undefined ? '-' : formatDuration(stats.estimatedRemainingSeconds)}
          </strong>
        </div>
        <div className="stat-card">
          <span>최근 읽음</span>
          <strong>{novel.lastReadAt ? formatDateTime(novel.lastReadAt) : '-'}</strong>
        </div>
        {personalizationRepository && (
          <>
            <div className="stat-card">
              <span>오늘 활동</span>
              <strong>{formatDuration(recorded.todaySeconds)}</strong>
            </div>
            <div className="stat-card">
              <span>최근 7일</span>
              <strong>{formatDuration(recorded.sevenDaySeconds)}</strong>
            </div>
            <div className="stat-card">
              <span>최근 30일</span>
              <strong>{formatDuration(recorded.thirtyDaySeconds)}</strong>
            </div>
            <div className="stat-card">
              <span>기록된 독서</span>
              <strong>{formatDuration(recorded.readingSeconds)}</strong>
            </div>
            <div className="stat-card">
              <span>기록된 청취</span>
              <strong>{formatDuration(recorded.listeningSeconds)}</strong>
            </div>
          </>
        )}
      </div>
      {personalizationRepository && (
        <>
          <div className="reading-activity-chart" aria-label="최근 7일 활동 시간">
            {recorded.daily.map((day) => {
              const total = day.readingSeconds + day.listeningSeconds;
              return (
                <div key={day.date} className="reading-activity-day" title={`${day.date} · ${formatDuration(total)}`}>
                  <span style={{ height: `${Math.max(total ? 6 : 0, (total / chartMax) * 100)}%` }} />
                  <small>{new Date(`${day.date}T00:00:00`).toLocaleDateString('ko-KR', { weekday: 'short' })}</small>
                </div>
              );
            })}
          </div>
          <div className="panel-action-grid reading-stat-actions">
            <button className="ghost-btn" disabled={loading} onClick={() => void loadEvents()}>
              <RefreshCw size={16} /> 새로고침
            </button>
            <button
              className="ghost-btn"
              disabled={!events.length}
              onClick={() =>
                downloadStatistics(
                  `reading-sessions-${scope}.json`,
                  JSON.stringify(events, null, 2),
                  'application/json',
                )
              }
            >
              <Download size={16} /> JSON
            </button>
            <button
              className="ghost-btn"
              disabled={!events.length}
              onClick={() =>
                downloadStatistics(
                  `reading-sessions-${scope}.csv`,
                  readingSessionsCsv(events),
                  'text/csv;charset=utf-8',
                )
              }
            >
              <Download size={16} /> CSV
            </button>
            <button
              className="ghost-btn danger"
              disabled={!events.length}
              onClick={() => {
                if (
                  !window.confirm(
                    scope === 'book'
                      ? '이 책의 독서·청취 기록을 모두 삭제할까요?'
                      : '모든 책의 독서·청취 기록을 삭제할까요?',
                  )
                )
                  return;
                void personalizationRepository
                  .deleteReadingSessions(scope === 'book' ? { bookId: novel.id } : undefined)
                  .then(loadEvents);
              }}
            >
              <Trash2 size={16} /> 기록 삭제
            </button>
          </div>
        </>
      )}
    </div>
  );
}
