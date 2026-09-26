import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../repositories/reader-defaults';
import { DEFAULT_GESTURE_BINDINGS, DEFAULT_READING_PROFILE } from './reading-profile';
import ReaderSettingsPanel from './ReaderSettingsPanel';
import type { ReaderSettingsController } from './useReaderSettingsDraft';
import type { ExternalSourceController } from '../external-sources/useExternalSourceController';

const externalSources = { sources: [] } as unknown as ExternalSourceController;

function controller(overrides: Partial<ReaderSettingsController> = {}): ReaderSettingsController {
  return {
    open: true,
    settings: defaultSettings,
    saveStatus: 'idle',
    saveError: false,
    isDirty: false,
    closePanel: vi.fn(),
    retrySave: vi.fn(),
    updateSettings: vi.fn(),
    ...overrides,
  } as unknown as ReaderSettingsController;
}

describe('ReaderSettingsPanel', () => {
  it('renders the native reference navigation without replacing real reading controls', () => {
    const markup = renderToStaticMarkup(
      <ReaderSettingsPanel
        controller={controller()}
        profile={DEFAULT_READING_PROFILE}
        bookOverrideEnabled={false}
        contrastWarning={false}
        gestureBindings={DEFAULT_GESTURE_BINDINGS}
        platformRuntime={{ kind: 'browser', hasTauri: false, isMobileWebView: false, userAgent: 'Test browser' }}
        providerExecutionRuntime="none"
        extensions={[]}
        externalSources={externalSources}
        openSync={vi.fn()}
        openBackup={vi.fn()}
        updateProfile={vi.fn()}
        setBookOverrideEnabled={vi.fn()}
        resetProfile={vi.fn()}
        updateGestureBindings={vi.fn()}
        setExtensionEnabled={vi.fn()}
      />,
    );

    expect(markup).toContain('reader-settings-dialog');
    expect(markup).toContain('reader-settings-backdrop');
    expect(markup.match(/role="tab"/g)).toHaveLength(9);
    expect(markup).toContain('콘텐츠 소스');
    expect(markup).toContain('기능 확장');
    expect(markup).toContain('다운로드');
    expect(markup).not.toContain('id="reader-settings-tab-downloads"');
    expect(markup).toContain('id="reader-settings-tab-storage"');
    expect(markup).toContain('동기화');
    expect(markup).toContain('원격 접속');
    expect(markup).toContain('앱 테마');
    expect(markup).toContain('글자, 여백, 읽기 방식');
    expect(markup).toContain('자동 저장');
    expect(markup).toContain('미드나이트');
    expect(markup).toContain('그래파이트');
    expect(markup).toContain('웜 페이퍼');
    expect(markup).toContain('사용자 설정');
    expect(markup).not.toContain('aria-label="테마 적용 대상"');
    expect(markup).not.toContain('aria-label="본문 글꼴"');
    expect(markup).not.toContain('이 책에만 적용');
  });

  it('announces the actual draft save state and keeps book controls out of the app theme scope', () => {
    const markup = renderToStaticMarkup(
      <ReaderSettingsPanel
        controller={controller({ saveStatus: 'saving', isDirty: true })}
        profile={DEFAULT_READING_PROFILE}
        bookOverrideEnabled
        contrastWarning
        gestureBindings={DEFAULT_GESTURE_BINDINGS}
        platformRuntime={{ kind: 'browser', hasTauri: false, isMobileWebView: false, userAgent: 'Test browser' }}
        providerExecutionRuntime="server"
        extensions={[]}
        externalSources={externalSources}
        openSync={vi.fn()}
        openBackup={vi.fn()}
        updateProfile={vi.fn()}
        setBookOverrideEnabled={vi.fn()}
        resetProfile={vi.fn()}
        updateGestureBindings={vi.fn()}
        setExtensionEnabled={vi.fn()}
      />,
    );

    expect(markup).toContain('저장 중…');
    expect(markup).not.toContain('글자와 배경의 대비가 낮아');
    expect(markup).not.toContain('책 설정 초기화');
  });

  it('keeps source packages with content sources and separates feature extensions', () => {
    const common = {
      controller: controller(),
      profile: DEFAULT_READING_PROFILE,
      bookOverrideEnabled: false,
      contrastWarning: false,
      gestureBindings: DEFAULT_GESTURE_BINDINGS,
      platformRuntime: { kind: 'browser', hasTauri: false, isMobileWebView: false, userAgent: 'Test browser' } as const,
      providerExecutionRuntime: 'none' as const,
      extensions: [],
      externalSources,
      installedPackages: <div>설치된 소스 패키지</div>,
      openSync: vi.fn(),
      openBackup: vi.fn(),
      updateProfile: vi.fn(),
      setBookOverrideEnabled: vi.fn(),
      resetProfile: vi.fn(),
      updateGestureBindings: vi.fn(),
      setExtensionEnabled: vi.fn(),
    };
    const readerMarkup = renderToStaticMarkup(<ReaderSettingsPanel {...common} initialTab="layout" />);
    expect(readerMarkup).toContain('aria-label="본문 글꼴"');
    expect(readerMarkup).toContain('리더 밝기');
    const sourceMarkup = renderToStaticMarkup(<ReaderSettingsPanel {...common} initialTab="sources" />);
    const extensionMarkup = renderToStaticMarkup(<ReaderSettingsPanel {...common} initialTab="extensions" />);
    expect(sourceMarkup).toContain('설치된 소스 패키지');
    expect(extensionMarkup).not.toContain('설치된 소스 패키지');
    expect(extensionMarkup).toContain('커뮤니티 기능 확장');
    const storageMarkup = renderToStaticMarkup(<ReaderSettingsPanel {...common} initialTab="storage" />);
    const syncMarkup = renderToStaticMarkup(<ReaderSettingsPanel {...common} initialTab="sync" />);
    expect(storageMarkup).toContain('백업과 복원 열기');
    expect(storageMarkup).toContain('소스 다운로드 · 자동 정리');
    expect(syncMarkup).not.toContain('백업과 복원 열기');
    expect(syncMarkup).toContain('동기화 상태 열기');
  });
});
