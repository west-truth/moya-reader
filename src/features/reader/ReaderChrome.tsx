import {
  BookOpen,
  BookmarkIcon,
  ChevronsLeft,
  ChevronsRight,
  ChevronLeft,
  Headphones,
  Highlighter,
  Focus,
  LocateFixed,
  Maximize2,
  Minimize2,
  Moon,
  MoreHorizontal,
  PanelRightOpen,
  RefreshCw,
  Search,
  Settings,
  SkipBack,
  SkipForward,
  StickyNote,
  Sun,
  X,
} from 'lucide-react';
import { useState } from 'react';
import type { Bookmark, ReaderHighlight } from '../../domain/types';
import { useMenuPopover } from '../../shared/ui/use-menu-popover';
import { formatCount, formatProgress } from '../../utils/format';
import type { ReaderChromeController } from './use-reader-chrome';
import type { ReaderSearchController } from './use-reader-search';
import type {
  ReaderLocationSnapshot,
  ReaderMode,
  ReaderScreenHandle,
  ReaderScreenModel,
} from './reader-screen-contract';
import type { ReaderViewportApi } from './ReaderViewport';

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function chapterSubtitle(index: number, title: string): string {
  return `${formatCount(index)}화 · ${title}`;
}

function flowLabel(settings: ReaderScreenModel['settings']): string {
  if (settings.readingProfile.flow === 'paginated') return '페이지';
  return settings.flow === 'page' ? '화면 넘김' : '스크롤';
}

function paragraphProgressLabel(model: ReaderScreenModel, location?: ReaderLocationSnapshot): string {
  const total = model.chapter.paragraphCount;
  if (total <= 0) return '0 / 0 문단';
  const fallback = Math.max(1, Math.round((location?.progress ?? 0) * total));
  return `${formatCount(location?.paragraph?.index ?? location?.paragraphIndex ?? fallback)} / ${formatCount(total)} 문단`;
}

export interface ReaderChromeProps {
  readonly model: ReaderScreenModel;
  readonly screenHandle: ReaderScreenHandle;
  readonly viewport?: ReaderViewportApi;
  readonly chrome: ReaderChromeController;
  readonly search: ReaderSearchController;
  readonly location?: ReaderLocationSnapshot;
  readonly mode: ReaderMode;
  readonly activeBookmark?: Bookmark;
  readonly activeHighlight?: ReaderHighlight;
  readonly mobileSearchOpen: boolean;
  readonly overflowOpen: boolean;
  readonly onSetMode: (mode: ReaderMode) => void;
  readonly onMobileSearchOpenChanged: (open: boolean) => void;
  readonly onOverflowOpenChanged: (open: boolean) => void;
  readonly onGoToSavedPosition: () => void;
  readonly onToggleImmersive: () => void;
}

export function ReaderChrome({
  model,
  screenHandle,
  viewport,
  chrome,
  search,
  location,
  mode,
  activeBookmark,
  activeHighlight,
  mobileSearchOpen,
  overflowOpen,
  onSetMode,
  onMobileSearchOpenChanged,
  onOverflowOpenChanged,
  onGoToSavedPosition,
  onToggleImmersive,
}: ReaderChromeProps) {
  const [bookmarkPending, setBookmarkPending] = useState(false);
  const overflowMenu = useMenuPopover(overflowOpen, onOverflowOpenChanged);
  const actions = screenHandle.getActions();
  const progress = location?.progress ?? 0;
  const nightThemeActive = model.settings.theme === 'dark' || model.settings.theme === 'midnight';
  const toggleBookmark = async () => {
    if (bookmarkPending) return;
    const currentLocation = location ?? viewport?.getLocation();
    if (!currentLocation) {
      actions.notify('읽기 위치를 확인하는 중입니다. 잠시 후 다시 시도해 주세요.', 'warning');
      return;
    }
    setBookmarkPending(true);
    try {
      await actions.toggleBookmark(currentLocation);
    } finally {
      setBookmarkPending(false);
    }
  };
  const addHighlight = () => location && actions.addHighlight(location);
  const runOverflowAction = (action: () => void) => {
    onOverflowOpenChanged(false);
    overflowMenu.triggerRef.current?.focus();
    action();
  };

  return (
    <>
      <div className="top-progress">
        <span style={{ width: `${progress * 100}%` }} />
      </div>
      <header className={classNames('reader-topbar', model.settings.keepScreenChrome && 'always-visible')}>
        <button className="icon-btn" onClick={actions.returnToChapters} title="화 목록" aria-label="화 목록으로">
          <ChevronLeft size={21} />
        </button>
        <div className="reader-title">
          <strong>{model.novel.title}</strong>
          <span>{chapterSubtitle(model.chapter.index, model.chapter.title)}</span>
        </div>
        <div className="reader-actions">
          <label className="search-box compact">
            <Search size={15} />
            <input
              ref={search.desktopInputRef}
              value={search.query}
              onChange={(event) => search.setQuery(event.target.value)}
              onKeyDown={search.handleInputKeyDown}
              placeholder="본문 검색"
              aria-label="본문 검색"
            />
          </label>
          <button
            className="icon-btn reader-mobile-search-toggle"
            type="button"
            onClick={() => onMobileSearchOpenChanged(!mobileSearchOpen)}
            title="본문 검색"
            aria-label="본문 검색 열기"
            aria-expanded={mobileSearchOpen}
          >
            <Search size={18} />
          </button>
          <button
            className={classNames('icon-btn', Boolean(activeBookmark) && 'active')}
            onClick={() => void toggleBookmark()}
            disabled={bookmarkPending}
            title={bookmarkPending ? '북마크 저장 중' : activeBookmark ? '북마크 제거' : '북마크'}
            aria-label={bookmarkPending ? '북마크 저장 중' : activeBookmark ? '북마크 제거' : '북마크 추가'}
            aria-busy={bookmarkPending}
            aria-pressed={Boolean(activeBookmark)}
          >
            <BookmarkIcon size={18} />
          </button>
          <button
            className={classNames('icon-btn', Boolean(activeHighlight) && 'active')}
            onClick={addHighlight}
            title={activeHighlight ? '현재 문단 하이라이트됨' : '하이라이트'}
            aria-label="하이라이트 토글"
            aria-pressed={Boolean(activeHighlight)}
          >
            <Highlighter size={18} />
          </button>
          <button className="icon-btn" onClick={actions.openSettings} title="읽기 설정" aria-label="읽기 설정 열기">
            <Settings size={18} />
          </button>
          <button
            className="icon-btn reader-desktop-action"
            type="button"
            onClick={onToggleImmersive}
            title="몰입 모드"
            aria-label="몰입 모드 시작"
          >
            <Focus size={18} />
          </button>
          <button className="icon-btn" onClick={actions.toggleAddon} title="부가 기능" aria-label="부가 기능 열기">
            <PanelRightOpen size={18} />
          </button>
        </div>
      </header>

      {mobileSearchOpen && (
        <div className="reader-mobile-search" role="search">
          <label className="search-box compact">
            <Search size={16} />
            <input
              ref={search.mobileInputRef}
              value={search.query}
              onChange={(event) => search.setQuery(event.target.value)}
              onKeyDown={search.handleInputKeyDown}
              placeholder="본문 검색"
              aria-label="모바일 본문 검색"
              autoFocus
            />
          </label>
          <button
            className="icon-btn"
            type="button"
            onClick={() => onMobileSearchOpenChanged(false)}
            aria-label="본문 검색 닫기"
          >
            <X size={18} />
          </button>
        </div>
      )}

      <footer className={classNames('reader-bottombar', model.settings.keepScreenChrome && 'always-visible')}>
        <button
          className="icon-btn"
          onClick={() => viewport?.pageJump(-1)}
          title={model.settings.flow === 'page' ? '이전 화면' : '위로 이동'}
          aria-label={model.settings.flow === 'page' ? '이전 화면' : '위로 이동'}
        >
          <SkipBack size={18} />
        </button>
        <span className="reader-flow-pill">{flowLabel(model.settings)}</span>
        <span className="progress-label">{formatProgress(progress)}</span>
        <input
          aria-label="읽기 진행률"
          type="range"
          min={0}
          max={1000}
          value={Math.round(progress * 1000)}
          onChange={(event) => void viewport?.scrubTo(Number(event.target.value) / 1000)}
          title={`현재 화 진행률 ${formatProgress(progress)}`}
        />
        <button
          className="icon-btn"
          onClick={() => viewport?.pageJump(1)}
          title={model.settings.flow === 'page' ? '다음 화면' : '아래로 이동'}
          aria-label={model.settings.flow === 'page' ? '다음 화면' : '아래로 이동'}
        >
          <SkipForward size={18} />
        </button>
        <span className="paragraph-progress-label">{paragraphProgressLabel(model, location)}</span>
        <div className="reader-mode-switch">
          <button className={mode === 'read' ? 'active' : ''} onClick={() => onSetMode('read')}>
            <BookOpen size={15} /> 읽기
          </button>
          <button
            className={mode === 'listen' ? 'active' : ''}
            onClick={() => actions.startTTS(location?.ttsIndex ?? 0)}
          >
            <Headphones size={15} /> 듣기
          </button>
          <button
            className={classNames('reader-notes-action', model.addonOpen && model.addonTab === 'notes' && 'active')}
            onClick={() => actions.openAddon('notes')}
          >
            <StickyNote size={15} /> 주석
          </button>
        </div>
        <div className="reader-overflow" ref={overflowMenu.rootRef}>
          <button
            ref={overflowMenu.triggerRef}
            className="icon-btn reader-overflow-toggle"
            type="button"
            onClick={() => onOverflowOpenChanged(!overflowOpen)}
            aria-label="리더 추가 메뉴"
            aria-expanded={overflowOpen}
          >
            <MoreHorizontal size={18} />
          </button>
          {overflowOpen && (
            <div
              ref={overflowMenu.menuRef}
              className="reader-overflow-menu"
              role="menu"
              aria-label="리더 추가 작업"
              onKeyDown={overflowMenu.onMenuKeyDown}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => runOverflowAction(() => void viewport?.scrollToParagraphIndex(0, 'start'))}
              >
                <ChevronsLeft size={15} /> 현재 화 처음
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!model.canRestoreSavedPosition}
                onClick={() => runOverflowAction(onGoToSavedPosition)}
              >
                <LocateFixed size={15} /> 저장 위치
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  runOverflowAction(
                    () => void viewport?.scrollToParagraphIndex(model.chapter.paragraphCount - 1, 'end'),
                  )
                }
              >
                <ChevronsRight size={15} /> 현재 화 끝
              </button>
              <button type="button" role="menuitem" onClick={() => runOverflowAction(() => actions.openAddon('notes'))}>
                <StickyNote size={15} /> 주석
              </button>
              <button type="button" role="menuitem" onClick={() => runOverflowAction(actions.openSync)}>
                <RefreshCw size={15} /> 동기화
              </button>
              <button type="button" role="menuitem" onClick={() => runOverflowAction(actions.openSettings)}>
                <Settings size={15} /> 읽기 설정
              </button>
              <button type="button" role="menuitem" onClick={() => runOverflowAction(actions.toggleNightTheme)}>
                {nightThemeActive ? <Sun size={15} /> : <Moon size={15} />} 테마
              </button>
              <button type="button" role="menuitem" onClick={() => runOverflowAction(onToggleImmersive)}>
                <Focus size={15} /> 몰입 모드
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => runOverflowAction(() => void chrome.toggleFullscreen())}
              >
                {chrome.fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />} 브라우저 전체 화면
              </button>
            </div>
          )}
        </div>
      </footer>
    </>
  );
}
