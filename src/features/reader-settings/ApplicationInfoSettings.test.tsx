import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApplicationInfoSettings } from './ApplicationInfoSettings';

describe('ApplicationInfoSettings', () => {
  it('shows the current document formats, password policy and bundled archive notices', () => {
    const markup = renderToStaticMarkup(
      <ApplicationInfoSettings
        platformRuntime={{ kind: 'browser', hasTauri: false, isMobileWebView: false, userAgent: 'Test browser' }}
        providerExecutionRuntime="none"
      />,
    );

    expect(markup).toContain('TXT · EPUB');
    expect(markup).toContain('PDF');
    expect(markup).toContain('RAR · CBR');
    expect(markup).toContain('암호는 현재 열기 세션의 메모리에만 보관');
    expect(markup).toContain('7z-wasm 1.2.0');
    expect(markup).toContain('node-unrar-js 2.0.2');
    expect(markup).toContain('libarchive-wasm 1.2.0');
    expect(markup).toContain('third_party/licenses');
    expect(markup).toContain('/THIRD_PARTY_NOTICES.md');
    expect(markup).toContain('/third_party/licenses/common/LGPL-2.1.txt');
  });

  it('explains current Android playback, offline recovery and platform differences', () => {
    const markup = renderToStaticMarkup(
      <ApplicationInfoSettings
        platformRuntime={{
          kind: 'tauri-mobile',
          hasTauri: true,
          isMobileWebView: true,
          userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8)',
        }}
        providerExecutionRuntime="desktop"
      />,
    );

    expect(markup).toContain('Android 앱');
    expect(markup).toContain('기기 보안 연결 사용');
    expect(markup).toContain('백그라운드 재생 · 알림/잠금 화면 · 오디오 포커스');
    expect(markup).toContain('네이티브 캐시 · WorkManager 실패 복구');
    expect(markup).toContain('Android 문서 선택기(SAF)');
    expect(markup).toContain('웹 브라우저');
    expect(markup).toContain('데스크톱 앱');
  });
});
