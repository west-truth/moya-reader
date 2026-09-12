import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import TTSCompactBar from '../../src/features/tts/TTSCompactBar.tsx';
import { SourceReleasePanel } from '../../src/features/external-sources/SourceReleasePanel.tsx';
import { useActiveReaderFont } from '../../src/features/reader-settings/useActiveReaderFont.ts';
import '../../src/styles/tokens.css';
import '../../src/styles/base.css';
import '../../src/styles/shell.css';
import '../../src/styles/chapters.css';
import '../../src/styles/external-sources.css';
import '../../src/styles/reader-addons.css';
import '../../src/styles/responsive.css';

const noop = () => {};
function Fixture() {
  const [fontId, setFontId] = useState('builtin-serif');
  const [current, setCurrent] = useState(114);
  const [mounted, setMounted] = useState(true);
  const [timer, setTimer] = useState();
  const [paused, setPaused] = useState(false);
  const font = useActiveReaderFont(undefined, fontId);
  globalThis.controlEvents ??= [];
  globalThis.controlsFixture = { setFontId, setCurrent, setMounted, timer };
  const items = Array.from({ length: 125 }, (_, index) => ({
    key: { connectorId: 'synthetic.source', remoteId: String(index) },
    kind: 'file',
    title: `${index + 1}화`,
    selected: false,
    release: { title: `${index + 1}화`, sourceOrder: index + 1 },
    importState: 'imported',
    importability: 'supported',
    readingState: index === current ? 'current' : 'unread',
  }));
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      'main',
      { style: { padding: 12, paddingBottom: 220 } },
      React.createElement(
        'p',
        { id: 'font-sample', style: { fontFamily: font.family, fontSize: 20 } },
        '가나다라 본문 글꼴 Abc123',
      ),
      mounted &&
        React.createElement(SourceReleasePanel, {
          items,
          controller: { activeSourceId: 'synthetic.source', breadcrumbs: [], selectAllSupported: noop },
          renderItem: (item) =>
            React.createElement(
              'article',
              {
                key: item.key.remoteId,
                'aria-current': item.readingState === 'current' ? 'location' : undefined,
                style: { padding: 12 },
              },
              item.title,
            ),
        }),
    ),
    React.createElement(TTSCompactBar, {
      bookTitle: '아주 긴 작품 제목으로 모바일 청취 설정 확인',
      chapterTitle: '115화',
      playing: true,
      paused,
      busy: false,
      rate: 1.2,
      timerPreset: timer,
      previous: () => controlEvents.push('previous'),
      next: () => controlEvents.push('next'),
      start: noop,
      pause: () => setPaused(true),
      resume: () => setPaused(false),
      stop: () => controlEvents.push('stop'),
      openSettings: () => controlEvents.push('settings'),
      setTimer,
    }),
  );
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
